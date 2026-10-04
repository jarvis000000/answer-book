/**
 * 构建入口：把 data/source 的 Markdown 编译成检索用的结构化数据。
 *
 * 用法：node src/build/build.mjs
 *
 * 产物（都在 data/build/ 下，可随时重建，不进版本库）：
 *   entries.json   657 条打标后的完整条目
 *   sections.json  34 节元信息（节名、引言）
 *   stats.json     标签分布统计，用于人工复核打标质量
 *
 * 退出码：解析出现 warning 时仍写出产物，但退出码为 1——让 CI 和人工都能立刻注意到。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseBook } from './parse.mjs';
import { classifyAll } from './classify.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const SOURCE_DIR = join(ROOT, 'data', 'source');
const OUT_DIR = join(ROOT, 'data', 'build');

/**
 * 读取 JSON 文件；文件不存在时返回兜底值而不是抛错，
 * 让 overrides.json 这类可选文件可以缺省。
 *
 * @param {string} path 文件路径
 * @param {any} fallback 缺省值
 * @returns {any}
 */
function readJson(path, fallback) {
  try {
    const raw = readFileSync(path, 'utf8');
    const obj = JSON.parse(raw);
    // 以下划线开头的键是给人看的注释，不参与逻辑
    for (const key of Object.keys(obj)) {
      if (key.startsWith('_')) delete obj[key];
    }
    return obj;
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`读取 ${path} 失败：${err.message}`);
  }
}

/**
 * 写 JSON 产物，统一用两空格缩进并对中文不转义，便于 git diff 和人工翻阅。
 *
 * @param {string} name 文件名
 * @param {any} data 内容
 */
function writeJson(name, data) {
  writeFileSync(join(OUT_DIR, name), JSON.stringify(data, null, 2), 'utf8');
}

function main() {
  const taxonomy = readJson(join(ROOT, 'data', 'taxonomy.json'), null);
  if (!taxonomy) throw new Error('缺少 data/taxonomy.json，无法打标签');
  const overrides = readJson(join(ROOT, 'data', 'overrides.json'), {});

  const { sections, entries, warnings } = parseBook(SOURCE_DIR);
  const { entries: tagged, stats } = classifyAll(entries, taxonomy, overrides);

  mkdirSync(OUT_DIR, { recursive: true });
  writeJson('entries.json', tagged);
  writeJson('sections.json', sections);
  writeJson('stats.json', {
    builtAt: new Date().toISOString(),
    sourceCount: entries.length,
    warnings,
    ...stats,
  });

  console.log(`已解析 ${sections.length} 节 / ${entries.length} 条，warning ${warnings.length} 条`);
  console.log(`标签分布：`);
  console.log(`  年龄段    ${format(stats.ages)}`);
  console.log(`  性别      ${format(stats.gender)}`);
  console.log(`  领域      ${format(stats.domains)}`);
  console.log(`  主题 Top8 ${format(topN(stats.topics, 8))}`);
  console.log(`  人群      ${format(stats.audiences)}`);
  for (const w of warnings) console.log(`  ⚠ ${w}`);
  console.log(`产物已写入 data/build/`);

  if (warnings.length) process.exitCode = 1;
}

/** 把计数对象格式化成「标签 数量」的一行 */
function format(counter) {
  return Object.entries(counter).map(([k, v]) => `${k} ${v}`).join(' · ');
}

/** 只取计数最高的 N 项 */
function topN(counter, n) {
  return Object.fromEntries(Object.entries(counter).slice(0, n));
}

main();
