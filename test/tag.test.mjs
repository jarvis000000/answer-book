/**
 * 打标签测试。
 *
 * 标签是检索质量的地基，测法分两层：
 *   ① 不变量——每条都必须满足的结构性要求（有年龄段、领域非空、性别取值合法）；
 *   ② 定向断言——挑一批「人一看就知道该打什么标」的条目钉住，
 *      防止词表改动时把某类条目的标签悄悄改坏。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const entries = JSON.parse(readFileSync(join(ROOT, 'data', 'build', 'entries.json'), 'utf8'));
const taxonomy = JSON.parse(readFileSync(join(ROOT, 'data', 'taxonomy.json'), 'utf8'));

/** 按 ID 取条目 */
const byId = (id) => entries.find((e) => e.id === id);

test('每条都有合法的标签结构', () => {
  const bandNames = new Set(taxonomy.ageBands.bands.map((b) => b.name));
  bandNames.add(taxonomy.ageBands._anyLabel); // 「全龄」不是年龄段，是「不针对特定年龄」的标记
  const domainNames = new Set(Object.keys(taxonomy.domains.list));

  for (const e of entries) {
    assert.ok(e.tags, `${e.ref} 没有 tags`);
    assert.ok(e.tags.ages.length >= 1, `${e.ref} 没有年龄段`);
    for (const a of e.tags.ages) {
      assert.ok(bandNames.has(a), `${e.ref} 出现未知年龄段：${a}`);
    }
    assert.ok(['female', 'male', 'any'].includes(e.tags.gender), `${e.ref} 性别取值非法：${e.tags.gender}`);
    assert.ok(e.tags.domains.length >= 1, `${e.ref} 没有领域`);
    for (const d of e.tags.domains) {
      assert.ok(domainNames.has(d), `${e.ref} 出现未定义领域：${d}`);
    }
    assert.ok(Array.isArray(e.tags.topics) && Array.isArray(e.tags.audiences));
  }
});

test('「全龄」不会和具体年龄段同时出现', () => {
  for (const e of entries) {
    if (e.tags.ages.includes('全龄')) {
      assert.equal(e.tags.ages.length, 1, `${e.ref} 全龄与具体年龄段并存：${e.tags.ages.join('/')}`);
    }
  }
});

// —— 性别：只认标题里点名的，不认正文里的研究人群 ——

test('女性专属条目', () => {
  assert.equal(byId('S01E017').tags.gender, 'female', '乳腺癌筛查');
  assert.equal(byId('S01E018').tags.gender, 'female', '宫颈癌筛查');
  assert.equal(byId('S27E001').tags.gender, 'female', '孕期补叶酸');
});

test('男性专属条目', () => {
  assert.equal(byId('S01E028').tags.gender, 'male', '勃起功能');
  assert.equal(byId('S01E038').tags.gender, 'male', '男男性行为者 PrEP');
});

test('正文提到研究人群不会被误判成专属条目', () => {
  // 这几条的正文里都有「女性」「男性」字样，但它们不是只给某一性别看的
  for (const id of ['S02E026', 'S03E013', 'S01E012', 'S01E031']) {
    assert.equal(byId(id).tags.gender, 'any', `${byId(id).ref} 被误判为专属条目`);
  }
});

test('女性专属条目数量在合理区间（避免词表退化后大量误标）', () => {
  const n = entries.filter((e) => e.tags.gender === 'female').length;
  assert.ok(n >= 10 && n <= 80, `女性专属条目数异常：${n}`);
});

// —— 年龄段 ——

test('标题里写明的年龄会被正确归档', () => {
  assert.ok(byId('S01E021').tags.ages.includes('中年'), '50 岁以后打带状疱疹疫苗 → 中年');
  assert.ok(byId('S01E013').tags.ages.includes('老年'), '60 岁以上练平衡 → 老年');
  assert.ok(byId('S20E001').tags.ages.includes('婴儿'), '新生儿安全睡眠 → 婴儿');
  assert.ok(byId('S01E008').tags.ages.includes('中年'), '35 岁以后查空腹血糖 → 中年');
});

test('儿童条目同时覆盖幼儿和学龄，便于按任意儿童年龄问', () => {
  const seat = byId('S01E010'); // 儿童安全座椅
  assert.ok(seat.tags.ages.includes('学龄'), `儿童安全座椅缺学龄：${seat.tags.ages.join('/')}`);
});

// —— 领域：章节默认 + 关键词补充 ——

test('章节默认领域生效', () => {
  assert.ok(byId('S13E001').tags.domains.includes('急救'), '第 13 节应带急救');
  assert.ok(byId('S15E001').tags.domains.includes('住房'), '第 15 节应带住房');
  assert.ok(byId('S14E001').tags.domains.includes('信息安全'), '第 14 节应带信息安全');
});

test('关键词能把跨节条目补到正确的领域', () => {
  const fire = entries.find((e) => e.section === 1 && e.title.includes('烟雾报警器'));
  assert.ok(fire.tags.domains.includes('安全'), `烟雾报警器应带安全：${fire.tags.domains.join('/')}`);
});

test('没有出现「人人都是法律条目」这种标签泛化', () => {
  const legal = entries.filter((e) => e.tags.domains.includes('法律')).length;
  assert.ok(legal < 220, `法律领域条目过多，词表可能泛化：${legal}`);
});

// —— 主题与人群 ——

test('主题标签命中具体诉求', () => {
  assert.ok(byId('S01E023').tags.topics.includes('癌症筛查') === false, '幽门螺杆菌不是癌症筛查');
  assert.ok(byId('S02E001').tags.topics.includes('戒烟'), '戒烟条应带戒烟主题');
  assert.ok(byId('S15E001').tags.topics.includes('租房买房'), '押金条应带租房买房主题');
});

test('人群标签命中自述场景', () => {
  assert.ok(byId('S30E003').tags.audiences.includes('家长'), '校园欺凌条应带家长');
  assert.ok(byId('S11E001').tags.audiences.includes('程序员技术人'), '第 11 节应带程序员技术人');
});

// —— 人工覆盖机制 ——

test('覆盖表能让机器结论让位于人工判断', async () => {
  const { classifyAll } = await import('../src/build/classify.mjs');
  const one = [byId('S01E001')];
  const { entries: out } = classifyAll(one, taxonomy, { S01E001: { gender: 'female' } });
  assert.equal(out[0].tags.gender, 'female');
  assert.deepEqual(out[0].overridden, ['gender']);
  // 没被覆盖的字段仍来自规则
  assert.ok(out[0].tags.domains.includes('健康'));
});
