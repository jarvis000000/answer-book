/**
 * 检索引擎门面：把「建索引 → 解析问题 → 召回 → 排序」串成一次 ask()。
 *
 * **这个模块不做任何 I/O**：数据由调用方传进来，所以同一份代码既能在 Node 里跑
 * （CLI、本地服务），也能在浏览器里跑（纯静态托管）。取数方式见：
 *   Node   → src/node/load-local.mjs（读磁盘）
 *   浏览器 → web/data-source.mjs（fetch 静态 JSON）
 * 两边用的是同一个 createEngine，排序结果逐条一致。
 */

import { tokenize } from './tokenize.mjs';
import { buildIndex, bm25 } from './index.mjs';
import { parseQuery, parseSafetyFlags, expandSynonyms } from './parse-query.mjs';
import { rank, pruneByRelevance } from './rank.mjs';
import { sortResults, SORT_MODES } from './sort.mjs';
import { isLLMConfigured, createRulePlanner, createLLMPlanner } from '../llm/adapter.mjs';

/**
 * 取用于建索引的正文文本。
 * 把标签名也拼进去：用户问「劳动仲裁」时，即使正文只写「仲裁」，
 * 标签里的完整词也能贡献一次召回机会。
 *
 * @param {object} entry 条目
 * @returns {string}
 */
