/**
 * 检索层测试：切分、查询解析、排序。
 *
 * 这里只测「行为契约」——给定输入必须产出什么形状的输出，
 * 以及几条必须排到前面的典型查询。整体命中率交给 test/eval.mjs 的评测集。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, stripQueryPhrases, isFunctionOnly } from '../src/search/tokenize.mjs';
import { cnToNumber } from '../src/search/parse-query.mjs';
import { loadLocalEngine } from '../src/node/load-local.mjs';

const book = loadLocalEngine();

// —— 切分 ——

test('中文按二元组切分', () => {
  assert.deepEqual(tokenize('安全带'), ['安全', '全带', '安全带']);
  assert.deepEqual(tokenize('血压'), ['血压']);
});

test('拉丁词和数字整体保留并转小写', () => {
  assert.ok(tokenize('HPV 疫苗').includes('hpv'));
  assert.ok(tokenize('打 120').includes('120'));
});

test('停用词被滤掉', () => {
  const tokens = tokenize('我的问题是这个');
  assert.ok(!tokens.includes('我的'));
  assert.ok(!tokens.includes('这个'));
});

test('提问套话被整段删掉', () => {
  const stripped = stripQueryPhrases('我是一个45岁女性，我需要注意哪些身体健康方面的问题');
  assert.ok(!stripped.includes('我是一个'));
  assert.ok(!stripped.includes('方面的问题'));
  assert.ok(stripped.includes('身体健康'));
});

test('纯功能字残片会被识别', () => {
  assert.equal(isFunctionOnly('我要做'), true);
  assert.equal(isFunctionOnly('要做'), true);
  assert.equal(isFunctionOnly('血压'), false);
  assert.equal(isFunctionOnly('体检'), false);
});

// —— 中文数字 ——

test('中文数字转换', () => {
  assert.equal(cnToNumber('六'), 6);
  assert.equal(cnToNumber('十'), 10);
  assert.equal(cnToNumber('十五'), 15);
  assert.equal(cnToNumber('四十五'), 45);
  assert.equal(cnToNumber('一百二十'), 120);
  assert.equal(cnToNumber('乱写'), null);
});

// —— 查询解析 ——

test('阿拉伯数字年龄解析成年龄段', () => {
  const r = book.ask('我是一个45岁女性，需要注意什么健康问题').query;
  assert.equal(r.ages.value, 45);
  assert.deepEqual(r.ages.bands, ['中年']);
  assert.equal(r.gender, 'female');
});

test('中文数字年龄也能解析', () => {
  const r = book.ask('六岁孩子要注意什么').query;
  assert.equal(r.ages.value, 6);
  assert.deepEqual(r.ages.bands, ['学龄']);
  // 写了具体年龄就只认年龄，「孩子」这个词不再额外撑大范围
  assert.equal(r.ages.inferredFrom, undefined);
});

test('称呼词也能推断年龄段', () => {
  const r = book.ask('家里老人总是摔跤怎么办').query;
  assert.deepEqual(r.ages.bands, ['老年']);
});

test('年级换算成年龄', () => {
  const r = book.ask('三年级的孩子近视了').query;
  assert.equal(r.ages.value, 8);
  assert.deepEqual(r.ages.bands, ['学龄']);
});

test('月龄归到婴儿', () => {
  const r = book.ask('8个月的宝宝发烧怎么办').query;
  assert.deepEqual(r.ages.bands, ['婴儿']);
});

test('性别只认自述和亲属称呼', () => {
  assert.equal(book.ask('我是男性，前列腺检查要做吗').query.gender, 'male');
  assert.equal(book.ask('我是孕妇，能吃这个药吗').query.gender, 'female');
  assert.equal(book.ask('HPV 疫苗要不要打').query.gender, 'any');
});

test('领域从提问侧提示词识别', () => {
  assert.ok(book.ask('我想戒烟有什么办法').query.domains.includes('健康'));
  assert.ok(book.ask('租房押金不退怎么办').query.domains.includes('住房'));
  assert.ok(book.ask('被公司裁员了能拿多少钱').query.domains.includes('职业'));
});

test('年龄数字不会留成关键词', () => {
  const r = book.ask('45岁的人要注意什么').query;
  assert.ok(!r.tokens.includes('45'), '年龄数字应已转成年龄段，不该再当关键词');
});

test('需求安全提示的三类问题会被识别', () => {
  assert.equal(book.ask('有人倒地没呼吸了怎么办').safety !== null, true);
  assert.equal(book.ask('我不想活了').safety !== null, true);
  assert.equal(book.ask('我被拘留了该怎么办').safety !== null, true);
  assert.equal(book.ask('孩子近视了怎么办').safety, null);
});

// —— 排序：典型查询必须把对的条目排进前三 ——

/**
 * 断言某个查询的前三条里有标题包含指定片段的条目。
 *
 * @param {string} q 问题
 * @param {string[]} fragments 期望的标题片段
 */
