/**
 * LLM 适配层测试。
 *
 * 这层的正确性判据不是「模型答得好不好」，而是**离线路径不被它拖累**：
 *   ① 没配环境变量时不发起任何网络请求，行为与纯规则完全一致；
 *   ② 配了但接口挂了时，自动退回规则结果，不让检索停摆；
 *   ③ 模型自造的标签（不在词表里的领域名）必须被丢弃。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRulePlanner, isLLMConfigured } from '../src/llm/adapter.mjs';
import { tokenize } from '../src/search/tokenize.mjs';
import { loadLocalEngine } from '../src/node/load-local.mjs';

const ROOT = join(import.meta.dirname, '..');
const taxonomy = JSON.parse(readFileSync(join(ROOT, 'data', 'taxonomy.json'), 'utf8'));

test('没有配置环境变量时不认为 LLM 可用', () => {
  // 测试环境里不应存在这三个变量；存在说明有人把它带进了 CI，要显式失败
  const configured = isLLMConfigured();
  assert.equal(configured, false, '测试环境不应配置 LLM 环境变量');
});

test('规则规划器产出与 parseQuery 同构的结果', async () => {
  const bandsForRange = (from, to) =>
    taxonomy.ageBands.bands.filter((b) => b.range[0] <= to && b.range[1] >= from).map((b) => b.name);

  const planner = createRulePlanner(taxonomy, tokenize, bandsForRange);
  const q = await planner.plan('我是一个45岁女性，需要注意什么健康问题');

  assert.equal(planner.name, 'rule');
  assert.deepEqual(q.ages.bands, ['中年']);
  assert.equal(q.gender, 'female');
  assert.ok(Array.isArray(q.tokens));
  assert.ok(Array.isArray(q.domains));
});

test('未配 LLM 时 askAsync 与 ask 结果完全一致', async () => {
  const book = loadLocalEngine();
  const questions = ['幽门螺杆菌要不要查', '孩子被同学欺负了怎么办', '被公司裁员了能拿多少钱'];

  for (const q of questions) {
    const sync = book.ask(q, { limit: 5 });
    const asy = await book.askAsync(q, { limit: 5 });

    assert.equal(asy.plannedBy, 'rule');
    assert.deepEqual(
      asy.results.map((r) => r.entry.id),
      sync.results.map((r) => r.entry.id),
      `「${q}」两条路径顺序不一致`
    );
  }
});

test('接口不可达时退回规则结果，不抛异常', async () => {
  // 指向一个必定连不上的端口，验证兜底分支而不是正常分支
  process.env.ANSWER_BOOK_LLM_BASE = 'http://127.0.0.1:1/v1';
  process.env.ANSWER_BOOK_LLM_MODEL = 'nonexistent';

  const book = loadLocalEngine();
  const r = await book.askAsync('租房押金不退怎么办', { limit: 3 });

  assert.ok(r.results.length > 0, 'LLM 挂掉后应该仍有规则结果');
  assert.match(r.results[0].entry.ref, /^第 \d+ 节第 \d+ 条$/);

  delete process.env.ANSWER_BOOK_LLM_BASE;
  delete process.env.ANSWER_BOOK_LLM_MODEL;
});

test('答案正文只来自本地数据，不因接 LLM 而被改写', async () => {
  const book = loadLocalEngine();
  const r = await book.askAsync('戒烟有什么办法', { limit: 3 });

  const known = new Set(book.entries.map((e) => e.id));
  for (const x of r.results) {
    assert.ok(known.has(x.entry.id), `结果里出现了本地数据之外的条目：${x.entry.id}`);
  }
});
