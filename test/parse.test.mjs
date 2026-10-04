/**
 * 解析器测试。
 *
 * 重点不是「跑通」，而是把源书里那些**不该随版本漂移**的事实钉住：
 * 657 条、34 节、A/B/C 分别是 431/174/52（与上游 README 徽章一致）。
 * 哪天上游改了正文，这些断言会先响，提醒我们去核对是改对了还是改错了。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { parseBook, computeRatio, parseSources } from '../src/build/parse.mjs';

const SOURCE_DIR = join(import.meta.dirname, '..', 'data', 'source');
const book = parseBook(SOURCE_DIR);

test('解析出 34 节 657 条', () => {
  assert.equal(book.sections.length, 34);
  assert.equal(book.entries.length, 657);
});

test('解析零警告', () => {
  assert.deepEqual(book.warnings, []);
});

test('证据等级分布与上游徽章一致（A 431 / B 174 / C 52）', () => {
  const dist = { A: 0, B: 0, C: 0 };
  for (const e of book.entries) dist[e.grade] = (dist[e.grade] ?? 0) + 1;
  assert.deepEqual(dist, { A: 431, B: 174, C: 52 });
});

test('每条都有完整的六个字段与出处引用', () => {
  for (const e of book.entries) {
    assert.ok(e.title.length > 0, `${e.ref} 缺标题`);
    assert.ok(e.costText.length > 0, `${e.ref} 缺成本`);
    assert.ok(e.plain.length > 0, `${e.ref} 缺说人话`);
    assert.ok(e.gain.length > 0, `${e.ref} 缺收益`);
    assert.ok(e.note.length > 0, `${e.ref} 缺备注`);
    assert.ok(e.grade, `${e.ref} 缺证据等级`);
    assert.equal(e.ref, `第 ${e.section} 节第 ${e.num} 条`);
  }
});

test('条目 ID 唯一', () => {
  const ids = new Set(book.entries.map((e) => e.id));
  assert.equal(ids.size, book.entries.length);
});

test('节内条号从 1 连续递增', () => {
  const bySection = new Map();
  for (const e of book.entries) {
    if (!bySection.has(e.section)) bySection.set(e.section, []);
    bySection.get(e.section).push(e.num);
  }
  for (const [section, nums] of bySection) {
    for (let i = 0; i < nums.length; i++) {
      assert.equal(nums[i], i + 1, `第 ${section} 节的条号不连续：${nums.join(',')}`);
    }
  }
});

test('第 26 节末尾的许可声明没有被算进条目正文', () => {
  const last = book.entries.filter((e) => e.section === 26).at(-1);
  assert.deepEqual(last.extras, []);
  assert.ok(!last.note.includes('CC BY'), '页脚被误当成备注');
});

// —— 性价比档位：规则来自上游 index.html 的 COST_W 与 e.ratio ——

test('性价比档位按上游规则合成', () => {
  // 收益大 + 成本分为 0 → 极高
  assert.equal(computeRatio({ money: '0', time: '少', will: '否', gain: '大' }), '极高');
  // 收益大 + 成本分 1 → 高
  assert.equal(computeRatio({ money: '少', time: '少', will: '否', gain: '大' }), '高');
  // 收益大 + 成本分 3 → 一般
  assert.equal(computeRatio({ money: '多', time: '中', will: '否', gain: '大' }), '一般');
  // 收益大 + 成本分 6（三项全满）→ 一般
  assert.equal(computeRatio({ money: '多', time: '多', will: '是', gain: '大' }), '一般');
  // 收益中 + 成本分为 0 → 高
  assert.equal(computeRatio({ money: '0', time: '少', will: '否', gain: '中' }), '高');
  // 收益中 + 成本分 > 0 → 一般
  assert.equal(computeRatio({ money: '少', time: '少', will: '否', gain: '中' }), '一般');
  // 收益小 → 一律一般
  assert.equal(computeRatio({ money: '0', time: '少', will: '否', gain: '小' }), '一般');
});

test('第一条「系安全带」是极高性价比', () => {
  const e = book.entries.find((x) => x.id === 'S01E001');
  assert.equal(e.title, '系安全带，前排后排都系');
  assert.equal(e.grade, 'A');
  assert.equal(e.ratio, '极高');
});

// —— 来源栏解析 ——

test('来源解析支持尖括号写法并抽得出 URL', () => {
  const out = parseSources('NHTSA (2024). Title. <https://a.example/x> ; WHO (2025). Sheet. <https://b.example/y>');
  assert.equal(out.length, 2);
  assert.equal(out[0].url, 'https://a.example/x');
  assert.equal(out[1].url, 'https://b.example/y');
});

test('来源解析支持 markdown 链接写法', () => {
  const out = parseSources('[Cochrane](https://doi.org/10.1002/x) ; 作者经验，无直接文献');
  assert.equal(out[0].url, 'https://doi.org/10.1002/x');
  assert.equal(out[0].text, 'Cochrane');
  assert.equal(out[1].url, null);
});

test('全书来源绝大多数带 URL', () => {
  const all = book.entries.flatMap((e) => e.sources);
  const withUrl = all.filter((s) => s.url);
  assert.ok(all.length > 700, `来源条目太少：${all.length}`);
  assert.ok(withUrl.length / all.length > 0.95, `带 URL 比例过低：${withUrl.length}/${all.length}`);
});
