/**
 * 静态托管模式的数据源（**只在 `npm run build:static` 的产物里生效**）。
 *
 * 本地跑 `npm run serve` 时，index.html 不会加载这个文件——那条路径走的是
 * /api/ask 由 Node 服务端算。这里负责的是另一半：没有服务端时，
 * 把检索代码和 JSON 拉进浏览器自己算。
 *
 * 结果是两条路径**用同一个 createEngine、同一份数据**，所以排序逐条一致
 * （构建期有自检脚本盯着这件事，见 src/build/build-static.mjs）。
 *
 * 加载分两段：
 *   ① 打开页面：拉条目 + 词表 + 元信息，建引擎（索引延后建，约 130 ms）
 *   ② 页面空闲：把索引建好，用户真正提问时是瞬时的
 */

import { createEngine } from './vendor/search/engine.mjs';
import { toAskPayload, buildMeta } from './vendor/shared/client-payload.mjs';
import { SORT_KEYS } from './vendor/search/sort.mjs';

/**
 * 取一个 JSON 文件。路径相对当前页面，这样部署在 GitHub Pages 的
 * /<仓库名>/ 子路径下也能正确解析（用 /data/… 就会跑到域名根目录去）。
 *
 * @param {string} rel 相对页面的路径
 * @returns {Promise<any>}
 */
async function getJson(rel) {
  const res = await fetch(new URL(rel, document.baseURI));
  if (!res.ok) throw new Error(`加载 ${rel} 失败（HTTP ${res.status}）`);
  return res.json();
}

let engine = null;
let meta = null;

/** 引擎就绪的 Promise，app.js 会 await 它 */
const ready = (async () => {
  const [entries, taxonomy, synonyms, sections, metaJson] = await Promise.all([
    getJson('data/entries.json'),
    getJson('data/taxonomy.json'),
    getJson('data/synonyms.json'),
    getJson('data/sections.json'),
    getJson('data/meta.json'),
  ]);

  meta = metaJson;
  // lazyIndex：先让首屏渲染出来，索引等空闲时再建
  engine = createEngine({ entries, sections, taxonomy, synonyms }, { lazyIndex: true });
  return engine;
})();

/** 建索引只做一次；重复调用直接复用 */
let warmed = false;

window.AnswerBookData = {
  mode: 'static',

  /** 引擎就绪的 Promise */
  ready,

  /**
   * 元信息（标签取值、排序方式）。服务端模式下由 /api/meta 提供，两者结构一致。
   *
   * @returns {Promise<object>}
   */
  async meta() {
    await ready;
    return meta ?? buildMeta(engine);
  },

  /**
   * 提问。返回结构与服务端 /api/ask 完全一致，
   * 所以 app.js 不需要知道自己在跟谁说话。
   *
   * @param {string} question 用户问题
   * @param {object} options { limit, sort }
   * @returns {Promise<object>} 响应体
   */
  async ask(question, options = {}) {
    await ready;

    const limit = Math.min(Math.max(Number(options.limit) || 12, 1), 100);
    const sort = SORT_KEYS.has(options.sort) ? options.sort : 'relevance';

    const result = engine.ask(question, { limit, sort });
    return { question, ...toAskPayload(result) };
  },

  /**
   * 提前把索引建好。app.js 会在首屏渲染完、浏览器空闲时调它。
   *
   * @returns {Promise<{terms:number, ms:number}>}
   */
  async warmup() {
    await ready;
    if (!warmed) {
      warmed = true;
      const stat = engine.warmup();
      // 留在 console 里，排查「第一次搜索为什么慢」时有据可查
      console.info(`[答案之书] 索引已建好：${stat.terms} 个词条，用时 ${stat.ms} ms`);
      return stat;
    }
    return { terms: 0, ms: 0 };
  },
};
