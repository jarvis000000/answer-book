/**
 * 查询解析：把一句人话问题拆成结构化条件。
 *
 * 这是整个离线匹配的入口，也是将来接 LLM 时最该替换的一环——
 * 接口保持「问题字符串 → 结构化查询对象」，规则实现和 LLM 实现可以互换（见 src/llm/adapter.mjs）。
 *
 * 例：
 *   「我是一个 45 岁女性，我需要注意哪些身体健康方面的问题」
 *   → { ages:{value:45, bands:['中年']}, gender:'female', domains:['健康'], tokens:[...] }
 */

import { STOPWORDS, stripQueryPhrases, isFunctionOnly } from './tokenize.mjs';

/** 中文数字 → 阿拉伯数字，覆盖 0 到 199 的常见写法 */
const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 一位中文数字的正则片段 */
const CN_ONE = '[零一二两三四五六七八九]';

/**
 * 把中文数字串转成数值，支持「六」「十」「十五」「四十五」「一百二十」。
 *
 * 按「百 → 十 → 个位」逐段剥离，而不是逐字累加：
 * 逐字累加会把「四十五」算成 4 → 40 → 5（个位覆盖了十位），得到 5。
 * 解析不出来时返回 null，由调用方退回「没提到年龄」。
 *
 * @param {string} s 中文数字串
 * @returns {number|null}
 */
export function cnToNumber(s) {
  if (!s) return null;

  let total = 0;
  let rest = s;

  const mBai = rest.match(new RegExp(`^(${CN_ONE})?百(.*)$`));
  if (mBai) {
    total += (mBai[1] ? CN_DIGITS[mBai[1]] : 1) * 100;
    rest = mBai[2];
  }

  const mShi = rest.match(new RegExp(`^(${CN_ONE})?十(.*)$`));
  if (mShi) {
    total += (mShi[1] ? CN_DIGITS[mShi[1]] : 1) * 10;
    rest = mShi[2];
  }

  if (rest) {
    if (!new RegExp(`^${CN_ONE}$`).test(rest)) return null;
    total += CN_DIGITS[rest];
  }

  return total;
}

/**
 * 从问题里抽出年龄，并映射到年龄段。
 *
 * 支持：阿拉伯数字（45 岁 / 6 周岁）、中文数字（六岁 / 四十五岁）、
 * 月份（8 个月）、年级（三年级 → 按 8 岁算）。多个年龄只取第一个。
 *
 * @param {string} text 问题原文
 * @param {Array<{name:string,range:[number,number]}>} bands 年龄段表
 * @param {(from:number,to:number)=>string[]} bandsForRange 区间映射函数
 * @returns {{value:number|null, bands:string[]}}
 */
export function parseAge(text, bands, bandsForRange) {
  const num = '([0-9]{1,3}|[零一二两三四五六七八九十百]{1,4})';

  // 「8 个月」先于「8 岁」判断：婴儿的年龄单位是月
  const mMonth = text.match(new RegExp(`${num}\\s*个?月(?!份)`));
  if (mMonth) {
    const v = /^[0-9]+$/.test(mMonth[1]) ? Number(mMonth[1]) : cnToNumber(mMonth[1]);
    if (v !== null && v >= 0 && v <= 36) {
      return { value: Math.round((v / 12) * 10) / 10, bands: bandsForRange(0, Math.min(1, Math.floor(v / 12)), bands), unit: '月' };
    }
  }

  // 「三年级」按小学入学年龄 6 岁推算
  const mGrade = text.match(/[一二三四五六七八九1-9]\s*年级/);
  if (mGrade) {
    const g = /[0-9]/.test(mGrade[0]) ? Number(mGrade[0][0]) : cnToNumber(mGrade[0][0]);
    if (g) {
      const age = g + 5;
      return { value: age, bands: bandsForRange(age, age, bands), unit: '年级推算' };
    }
  }

  const mAge = text.match(new RegExp(`${num}\\s*(?:周)?岁`));
  if (!mAge) return { value: null, bands: [] };

  const v = /^[0-9]+$/.test(mAge[1]) ? Number(mAge[1]) : cnToNumber(mAge[1]);
  if (v === null || v < 0 || v > 130) return { value: null, bands: [] };

  return { value: v, bands: bandsForRange(v, v, bands), unit: '岁' };
}

/**
 * 从问题里判断提问者（或他问的对象）的性别。
 * 只认明确的自述或亲属称呼，不认「女性健康」这种话题词——那是领域，不是提问者身份。
 *
 * @param {string} text 问题原文
 * @returns {'female'|'male'|'any'}
 */
export function parseGender(text) {
  const female = /(我是|我是一名|我是个)?\s*(女性|女生|女的|女人|女|孕妇|宝妈|妈妈|产妇|哺乳期|准妈妈|女儿|妻子|老婆|女友|女朋友|姐妹|阿姨|奶奶|外婆|妈妈)/;
  const male = /(我是|我是一名|我是个)?\s*(男性|男生|男的|男人|男|爸爸|父亲|儿子|丈夫|老公|男友|男朋友|兄弟|叔叔|爷爷|外公)/;

  // 「我是 XX 的妈妈」这类是替别人问，性别指被问的对象
  const fHit = female.test(text);
  const mHit = male.test(text);

  if (fHit && !mHit) return 'female';
  if (mHit && !fHit) return 'male';
  return 'any';
}

/**
 * 从问题里推断领域与主题，走 taxonomy 的词表。
 *
 * @param {string} text 问题原文
 * @param {object} taxonomy taxonomy.json 内容
 * @returns {{domains:string[], topics:string[], audiences:string[]}}
 */
