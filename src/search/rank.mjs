/**
 * 排序：把 BM25 关键词分和标签匹配分合成最终相关性。
 *
 * 权重取舍（0.55 关键词 + 0.45 标签）的理由：
 *   关键词管「这条讲的是不是这件事」，标签管「这条是不是讲给我的」。
 *   只靠关键词，问「6 岁儿童」会推出一堆成年人条目里的「儿童」二字；
 *   只靠标签，问「血压高怎么办」会被领域标签带偏到整个「健康」大类。
 *   两者各占一半上下，标签略低是因为规则打标必然有噪声，而关键词是原文字符，可信度更高。
 *
 * 证据等级和性价比档只做 5% 以内的微调、且只在同分附近起作用——
 * 它们是「这条有多可信」，不是「这条有多相关」，不能反客为主。
 */

import { STOPWORDS } from './tokenize.mjs';
import { idfOf } from './index.mjs';

/**
 * 标签分内部各维度的权重，加起来为 1。
 * 年龄和性别合计占 0.58——因为本书是按「谁该做什么」组织的，
 * 「这条是不是写给我的」比「这条属于哪个大类」更能决定该不该排前面。
 */
const TAG_WEIGHTS = {
  domains: 0.28,
  ages: 0.30,
  gender: 0.20,
  topics: 0.12,
  audiences: 0.10,
};

/**
 * 关键词权重随「查询信息量」浮动：
 *   查询里出现了罕见词（「幽门螺杆菌」「竞业限制」）→ 关键词说了算，占 0.70
 *   查询全是常见词（「我该注意什么」）→ 关键词几乎不区分度，降回 0.35，让标签主导
 * 阈值 1.5 / 6.0 是按本语料的 IDF 分布取的经验值（常见词约 1.1，罕见词 4 以上）。
 */
const W_KEYWORD_MIN = 0.35;
const W_KEYWORD_MAX = 0.70;
const IDF_LOW = 1.5;
const IDF_HIGH = 6.0;

/** 性别不匹配时的惩罚系数：不丢弃（内容可能仍然相关），但压到候选末尾 */
const GENDER_MISMATCH_PENALTY = 0.05;

/** 提问者自报的身份（年龄段 + 性别）被条目同时命中时的加成 */
const PERSONA_BONUS = 1.12;

/**
 * 计算这条查询带来了多少可区分的信息，落在 0 到 1。
 *
 * @param {string[]} tokens 查询 token
 * @param {object} index 索引
 * @returns {number} 0 = 全是常见词，1 = 含罕见词
 */
function queryInformativeness(tokens, index) {
  if (!tokens.length) return 0;
  const maxIdf = Math.max(...tokens.map((t) => idfOf(index, t)));
  const raw = (maxIdf - IDF_LOW) / (IDF_HIGH - IDF_LOW);
  return Math.min(1, Math.max(0, raw));
}

/** 年龄段之间相隔几档时，相似度还剩多少 */
const AGE_SIMILARITY = [1.0, 0.55, 0.2]; // 相隔 0 / 1 / 2 档

/** 证据等级调节系数 */
const GRADE_FACTOR = { A: 1.0, B: 0.95, C: 0.9, null: 0.92 };

/** 性价比档调节系数 */
const RATIO_FACTOR = { 极高: 1.0, 高: 0.98, 一般: 0.95 };

/**
 * 计算两个年龄段列表的相似度，取所有配对里的最大值。
 *
 * @param {string[]} queryBands 提问者的年龄段
 * @param {string[]} entryBands 条目的年龄段
 * @param {Map<string, number>} orderOf 年龄段名 → 序号
 * @param {string} anyLabel 「全龄」的写法
 * @returns {number} 0 到 1
 */
