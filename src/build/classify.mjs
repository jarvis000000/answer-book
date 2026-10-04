/**
 * 规则打标器：给每条条目补上年龄 / 性别 / 领域 / 主题 / 人群 / 症状标签。
 *
 * 设计原则（见 .claude/plan/答案之书-实施计划.md 第 3 节）：
 *   1. 全部由词表命中决定，不用模型猜 —— 重建结果可复现、可 diff。
 *   2. 标题命中比正文命中更可信，所以分开统计、权重不同。
 *   3. 词典在 data/taxonomy.json，人工修正放 data/overrides.json，两者分开存放，
 *      重建时机器结果先算、人工结论后覆盖，不会互相污染。
 */

/**
 * 把年龄数字映射成年龄段。用区间的重叠关系判断：
 * 一个「0～3 岁」的条目同时落在婴儿和幼儿两段里。
 *
 * @param {number} from 起始年龄（含）
 * @param {number} to 结束年龄（含），开放区间传 Infinity
 * @param {Array<{name:string,range:[number,number]}>} bands 年龄段表
 * @returns {string[]} 命中的年龄段名
 */
function bandsForRange(from, to, bands) {
  return bands
    .filter((b) => b.range[0] <= to && b.range[1] >= from)
    .map((b) => b.name);
}

/**
 * 从文本里抽取显式年龄，转成年龄段。
 * 支持的写法（覆盖源书里的实际用法）：
 *   35 岁以后 / 60 岁以上 / 18 岁起   → 开放区间
 *   0～3 岁 / 12 到 18 岁 / 4-6 岁   → 闭区间
 *   6 岁                              → 单点
 *
 * @param {string} text 待扫描文本
 * @param {Array} bands 年龄段表
 * @returns {string[]} 年龄段名
 */
export function extractAgeBands(text, bands) {
  const found = new Set();
  const maxAge = Math.max(...bands.map((b) => b.range[1]));

  // 区间写法：0～3 岁、12 到 18 岁、4-6 岁
  for (const m of text.matchAll(/(\d{1,3})\s*(?:[～~到至\-—]\s*(\d{1,3}))\s*岁/g)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    for (const name of bandsForRange(Math.min(a, b), Math.max(a, b), bands)) found.add(name);
  }

  // 开放区间写法：35 岁以后 / 60 岁以上 / 18 岁起
  for (const m of text.matchAll(/(\d{1,3})\s*岁\s*(?:以后|之后|以上|起)/g)) {
    const a = Number(m[1]);
    for (const name of bandsForRange(a, maxAge, bands)) found.add(name);
  }

  // 开放区间写法：不满 16 周岁 / 未满 18 岁
  for (const m of text.matchAll(/[不未]满\s*(\d{1,3})\s*(?:周)?岁/g)) {
    const a = Number(m[1]);
    for (const name of bandsForRange(0, a - 1, bands)) found.add(name);
  }

  // 单点写法：6 岁；已被上面两条吃掉的不会再重复命中
  for (const m of text.matchAll(/(\d{1,3})\s*岁(?!\s*(?:以后|之后|以上|起))/g)) {
    if (/[～~到至\-—]\s*$/.test(text.slice(0, m.index))) continue; // 属于区间写法，跳过
    const a = Number(m[1]);
    for (const name of bandsForRange(a, a, bands)) found.add(name);
  }

  return [...found];
}

/**
 * 统计一组关键词在「标题」和「正文」里各命中多少次。
 *
 * @param {string} title 标题文本（高权重）
 * @param {string} body 正文文本（低权重）
 * @param {string[]} keywords 关键词表
 * @returns {{titleHits:number, bodyHits:number, matched:string[]}}
 */
function countHits(title, body, keywords) {
  let titleHits = 0;
  let bodyHits = 0;
  const matched = [];
  for (const kw of keywords) {
    let hit = false;
    if (title.includes(kw)) {
      titleHits++;
      hit = true;
    } else if (body.includes(kw)) {
      bodyHits++;
      hit = true;
    }
    if (hit) matched.push(kw);
  }
  return { titleHits, bodyHits, matched };
}

