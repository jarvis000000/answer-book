/**
 * 倒排索引 + BM25 打分（零依赖）。
 *
 * BM25 是短文本检索里最稳的经典算法：一个词在一篇文档里出现得越多、在整个语料里越罕见，
 * 它对这篇文档的相关性贡献就越大，同时用文档长度做归一化，避免长条目靠堆字占便宜。
 *
 * 字段加权：标题命中按 3 倍计入词频。作者的标题是动词开头的一句话建议，
 * 一句话概括了整条，比正文里顺带提到的词更能代表这条讲什么。
 */

/** BM25 参数：k1 控制词频饱和速度，b 控制长度归一化强度，取值是文献常用默认值 */
const K1 = 1.2;
const B = 0.75;

/** 标题词频相对正文的倍数 */
const TITLE_WEIGHT = 3;

/**
 * 构建索引。
 *
 * @param {object[]} entries 已打标的条目（需要 id / title / 正文各字段）
 * @param {(entry:object)=>string} bodyOf 取正文文本的函数
 * @param {(text:string)=>string[]} tokenizeFn 切分函数
 * @returns {object} 索引对象
 */
export function buildIndex(entries, bodyOf, tokenizeFn) {
  const postings = new Map(); // token → Map<docIdx, weightedTf>
  const docLen = new Float64Array(entries.length);

  entries.forEach((entry, docIdx) => {
    const titleTokens = tokenizeFn(entry.title);
    const bodyTokens = tokenizeFn(bodyOf(entry));

    /** 把一批 token 按权重累加到该文档的词频表里 */
    const acc = new Map();
    const add = (tokens, weight) => {
      for (const t of tokens) acc.set(t, (acc.get(t) ?? 0) + weight);
    };
    add(titleTokens, TITLE_WEIGHT);
    add(bodyTokens, 1);

    let len = 0;
    for (const [token, tf] of acc) {
      if (!postings.has(token)) postings.set(token, new Map());
      postings.get(token).set(docIdx, tf);
      len += tf;
    }
    docLen[docIdx] = len;
  });

  const totalLen = docLen.reduce((a, b) => a + b, 0);

  return {
    entries,
    postings,
    docLen,
    avgdl: entries.length ? totalLen / entries.length : 0,
    size: entries.length,
  };
}

/**
 * 取某个词在语料里的 IDF。
 * 用来衡量「查询里最罕见的那个词有多罕见」——也就是这条查询到底带了
 * 多少可区分的信息。问「幽门螺杆菌怎么查」和问「我该注意什么」，
 * 前者该按关键词排，后者该按标签排，靠这个值来自动决定。
 *
 * @param {object} index buildIndex 的产物
 * @param {string} token 词
 * @returns {number} IDF；词不在语料里时返回 0
 */
export function idfOf(index, token) {
  const posting = index.postings.get(token);
  if (!posting || !index.size) return 0;
  return Math.log(1 + (index.size - posting.size + 0.5) / (posting.size + 0.5));
}

/**
 * 对查询做 BM25 打分，返回按分数降序的候选。
 *
 * 没有命中任何 token 的文档不会出现在结果里——所以调用方要保证查询 token 不为空，
 * 否则应改走「按标签浏览」这条路，而不是返回空列表。
 *
 * @param {object} index buildIndex 的产物
 * @param {string[]} queryTokens 查询 token（可重复，重复即视为更高权重）
 * @param {number} [limit] 最多返回多少条，默认 200
 * @returns {{docIdx:number, score:number, matched:string[]}[]}
 */
export function bm25(index, queryTokens, limit = 200) {
  const { postings, docLen, avgdl, size } = index;
  if (!size || !avgdl) return [];

  // 查询词去重后按出现次数加权：查询里重复写两遍的词应当更重
  const qtf = new Map();
  for (const t of queryTokens) qtf.set(t, (qtf.get(t) ?? 0) + 1);

  const scores = new Float64Array(size);
  const matchedWords = new Map(); // docIdx → 命中的查询词

  for (const [token, weight] of qtf) {
    const posting = postings.get(token);
    if (!posting) continue; // 语料里没这个词，跳过

    // IDF 用带 +1 的平滑形式，保证即使某词出现在多数文档里也不会变成负分
    const df = posting.size;
    const idf = Math.log(1 + (size - df + 0.5) / (df + 0.5));

    for (const [docIdx, tf] of posting) {
      const norm = 1 - B + (B * docLen[docIdx]) / avgdl;
      const contribution = idf * ((tf * (K1 + 1)) / (tf + K1 * norm)) * weight;
      scores[docIdx] += contribution;

      if (!matchedWords.has(docIdx)) matchedWords.set(docIdx, []);
      matchedWords.get(docIdx).push(token);
    }
  }

  const out = [];
  for (let i = 0; i < size; i++) {
    if (scores[i] > 0) {
      out.push({ docIdx: i, score: scores[i], matched: matchedWords.get(i) ?? [] });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}