function ageSimilarity(queryBands, entryBands, orderOf, anyLabel) {
  if (!queryBands.length) return 0.4; // 没提到年龄，给个中性值，不偏袒任何一段
  if (!entryBands.length) return 0.4;
  if (entryBands.includes(anyLabel)) return 0.3; // 通用建议：能答上，但不如针对该年龄段的贴

  let best = 0;
  for (const q of queryBands) {
    for (const e of entryBands) {
      const a = orderOf.get(q);
      const b = orderOf.get(e);
      if (a === undefined || b === undefined) continue;
      const dist = Math.abs(a - b);
      const sim = AGE_SIMILARITY[dist] ?? 0;
      if (sim > best) best = sim;
    }
  }
  return best;
}

/**
 * 计算标签匹配分与可读的解释。
 *
 * @param {object} entry 条目
 * @param {object} query parseQuery 的结果
 * @param {Map<string, number>} orderOf 年龄段序号表
 * @param {string} anyLabel 「全龄」
 * @returns {{score:number, reasons:string[], genderMismatch:boolean}}
 */
function tagScore(entry, query, orderOf, anyLabel) {
  const t = entry.tags;
  const reasons = [];

  // —— 领域 ——
  // 命中任一领域就给 0.7 底分，再按命中比例补到 1。
  // 用比例直接当分数会让「问两个领域、只中一个」的条目只有 0.5，
  // 反而不如「问一个领域、全中」的条目——但对提问者来说这两者价值接近。
  let domainSim = 0;
  if (query.domains.length) {
    const hit = query.domains.filter((d) => t.domains.includes(d));
    domainSim = hit.length ? 0.7 + 0.3 * (hit.length / query.domains.length) : 0;
    if (hit.length) reasons.push(`领域命中：${hit.join('、')}`);
  } else {
    domainSim = 0.5; // 提问没点领域，中性处理
  }

  // —— 年龄 ——
  const ageSim = ageSimilarity(query.ages.bands, t.ages, orderOf, anyLabel);
  if (query.ages.bands.length && ageSim >= 0.55) {
    reasons.push(`年龄段贴合：${t.ages.filter((a) => a !== anyLabel).join('、') || anyLabel}`);
  }

  // —— 性别 ——
  let genderSim = 1;
  let genderMismatch = false;
  if (query.gender === 'any' || t.gender === 'any') {
    genderSim = query.gender === 'any' ? 0.8 : 0.7; // 条目通用 / 提问没说是谁，都给部分分
  } else if (query.gender === t.gender) {
    genderSim = 1;
    reasons.push(t.gender === 'female' ? '女性专属条目' : '男性专属条目');
  } else {
    genderSim = 0;
    genderMismatch = true;
  }

  // —— 主题：比领域细一层，用来把「摔跤」这类具体诉求对到「跌倒与骨折」组 ——
  let topicSim = 0;
  if (query.topics.length) {
    const hit = query.topics.filter((x) => t.topics.includes(x));
    topicSim = hit.length ? 0.7 + 0.3 * (hit.length / query.topics.length) : 0;
    if (hit.length) reasons.push(`主题命中：${hit.join('、')}`);
  }

  // —— 人群 ——
  let audienceSim = 0;
  if (query.audiences.length) {
    const hit = query.audiences.filter((a) => t.audiences.includes(a));
    audienceSim = hit.length / query.audiences.length;
    if (hit.length) reasons.push(`人群命中：${hit.join('、')}`);
  }

  const score =
    domainSim * TAG_WEIGHTS.domains +
    ageSim * TAG_WEIGHTS.ages +
    genderSim * TAG_WEIGHTS.gender +
    topicSim * TAG_WEIGHTS.topics +
    audienceSim * TAG_WEIGHTS.audiences;

  return { score, reasons, genderMismatch };
}

/**
 * 对 BM25 候选做最终排序。
 *
 * @param {object[]} entries 全部条目
 * @param {{docIdx:number, score:number, matched:string[]}[]} candidates BM25 候选
 * @param {object} query 结构化查询
 * @param {object} taxonomy taxonomy.json
 * @param {object} index buildIndex 的产物（用来算查询词的信息量）
 * @param {number} [limit] 返回条数
 * @returns {object[]} 排序后的结果，带 score / reasons / matched
 */