export function parseFacets(text, taxonomy) {
  const hints = taxonomy.queryHints ?? {};
  const domains = [];
  for (const [name, spec] of Object.entries(taxonomy.domains.list)) {
    // 索引侧词表 + 提问侧提示词，任一命中即认定用户问的是这个领域
    const words = [...(spec.keywords ?? []), ...(hints[name] ?? [])];
    if (words.some((w) => text.includes(w))) domains.push(name);
  }

  const topics = [];
  for (const rule of taxonomy.topics.rules) {
    if ((rule.any ?? []).some((w) => text.includes(w))) topics.push(rule.topic);
  }

  const audiences = [];
  for (const rule of taxonomy.audiences.rules) {
    if ((rule.any ?? []).some((w) => text.includes(w))) audiences.push(rule.audience);
  }

  return { domains, topics, audiences };
}

/**
 * 识别三类需要「先停下来说怎么救命」的问题。
 * 与上游 skill 的第 0 步一致：急症、自杀念头、正在进行的法律程序，
 * 这三类不能拿性价比排序去回答。
 *
 * @param {string} text 问题原文
 * @returns {{emergency:boolean, selfHarm:boolean, legalProcess:boolean}}
 */
export function parseSafetyFlags(text) {
  return {
    emergency: /(倒地|没呼吸|心脏骤停|大出血|止不住血|火灾|着火|溺水|触电|中毒|误服|卒中|中风|心梗|胸痛|昏迷|抽搐|窒息|噎住|呼吸困难|大出血|骨折|烫伤|烧伤)/.test(text),
    selfHarm: /(自杀|不想活|活不下去|轻生|自残|想死|结束生命)/.test(text),
    legalProcess: /(被拘留|被传唤|被起诉|被抓|已经立案|被警察带走|在看守所)/.test(text),
  };
}

/**
 * 同义词扩展：把用户嘴上的词换成书里真正写的词。
 *
 * 中文二元组切分有一个绕不过去的短板——它无法发现「裁员」和「辞退」是一回事。
 * 这两个词在这本书里的文档频率都极低（「裁员」只出现在 1 条里），
 * 单靠词频没法把真词和跨词边界的碎片（「检报」「告说」）分开。
 * 所以用一份人工维护的小词典把这条鸿沟补上：命中键就把值也当成查询词加进去。
 *
 * 关键取舍：**书里本来就说这个词时不翻译**。判据是「这个词切出来的二元组在语料里够常见」。
 * 「被裁」翻成「解除劳动合同」看着合理，实际上会把 合同、劳动、解除 三个书里的高频词
 * 也塞进查询，问「怎么领失业金」的条目全被第 19 节讲劳动合同的条目顶下去。
 * 只有书真的不说（「裁员」在全语料只出现 1 次）时才需要这张对照表。
 *
 * @param {string} text 已删过套话的查询文本
 * @param {object} synonyms data/synonyms.json 的内容
 * @param {(text:string)=>string[]} tokenizeFn 切分函数
 * @param {(token:string)=>boolean} isKnown 判断某个词在语料里是否够常见
 * @returns {string[]} 追加的查询 token
 */
export function expandSynonyms(text, synonyms, tokenizeFn, isKnown) {
  const extra = [];
  for (const [key, values] of Object.entries(synonyms ?? {})) {
    if (key.startsWith('_')) continue;
    if (!text.includes(key)) continue;
    if (isKnown && tokenizeFn(key).some(isKnown)) continue; // 书里已有这个说法，不用换
    for (const v of values) extra.push(...tokenizeFn(v));
  }
  return extra;
}

/**
 * 总入口：把问题解析成结构化查询。
 *
 * @param {string} question 用户问题
 * @param {object} taxonomy taxonomy.json 内容
 * @param {(text:string)=>string[]} tokenizeFn 切分函数
 * @param {(from:number,to:number)=>string[]} bandsForRange 年龄区间映射
 * @returns {object} 结构化查询
 */
export function parseQuery(question, taxonomy, tokenizeFn, bandsForRange) {
  const text = (question ?? '').trim();
  const bands = taxonomy.ageBands.bands;

  const age = parseAge(text, bands, bandsForRange);
  // 提问里的称呼词也能表明年龄段：「老人」→ 老年、「孩子」→ 幼儿和学龄。
  // 但只在**没写具体年龄**时才启用——「6 岁孩子」里数字是明确信息，
  // 再叠一层「孩子 → 幼儿+学龄」只会把范围撑大，反而模糊了「就是 6 岁」这个事实。
  if (age.value === null) {
    const bandWords = bands.filter((b) => (b.keywords ?? []).some((k) => text.includes(k))).map((b) => b.name);
    if (bandWords.length) {
      age.bands = [...new Set(bandWords)];
      age.inferredFrom = '称呼词';
    }
  }

  const gender = parseGender(text);
  const facets = parseFacets(text, taxonomy);
  const flags = parseSafetyFlags(text);

  // 关键词召回：先删提问套话再切分，否则「是一个」「康方」「面的」这类跨词边界碎片会污染召回
  const stripped = stripQueryPhrases(text);
  const ageStr = age.value === null ? null : String(age.value);
  const tokens = tokenizeFn(stripped).filter((t) => {
    if (STOPWORDS.has(t)) return false;
    // 年龄数字已经单独解析成年龄段了，再让它当关键词只会到处误命中（「45」能撞上任何写着 45 的条目）
    if (ageStr && t === ageStr) return false;
    // 纯功能字残片（「我要」「要做」）在语料里零星可见，留着只会给无关条目送分
    if (isFunctionOnly(t)) return false;
    return true;
  });

  return {
    raw: text,
    stripped,
    ages: age,
    gender,
    domains: facets.domains,
    topics: facets.topics,
    audiences: facets.audiences,
    flags,
    tokens,
  };
}
