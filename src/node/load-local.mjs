/**
 * Node 侧的数据加载：从磁盘读构建产物，交给 createEngine。
 *
 * 单独抽出来是因为 createEngine 现在不做 I/O——同一份检索代码要同时跑在
 * Node（CLI、本地服务）和浏览器（纯静态托管）里，
 * 两边的差别只在「数据怎么进来」：这里是 readFileSync，浏览器那边是 fetch。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEngine } from '../search/engine.mjs';

/** 项目根目录：本文件在 src/node/ 下，往上两级 */
const ROOT = join(import.meta.dirname, '..', '..');

/**
 * 读取一个 JSON 文件；缺文件时给出「该跑哪条命令」的报错，而不是一句 ENOENT。
 *
 * @param {string} relPath 相对项目根的路径
 * @returns {any}
 */
function loadJson(relPath) {
  const path = join(ROOT, relPath);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`缺少 ${relPath}，请先运行：npm run build`);
    }
    throw err;
  }
}

/**
 * 从磁盘加载数据并建好引擎。
 *
 * @param {object} [options] 透传给 createEngine 的选项
 * @returns {object} 检索器实例
 */
export function loadLocalEngine(options = {}) {
  return createEngine(
    {
      entries: loadJson(join('data', 'build', 'entries.json')),
      sections: loadJson(join('data', 'build', 'sections.json')),
      taxonomy: loadJson(join('data', 'taxonomy.json')),
      synonyms: loadJson(join('data', 'synonyms.json')),
    },
    options
  );
}

/** 项目根目录，供 CLI 与服务端拼路径用 */
export { ROOT };