function bodyOf(entry) {
  return [
    entry.sectionTitle,
    entry.plain,
    entry.gain,
    entry.costText,
    entry.note,
    entry.tags.domains.join(' '),
    entry.tags.topics.join(' '),
    entry.tags.audiences.join(' '),
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 把年龄段区间映射成年龄段名（供 parse-query 使用）。
 * 逻辑与构建期的 extractAgeBands 共用同一个判定：区间有重叠就算命中。
 *
 * @param {number} from 起始年龄
 * @param {number} to 结束年龄
 * @param {Array} bands 年龄段表
 * @returns {string[]}
 */
function bandsForRange(from, to, bands) {
  return bands.filter((b) => b.range[0] <= to && b.range[1] >= from).map((b) => b.name);
}

/** 三类需要优先给出「马上做什么」的问题，对应的提示语 */
const SAFETY_ADVICE = {
  emergency: '这看起来是正在发生的急症。先按第 13 节做现场处置，同时打 120（火警 119）。下面按相关性列出的条目只作事后参考。',
  selfHarm: '如果你现在有伤害自己的念头，请先打全国心理援助热线 12356，或者把这件事告诉身边一个人。下面第 1 节和第 29 节的条目会讲具体怎么做。',
  legalProcess: '如果法律程序已经开始（被传唤、被拘留、被起诉），下面是通用口径，个案请找律师。第 8 节有对应条目。',
};

/**
 * 创建一本可检索的答案之书。
 *
 * @param {object} data 数据包
 * @param {object[]} data.entries 已打标的条目（静态模式下可以是"精简版"，
 *                                只带检索和列表渲染需要的字段）
 * @param {object[]} data.sections 节元信息
 * @param {object} data.taxonomy taxonomy.json 内容
 * @param {object} [data.synonyms] 同义词表，缺省即不扩展
 * @param {object} [options] { lazyIndex } lazyIndex=true 时把建索引推迟到第一次检索，
 *                           让页面首屏先出来，索引在空闲时段再建
 * @returns {object} 检索器实例
 */
export function createEngine(data, options = {}) {
  const { entries, sections, taxonomy, synonyms = {} } = data;

  if (!entries?.length) throw new Error('createEngine 缺少 entries 数据');
  if (!taxonomy?.domains) throw new Error('createEngine 缺少 taxonomy 数据');

  // 静态模式下 taxonomy 也是从 JSON 读的，下划线开头的注释键要剥掉
  for (const key of Object.keys(taxonomy)) {
    if (key.startsWith('_')) delete taxonomy[key];
  }

  // 索引可以延后建：657 条约 130 ms，放在首屏渲染之后再算，用户感觉不到
  let index = null;
  const ensureIndex = () => {
    if (!index) index = buildIndex(entries, bodyOf, tokenize);
    return index;
  };
  if (!options.lazyIndex) ensureIndex();

  /** 年龄段区间映射，查表时反复要用 */
  const bandsForRangeBound = (from, to) => bandsForRange(from, to, taxonomy.ageBands.bands);

  /** 查询词在语料里的最低文档数；低于此数按跨词边界的碎片处理 */
  const MIN_DF = 3;
  const isKnownToken = (t) => (ensureIndex().postings.get(t)?.size ?? 0) >= MIN_DF;

  /** LLM 规划器，第一次调用 askAsync 时才创建；默认走规则实现 */
  let planner = null;

  /**
   * 创建规划器：配了 LLM 就用 LLM，没配就用规则。
   * 动态 import 是为了让「不接 LLM」的用户完全不加载这段代码。
   *
   * @returns {object} 规划器
   */
  function createPlanner() {
    const rule = createRulePlanner(taxonomy, tokenize, bandsForRangeBound);
    if (!isLLMConfigured()) return rule;
    return createLLMPlanner(taxonomy, rule);
  }

  /**
   * 用一份已解析好的查询执行检索并组装结果。
   * ask() 与 askAsync() 共用这一段，保证两条路径排出来的顺序完全一致。
   *
   * @param {string} question 原始问题（安全提示要拿原文判断）
   * @param {object} query 结构化查询
   * @param {object} options { limit }
   * @returns {object}
   */
  function answer(question, query, options) {
    const limit = options.limit ?? 12;
    const sort = options.sort ?? 'relevance';

    // 丢掉语料里几乎不出现的查询词。
    // 中文没有词边界，二元组切分会产出「检报」「告说」「说血」这类跨词边界的碎片；
    // 它们在全语料只出现一两次，IDF 反而最高，一命中就把无关条目顶到前面
    // （问「体检报告说血压高」时，讲「聚光灯效应」的条目靠「检报」上了榜）。
    // 判据是「真实用词一定会在语料里反复出现」。全被滤光说明这句本来就没有实词，
    // 那就保留原样，交给标签去排。
    const solid = query.tokens.filter(isKnownToken);
    if (solid.length) query.tokens = solid;

    // 再补一层同义词：上一步会连「裁员」「摔跤」这种真词一起滤掉（它们在这本书里只出现 1 次），
    // 靠人工词典换成书里的说法（辞退 / 跌倒）把召回补回来。
    // 只翻译书里不说的词——书里已有的说法再展开一次只会带进噪声。
    const extra = expandSynonyms(query.stripped ?? query.raw, synonyms, tokenize, isKnownToken);
    if (extra.length) query.tokens = [...new Set([...query.tokens, ...extra])];

    // 查询 token 为空（比如只输入了「怎么办」）时，退化成按标签浏览，
    // 而不是返回空列表——空结果比泛泛的结果更让人困惑。
    const candidates = query.tokens.length
      ? bm25(ensureIndex(), query.tokens, 300)
      : entries.map((_, docIdx) => ({ docIdx, score: 1, matched: [] }));

    // rank 不设上限：换排序方式时要在「全部相关条目」里重排，
    // 如果这里先截断，按等级排就只能在一小撮里挑，排序功能会变得名不副实。
    const ranked = pruneByRelevance(
      rank(entries, candidates, query, taxonomy, ensureIndex(), candidates.length)
    );

    const flags = parseSafetyFlags(question);
    const safetyKey = ['emergency', 'selfHarm', 'legalProcess'].find((k) => flags[k]) ?? null;

    return {
      query,
      results: sortResults(ranked, sort).slice(0, limit),
      sort,
      safety: safetyKey ? SAFETY_ADVICE[safetyKey] : null,
      totalCandidates: candidates.length,
      totalRelevant: ranked.length,
    };
  }

  const engine = {
    /** 全部条目，供 UI 做标签浏览 */
    entries,
    sections,
    taxonomy,

    /**
     * 提前把索引建好。配合 lazyIndex 用：页面先渲染出来，再在空闲时段调它，
     * 等用户真正提问时索引已经就绪，检索是瞬时的。
     *
     * @returns {{terms:number, ms:number}} 索引词条数与建索引耗时
     */
    warmup() {
      const t0 = Date.now();
      const built = ensureIndex();
      return { terms: built.postings.size, ms: Date.now() - t0 };
    },
    /** 可选的排序方式，供界面生成切换按钮，避免两边各写一份 */
    sortModes: SORT_MODES,

    /**
     * 提问（同步，纯离线）。
     *
     * @param {string} question 用户问题
     * @param {object} [options] { limit=8 }
     * @returns {{query:object, results:object[], safety:string|null, totalCandidates:number}}
     */
    ask(question, options = {}) {
      const query = parseQuery(question, taxonomy, tokenize, bandsForRangeBound);
      return answer(question, query, options);
    },

    /**
     * 提问（异步，可接 LLM 规划器）。
     *
     * 没配 LLM 时行为与 ask() 完全一致——这不是降级路径，是默认路径。
     * 配了 LLM 时，LLM 只参与「解析问题」和「给候选重排」，答案正文仍逐字来自本地数据。
     *
     * @param {string} question 用户问题
     * @param {object} [options] { limit=8, rerank=true }
     * @returns {Promise<object>} 与 ask() 同构
     */
    async askAsync(question, options = {}) {
      if (!planner) planner = createPlanner();

      const query = await planner.plan(question);
      const result = answer(question, query, options);
      result.plannedBy = planner.name;

      // 规则规划器没有重排能力，只有 LLM 规划器才走这一步
      if (planner.rerank && options.rerank !== false && result.results.length > 2) {
        result.results = await planner.rerank(question, result.results, options.limit ?? 8);
      }
      return result;
    },

    /**
     * 按标签浏览，不提问时用。
     *
     * @param {object} filter { domain, age, gender, topic, audience, grade, ratio }
     * @returns {object[]} 命中的条目
     */
    browse(filter = {}) {
      return entries.filter((e) => {
        const t = e.tags;
        if (filter.domain && !t.domains.includes(filter.domain)) return false;
        if (filter.age && !t.ages.includes(filter.age)) return false;
        if (filter.gender && t.gender !== filter.gender) return false;
        if (filter.topic && !t.topics.includes(filter.topic)) return false;
        if (filter.audience && !t.audiences.includes(filter.audience)) return false;
        if (filter.grade && e.grade !== filter.grade) return false;
        if (filter.ratio && e.ratio !== filter.ratio) return false;
        return true;
      });
    },

    /** 取某一条的完整内容，供「查看原文」用 */
    getEntry(id) {
      return entries.find((e) => e.id === id) ?? null;
    },
  };

  return engine;
}