/**
 * 判定性别归属。
 *
 * 主要看标题：源书里真正写给某一性别的条目，标题几乎都会点名（「女性接种 HPV 疫苗」
 * 「勃起功能出了问题」）。正文里的性别词多半是**研究人群**而不是受众——
 * 「每天喝三四杯咖啡」正文提了一句女性受试者，条目本身并不是只给女性看的。
 * 早期版本让正文命中参与打分，结果 48 条「女性专属」里混进一堆，
 * 所以现在改成标题说了算；标题没说时，正文要单侧提到 3 处以上、另一侧一处不提，才认。
 * 宁可漏标也不误标：误标会把不相关的条目推到提问者面前。
 *
 * @param {string} title 标题
 * @param {string} body 正文
 * @param {object} genders taxonomy.genders
 * @returns {'female'|'male'|'any'}
 */
export function classifyGender(title, body, genders) {
  const titleHits = (spec) => countHits(title, '', spec.titleKeywords).titleHits;
  const bodyHits = (spec) => countHits('', body, spec.bodyKeywords).bodyHits;

  const fTitle = titleHits(genders.female);
  const mTitle = titleHits(genders.male);

  if (fTitle > 0 && mTitle === 0) return 'female';
  if (mTitle > 0 && fTitle === 0) return 'male';

  // 标题两侧都没点名时，才退到正文判断
  if (fTitle === 0 && mTitle === 0) {
    const fBody = bodyHits(genders.female);
    const mBody = bodyHits(genders.male);
    if (fBody >= 3 && mBody === 0) return 'female';
    if (mBody >= 3 && fBody === 0) return 'male';
  }

  return 'any';
}

/**
 * 按章节归属给出基础领域。
 *
 * @param {number} sectionNum 节号
 * @param {object} domains taxonomy.domains
 * @returns {string[]} 领域名
 */
function domainsBySection(sectionNum, domains) {
  const out = [];
  for (const [name, spec] of Object.entries(domains.list)) {
    if (spec.sections?.includes(sectionNum)) out.push(name);
  }
  return out;
}

/**
 * 关键词补充领域。章节归属给的是「这一节整体讲什么」，
 * 关键词补的是「这一条具体讲什么」——比如第 1 节里那条讲火灾的，要能额外命中「安全」。
 *
 * @param {string} title 标题
 * @param {string} body 正文
 * @param {object} domains taxonomy.domains
 * @returns {string[]} 领域名
 */
function domainsByKeywords(title, body, domains) {
  const out = [];
  for (const [name, spec] of Object.entries(domains.list)) {
    if (!spec.keywords?.length) continue;
    const { titleHits, bodyHits } = countHits(title, body, spec.keywords);
    if (titleHits > 0 || bodyHits >= 2) out.push(name);
  }
  return out;
}

/**
 * 通用规则表打标（topics / audiences 共用同一套结构）。
 *
 * 命中条件有两个，满足其一即可：
 *   ① 章节映射：某些节整体就是给某类人写的（第 11 节整节都是程序员红线），
 *      整节套用比逐条猜关键词准得多；
 *   ② 关键词命中：标题命中一次算数，正文要命中两个不同词才算——
 *      单字词（「法」「吃」「眼」）在正文里误命中极多，只靠一次正文命中
 *      会把标签打成「人人都有」，反而失去区分度。
 *
 * @param {string} title 标题
 * @param {string} body 正文
 * @param {Array<{any:string[], sections?:number[]}>} rules 规则表
 * @param {string} fieldName 每条规则里取哪个字段作为标签名
 * @param {number} sectionNum 所属节号
 * @returns {string[]} 命中的标签名
 */
function applyRules(title, body, rules, fieldName, sectionNum) {
  const out = [];
  for (const rule of rules) {
    if (rule.sections?.includes(sectionNum)) {
      out.push(rule[fieldName]);
      continue;
    }
    const { titleHits, bodyHits } = countHits(title, body, rule.any ?? []);
    if (titleHits > 0 || bodyHits >= 2) out.push(rule[fieldName]);
  }
  return out;
}