export function rank(entries, candidates, query, taxonomy, index, limit = 10) {
  const orderOf = new Map(taxonomy.ageBands.bands.map((b, i) => [b.name, b.order ?? i]));
  const anyLabel = taxonomy.ageBands._anyLabel ?? '全龄';

  const maxBm25 = candidates.reduce((m, c) => Math.max(m, c.score), 0) || 1;

  // 查询越泛，越依赖标签；越具体，越依赖关键词
  const informativeness = queryInformativeness(query.tokens, index);
  const wKeyword = W_KEYWORD_MIN + (W_KEYWORD_MAX - W_KEYWORD_MIN) * informativeness;
  const wTag = 1 - wKeyword;

  // 提问者自报的身份条件（年龄、性别），用于给「正对你」的条目加成
  const declaredAge = query.ages.bands.length > 0;
  const declaredGender = query.gender !== 'any';

  const scored = candidates.map((c) => {
    const entry = entries[c.docIdx];
    // 压缩式归一化：raw/(raw+max) 的两倍。直接把 raw 除以 max 是线性的，
    // 会让那个「碰巧多命中一个词」的条目独自拿到 1.00，把别的条目压到 0.6 以下；
    // 而中文短查询里多命中一个词往往只是运气。压缩后高分条目彼此靠拢，
    // 名次改由标签分决定——这才是「按标签找答案」应有的手感。
    const keywordNorm = maxBm25 > 0 ? (2 * c.score) / (c.score + maxBm25) : 0;
    const tag = tagScore(entry, query, orderOf, anyLabel);

    let total = keywordNorm * wKeyword + tag.score * wTag;
    total *= GRADE_FACTOR[entry.grade] ?? 0.92;
    total *= RATIO_FACTOR[entry.ratio] ?? 0.95;
    if (tag.genderMismatch) total *= GENDER_MISMATCH_PENALTY;

    // 身份双中：提问者说了自己是谁，这条正好是写给他的
    if (declaredGender && declaredAge && !tag.genderMismatch) {
      const genderExact = entry.tags.gender === query.gender;
      const ageExact = query.ages.bands.some((b) => entry.tags.ages.includes(b));
      if (genderExact && ageExact) total *= PERSONA_BONUS;
    }

    const reasons = [...tag.reasons];
    if (c.matched.length) {
      const uniq = [...new Set(c.matched)].slice(0, 5);
      reasons.push(`关键词命中：${uniq.join('、')}`);
    }

    return {
      entry,
      score: total,
      keywordScore: keywordNorm,
      tagScore: tag.score,
      reasons,
      genderMismatch: tag.genderMismatch,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * 相对阈值：只保留分数在最高分这个比例以上的条目。
 *
 * 为什么不用绝对阈值：标签分有一个约 0.25 的地板——任何一条就算领域、年龄、性别
 * 全不匹配，也能从「性别不限」和「年龄段不限」拿到分。绝对阈值一低，条条都能过，
 * 「相关」就退化成「几乎全部」（实测问「幽门螺杆菌」时有 294 条被判为相关，等于没筛）；
 * 一高，又会把没写领域的查询整片砍掉。
 *
 * 改成跟着每条查询自己的分数尺度走就稳了。实测下来 0.55 这个比例正好卡在
 * 「具体问题只留三五条真正对得上的，泛问题留三四十条供翻」的位置。
 */
const RELEVANCE_RATIO = 0.55;

/** 无论怎么裁，至少留这么多条——宁可多给几条，也别让用户面对空页面 */
const MIN_KEEP = 6;

/**
 * 过滤掉只是陪着排上来的候选，只留下真正相关的。
 *
 * @param {object[]} ranked rank 的产物（已按分数降序）
 * @returns {object[]}
 */
export function pruneByRelevance(ranked) {
  if (!ranked.length) return ranked;

  const cutoff = ranked[0].score * RELEVANCE_RATIO;
  const keep = ranked.filter((r) => r.score >= cutoff);

  return keep.length >= MIN_KEEP ? keep : ranked.slice(0, MIN_KEEP);
}

export { STOPWORDS };
