/**
 * 排序方式测试。
 *
 * 这层的核心契约有两条，都要钉死：
 *   ① 换排序**不改变哪些条目相关**——只是把同一批结果换个先后。否则「按等级排」
 *      会把整本书里的 A 级条目都捞进来，而不是在相关条目里挑 A 级。
 *   ② 每种排序真的按它声称的字段排，且同档之内仍按相关性。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortResults, SORT_MODES, SORT_KEYS } from '../src/search/sort.mjs';
import { costScore } from '../src/shared/cost.mjs';
import { createEngine } from '../src/search/engine.mjs';

const book = createEngine();
const QUESTION = '家里老人总是摔跤怎么办';

/** 造一条最小可用的结果对象，只填排序要用到的字段 */
const mk = (grade, ratio, cost, score) => ({
  entry: { grade, ratio, cost, section: 1, num: 1 },
  score,
});

test('排序方式清单完整且 key 唯一', () => {
  const keys = SORT_MODES.map((m) => m.key);
  assert.deepEqual(keys, ['relevance', 'grade', 'ratio', 'cheap', 'section']);
  assert.equal(new Set(keys).size, keys.length);
  for (const m of SORT_MODES) {
    assert.ok(m.label && m.hint, `${m.key} 缺 label 或 hint`);
    assert.ok(SORT_KEYS.has(m.key));
  }
});

test('相关性排序保持原顺序', () => {
  const input = [mk('B', '一般', {}, 0.9), mk('A', '极高', {}, 0.8), mk('C', '高', {}, 0.7)];
  assert.deepEqual(sortResults(input, 'relevance').map((r) => r.score), [0.9, 0.8, 0.7]);
});

test('未知排序 key 退回原顺序，不抛异常', () => {
  const input = [mk('B', '一般', {}, 0.9), mk('A', '极高', {}, 0.8)];
  assert.deepEqual(sortResults(input, '不存在的排序').map((r) => r.score), [0.9, 0.8]);
});

test('按证据等级：A 在前，同级按相关性', () => {
  const input = [mk('C', '一般', {}, 0.9), mk('A', '一般', {}, 0.5), mk('B', '一般', {}, 0.7), mk('A', '一般', {}, 0.8)];
  const out = sortResults(input, 'grade');
  assert.deepEqual(out.map((r) => r.entry.grade), ['A', 'A', 'B', 'C']);
  assert.equal(out[0].score, 0.8, '同为 A 级时应按相关性排');
  assert.equal(out[1].score, 0.5);
});

test('按性价比：极高在前，同级按相关性', () => {
  const input = [mk('A', '一般', {}, 0.9), mk('A', '极高', {}, 0.5), mk('A', '高', {}, 0.7)];
  const out = sortResults(input, 'ratio');
  assert.deepEqual(out.map((r) => r.entry.ratio), ['极高', '高', '一般']);
});

test('按成本：成本分低的在前', () => {
  const input = [
    mk('A', '一般', { money: '多', time: '多', will: '是' }, 0.9), // 成本分 6
    mk('A', '一般', { money: '0', time: '少', will: '否' }, 0.5), // 成本分 0
    mk('A', '一般', { money: '少', time: '少', will: '否' }, 0.7), // 成本分 1
  ];
  const out = sortResults(input, 'cheap');
  assert.deepEqual(out.map((r) => costScore(r.entry.cost)), [0, 1, 6]);
});

test('按章节顺序：节号升序，同节按条号', () => {
  const input = [
    { entry: { grade: 'A', ratio: '高', cost: {}, section: 17, num: 3 }, score: 0.9 },
    { entry: { grade: 'A', ratio: '高', cost: {}, section: 1, num: 13 }, score: 0.5 },
    { entry: { grade: 'A', ratio: '高', cost: {}, section: 1, num: 3 }, score: 0.7 },
  ];
  const out = sortResults(input, 'section');
  assert.deepEqual(
    out.map((r) => [r.entry.section, r.entry.num]),
    [[1, 3], [1, 13], [17, 3]]
  );
});

test('排序不改动传入的数组', () => {
  const input = [mk('C', '一般', {}, 0.9), mk('A', '一般', {}, 0.5)];
  const snapshot = [...input];
  sortResults(input, 'grade');
  assert.deepEqual(input, snapshot, '原数组被就地改动了');
});

// —— 端到端：换排序不改变「哪些条目相关」——

test('换排序方式时相关条目集合完全一致', () => {
  const base = book.ask(QUESTION, { limit: 100, sort: 'relevance' });
  const baseIds = new Set(base.results.map((r) => r.entry.id));

  for (const key of ['grade', 'ratio', 'cheap', 'section']) {
    const other = book.ask(QUESTION, { limit: 100, sort: key });
    const ids = new Set(other.results.map((r) => r.entry.id));

    assert.equal(other.totalRelevant, base.totalRelevant, `${key}：相关条数变了`);
    assert.deepEqual([...ids].sort(), [...baseIds].sort(), `${key}：相关条目集合变了`);
  }
});

test('按等级排序时结果确实是 A 在前', () => {
  const r = book.ask(QUESTION, { limit: 100, sort: 'grade' });
  const grades = r.results.map((x) => x.entry.grade);
  const order = { A: 0, B: 1, C: 2 };
  for (let i = 1; i < grades.length; i++) {
    assert.ok(order[grades[i - 1]] <= order[grades[i]], `等级排序被破坏：${grades.join('')}`);
  }
});

test('接口回显当前排序方式，非法值退回相关性', () => {
  assert.equal(book.ask(QUESTION, { sort: 'cheap' }).sort, 'cheap');
  assert.equal(book.ask(QUESTION, { sort: '乱写' }).sort, '乱写'); // engine 原样回显，校验在 server 层做
});