/**
 * 给整批条目打标签。
 *
 * @param {object[]} entries parse.mjs 产出的条目
 * @param {object} taxonomy data/taxonomy.json 的内容
 * @param {object} overrides data/overrides.json 的内容：{ [entryId]: {部分标签字段} }
 * @returns {{entries:object[], stats:object}} 打标后的条目 + 统计信息
 */
export function classifyAll(entries, taxonomy, overrides = {}) {
  const bands = taxonomy.ageBands.bands;
  const anyLabel = taxonomy.ageBands._anyLabel ?? '全龄';
  const symptomWords = taxonomy.symptomHints?.keywords ?? [];

  const out = entries.map((entry) => {
    // 标题作为强信号，其余字段合起来作为弱信号
    const title = entry.title;
    const body = [entry.plain, entry.gain, entry.note, entry.costText].filter(Boolean).join('\n');

    // —— 领域：章节默认 ∪ 关键词补充 ——
    const domainSet = new Set([
      ...domainsBySection(entry.section, taxonomy.domains),
      ...domainsByKeywords(title, body, taxonomy.domains),
    ]);

    // —— 年龄：标题词表命中 ∪ 标题里的显式年龄数字 ——
    // 正文里的年龄数字不做提取：筛查建议里常顺带提「40 岁」「60 岁」的研究分组，
    // 一提就把条目打成全年龄段，反而淹没了真正针对该年龄的条目。
    const ageSet = new Set();
    for (const band of bands) {
      const t = countHits(title, '', band.keywords).titleHits;
      const b = countHits('', body, band.keywords).bodyHits;
      if (t > 0 || b >= 2) ageSet.add(band.name);
    }
    for (const name of extractAgeBands(title, bands)) ageSet.add(name);
    if (ageSet.size === 0) ageSet.add(anyLabel);

    // —— 性别 / 主题 / 人群 / 症状 ——
    const gender = classifyGender(title, body, taxonomy.genders);
    const topics = applyRules(title, body, taxonomy.topics.rules, 'topic', entry.section);
    const audiences = applyRules(title, body, taxonomy.audiences.rules, 'audience', entry.section);
    const signs = symptomWords.filter((w) => title.includes(w) || body.includes(w));

    const tagged = {
      ...entry,
      tags: {
        ages: [...ageSet],
        gender,
        domains: [...domainSet].sort(),
        // 章节映射和关键词命中可能同时给出同一个标签，去重后再排序
        topics: [...new Set(topics)].sort(),
        audiences: [...new Set(audiences)].sort(),
        signs,
      },
    };

    // 人工覆盖最后生效：只覆盖显式给出的字段
    const override = overrides[entry.id];
    if (override && typeof override === 'object') {
      tagged.tags = { ...tagged.tags, ...override };
      tagged.overridden = Object.keys(override);
    }

    return tagged;
  });

  return { entries: out, stats: summarize(out, taxonomy) };
}

/**
 * 汇总打标结果，用于人工复核：某个标签只命中 1 到 2 条时通常是误标或漏词。
 *
 * @param {object[]} entries 已打标条目
 * @param {object} taxonomy 词典
 * @returns {object} 各维度的计数分布
 */
export function summarize(entries, taxonomy) {
  const tally = (pick) => {
    const counter = {};
    for (const e of entries) {
      for (const v of pick(e)) counter[v] = (counter[v] ?? 0) + 1;
    }
    return Object.fromEntries(Object.entries(counter).sort((a, b) => b[1] - a[1]));
  };

  return {
    total: entries.length,
    ages: tally((e) => e.tags.ages),
    gender: tally((e) => (e.tags.gender === 'any' ? ['不限'] : [e.tags.gender === 'female' ? '女性专属' : '男性专属'])),
    domains: tally((e) => e.tags.domains),
    topics: tally((e) => e.tags.topics),
    audiences: tally((e) => e.tags.audiences),
    signs: tally((e) => e.tags.signs),
    overridden: entries.filter((e) => e.overridden).length,
    domainCount: Object.keys(taxonomy.domains.list).length,
  };
}
