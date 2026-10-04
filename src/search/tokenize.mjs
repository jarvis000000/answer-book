/**
 * 中文切分器（零依赖）。
 *
 * 为什么不用分词词典：本书语料只有 657 条、几十万字，且查询都是短句。
 * 二元组（bigram）切分对短文本检索的效果接近分词，而且不会因为词典缺词而漏召——
 * 「幽门螺杆菌」被切成「幽门/门螺/螺杆/杆菌」，只要查询里出现其中任意连续两字就能命中。
 *
 * 规则：
 *   - 中日韩统一表意文字连续段 → 二元组；段长 ≤ 3 时额外补上整段，避免「疫苗」这类短词被切碎
 *   - 拉丁字母和数字 → 转小写后整段作为一个 token（「HPV」「120」「F-1」）
 *   - 其余字符（标点、空白）当作分隔符
 *   - 停用词表挡掉「的」「了」「注意」「方面」这类不携带检索信息的词
 */

/** 停用词：功能词 + 提问套话，留在索引里只会稀释相关性 */
export const STOPWORDS = new Set([
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '我们', '你们', '他们',
  '我的', '你的', '他的', '她的', '它的', '我们的', '你们的', '他们的',
  '自己', '大家', '有人', '有些', '时候', '一下子',
  '有', '和', '与', '或', '及', '也', '都', '就', '很', '还', '要', '会', '能', '可以', '应该',
  '这', '那', '这个', '那个', '这些', '那些', '一个', '一种', '什么', '哪些', '哪个',
  '吗', '呢', '吧', '啊', '呀', '请', '问', '一下', '如何', '怎么', '怎样', '多少',
  '需要', '注意', '方面', '问题', '情况', '时候', '如果', '因为', '所以', '但是',
  '对于', '关于', '以及', '还有', '或者', '不是', '就是', '没有', '怎么', '知道', '告诉',
]);

/**
 * 提问套话表。
 *
 * 中文没有词边界，二元组切分会把「是一个」「康方」「面的」这种跨词边界的碎片也切出来。
 * 这些碎片在语料里几乎不出现，本该自然落榜；但一句提问里它们占了 token 总数的一大半，
 * 又总能零星命中，合起来足以把「国家赔偿」这种完全无关的条目顶进前十。
 *
 * 所以检索前先把套话整段删掉，只留实词。只对查询做，不改索引——
 * 索引那侧是正文，不存在"提问套话"这种东西。
 */
export const QUERY_PHRASES = [
  '我需要注意哪些', '需要注意什么', '我需要注意', '需要注意', '要注意', '应该注意', '注意哪些',
  '我应该做什么', '我要做什么', '我该做什么', '我该怎么办', '我应该怎么办',
  '有哪些建议', '有什么建议', '有什么好建议', '有哪几条',
  '该怎么办', '怎么办', '怎么做', '如何做', '怎么处理', '如何处理', '做什么', '干嘛',
  '我是一个', '我是个', '我是', '我今年', '我现在', '我想问', '我想知道', '我要', '我该', '我应该',
  '方面的问题', '的问题', '有没有', '能不能', '可不可以', '可以吗', '行不行',
  '请问', '请教', '帮我', '告诉我', '说一下', '讲讲',
  '方面', '问题', '的建议', '有哪些', '有什么', '哪些', '什么', '怎么', '如何',
  '一下', '一些', '一点', '谢谢', '多谢', '辛苦了', '拜托',
];

/**
 * 纯功能字集合。
 *
 * 「我要做什么」这类句子被短语表删过之后，可能剩下一小段只由功能字组成的残片
 * （「我要做」）。它既不是词，也说不清指什么，但在语料里总能零星撞上，
 * 于是一堆毫不相干的条目靠它拿到高分——「把打算做写成几点在哪」那条就是靠「要做」上榜的。
 * 判据是「整段都由功能字组成」，只要有一个实字就留下。
 */
export const FUNCTION_CHARS = new Set(
  '我你他她它的了是在有和与或也就很还要会能可以这那什么吗呢吧做去来对给把被让着过之其用为到上下里外'
);

/**
 * 判断一个 token 是不是「纯功能字残片」。
 *
 * @param {string} token 待判断的 token
 * @returns {boolean} true 表示应当丢弃
 */
export function isFunctionOnly(token) {
  if (!token) return true;
  for (const ch of token) {
    if (!FUNCTION_CHARS.has(ch)) return false;
  }
  return true;
}

/**
 * 删除提问里的套话，减少无意义的二元组碎片。
 *
 * @param {string} text 原始问题
 * @returns {string} 删除套话后的文本
 */
export function stripQueryPhrases(text) {
  let out = text ?? '';
  // 长短语先删，避免短短语先吃掉长短语的一部分导致残留
  const sorted = [...QUERY_PHRASES].sort((a, b) => b.length - a.length);
  for (const phrase of sorted) out = out.split(phrase).join(' ');
  return out;
}

/** 判断一个码位是否属于 CJK 统一表意文字（含扩展 A 区） */
function isCJK(code) {
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // 基本区
    (code >= 0x3400 && code <= 0x4dbf) // 扩展 A
  );
}

/** 判断是否为拉丁字母或数字 */
function isAlnum(code) {
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) // a-z
  );
}

/**
 * 把文本切成检索 token 序列。同一个 token 可能出现多次，调用方按词频统计。
 *
 * @param {string} text 任意文本
 * @returns {string[]} token 数组（保留重复，供 BM25 统计词频）
 */
export function tokenize(text) {
  const tokens = [];
  if (!text) return tokens;

  let i = 0;
  const n = text.length;

  while (i < n) {
    const code = text.codePointAt(i);

    if (isCJK(code)) {
      // 收集一整段连续的汉字
      let j = i;
      while (j < n && isCJK(text.codePointAt(j))) j++;
      const run = text.slice(i, j);

      if (run.length === 1) {
        if (!STOPWORDS.has(run)) tokens.push(run);
      } else {
        // 二元组切分；三字短段额外保留整段，让「疫苗」「仲裁」这类词权重更集中。
        // 两字段不补整段——它的整段就是它唯一的那个二元组，补了会把自己算两遍。
        for (let k = 0; k < run.length - 1; k++) {
          const gram = run.slice(k, k + 2);
          if (!STOPWORDS.has(gram)) tokens.push(gram);
        }
        if (run.length === 3 && !STOPWORDS.has(run)) tokens.push(run);
      }
      i = j;
      continue;
    }

    if (isAlnum(code)) {
      // 收集连续的字母数字，中间允许 - 和 . （「F-1」「GB 7718」这类写法先按空格断开）
      let j = i;
      while (j < n && (isAlnum(text.codePointAt(j)) || text[j] === '-' || text[j] === '.')) j++;
      const word = text.slice(i, j).replace(/[-.]+$/, '').toLowerCase();
      if (word && word.length <= 24 && !STOPWORDS.has(word)) tokens.push(word);
      i = j;
      continue;
    }

    i++;
  }

  return tokens;
}

/**
 * 把 token 序列压成「token → 词频」的表。
 *
 * @param {string[]} tokens token 数组
 * @returns {Map<string, number>} 词频表
 */
export function termFrequency(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}