function expectTop3(q, fragments) {
  const r = book.ask(q, { limit: 3 });
  const titles = r.results.map((x) => x.entry.title);
  const ok = titles.some((t) => fragments.some((f) => t.includes(f)));
  assert.ok(ok, `「${q}」前三名不含 ${fragments.join('/')}，实际是：\n  ${titles.join('\n  ')}`);
}

test('样例问题：45 岁女性的健康问题', () => {
  expectTop3('我是一个45岁女性，我需要注意哪些身体健康方面的问题', ['乳腺癌筛查', '宫颈癌筛查']);
});

test('样例问题：6 岁儿童的建议', () => {
  expectTop3('一个6岁儿童有哪些建议和指南', ['窝沟封闭', '儿童近水', '恒磨牙']);
});

test('裁员补偿', () => {
  expectTop3('被公司裁员了我能拿多少钱', ['被裁先算清', '辞退你没提前']);
});

test('戒烟', () => {
  expectTop3('我想戒烟有什么办法', ['戒烟']);
});

test('幽门螺杆菌', () => {
  expectTop3('幽门螺杆菌要不要查', ['幽门螺杆菌']);
});

test('租房押金', () => {
  expectTop3('租房押金不退怎么办', ['押金']);
});

test('电动车楼道充电', () => {
  expectTop3('电动车能不能推进楼道充电', ['不推进楼道']);
});

test('工伤认定', () => {
  expectTop3('工伤怎么认定', ['工伤']);
});

test('同义词把书里不说的词换成书里的说法', () => {
  // 「摔跤」在全语料只出现 1 次，靠 data/synonyms.json 换成「跌倒」才能召回
  expectTop3('家里老人总是摔跤怎么办', ['练平衡', '跌倒']);
});

// —— 按标签浏览 ——

test('按领域浏览', () => {
  const hits = book.browse({ domain: '残疾' });
  assert.ok(hits.length > 0);
  for (const e of hits) assert.ok(e.tags.domains.includes('残疾'));
});

test('按年龄段浏览', () => {
  const hits = book.browse({ age: '老年' });
  assert.ok(hits.length > 10);
  for (const e of hits) assert.ok(e.tags.ages.includes('老年'));
});

test('组合条件求交集', () => {
  const hits = book.browse({ grade: 'A', ratio: '极高' });
  for (const e of hits) {
    assert.equal(e.grade, 'A');
    assert.equal(e.ratio, '极高');
  }
});

// —— 结果结构 ——

test('每条结果都带得出处、标签和排序理由', () => {
  const r = book.ask('孩子发烧怎么办', { limit: 5 });
  assert.ok(r.results.length > 0);
  for (const x of r.results) {
    assert.match(x.entry.ref, /^第 \d+ 节第 \d+ 条$/);
    assert.ok(x.entry.tags.ages.length > 0);
    assert.ok(Array.isArray(x.reasons));
    assert.ok(x.score > 0);
  }
});

test('结果按分数降序', () => {
  const r = book.ask('怎么戒烟', { limit: 10 });
  for (let i = 1; i < r.results.length; i++) {
    assert.ok(r.results[i - 1].score >= r.results[i].score, '结果未按分数降序');
  }
});

test('查不到的冷僻问题返回空列表而不是报错', () => {
  const r = book.ask('量子计算机的纠错码怎么实现');
  assert.ok(Array.isArray(r.results));
});

test('问句没有实词时退化为按标签浏览而不是返回空', () => {
  const r = book.ask('怎么办');
  assert.ok(r.results.length > 0, '空查询不应返回空结果');
});
