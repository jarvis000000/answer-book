/**
 * 前端拿到的数据长什么样 —— 服务端和纯静态模式共用这一份定义。
 *
 * 为什么要抽出来：同一个界面有两种后端（本地 Node 服务、纯静态托管），
 * 如果各写一份「把引擎结果转成前端格式」的代码，两边迟早会漂移，
 * 而且这种漂移很隐蔽——页面能跑，只是某个字段悄悄缺了或名字变了。
 * 放在这里，谁改都只有一处。
 */

/**
 * 把一条排序结果转成前端要的扁平结构。
 *
 * 故意只挑前端真正用到的字段：内部用的 score 分解、matched 词表这些不上前线，
 * 省下的体积在静态托管模式下是真金白银。
 *
 * @param {object} item rank() 的产物 { entry, score, reasons, ... }
 * @returns {object} 扁平结果
 */
export function toClientResult(item) {
  const e = item.entry;
  return {
    id: e.id,
    ref: e.ref,
    section: e.section,
    sectionTitle: e.sectionTitle,
    num: e.num,
    title: e.title,
    plain: e.plain,
    gain: e.gain,
    note: e.note,
    costText: e.costText,
    cost: e.cost,
    grade: e.grade,
    ratio: e.ratio,
    tags: e.tags,
    sources: e.sources,
    score: Number(item.score.toFixed(4)),
    reasons: item.reasons,
  };
}

/**
 * 一次 ask 的完整响应体。
 *
 * @param {object} result engine.ask() 的返回
 * @returns {object} 响应体
 */
export function toAskPayload(result) {
  return {
    query: result.query,
    safety: result.safety,
    sort: result.sort,
    totalCandidates: result.totalCandidates,
    totalRelevant: result.totalRelevant,
    results: result.results.map(toClientResult),
  };
}

/**
 * 统计条目的某个维度，只保留命中数够多的取值——
 * 界面的筛选器不需要长尾，列出来反而没法用。
 *
 * @param {object[]} entries 条目
 * @param {(entry:object)=>string[]} pick 取该条目在这个维度上的取值
 * @param {number} minCount 低于这个命中数的取值不列出
 * @returns {{name:string,count:number}[]} 按命中数降序
 */
function tallyDimension(entries, pick, minCount) {
  const map = {};
  for (const e of entries) for (const v of pick(e)) map[v] = (map[v] ?? 0) + 1;
  return Object.entries(map)
    .filter(([, n]) => n >= minCount)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));
}

/**
 * 生成界面的元信息：标签取值清单 + 可用的排序方式。
 *
 * @param {object} book 检索引擎实例
 * @returns {object} 元信息
 */
export function buildMeta(book) {
  const entries = book.entries;
  return {
    total: entries.length,
    sections: book.sections.length,
    // 排序方式由后端定义、前端渲染，两边不会各写一份枚举而漂移
    sortModes: book.sortModes,
    domains: tallyDimension(entries, (e) => e.tags.domains, 3),
    ages: tallyDimension(entries, (e) => e.tags.ages, 3),
    topics: tallyDimension(entries, (e) => e.tags.topics, 3),
    audiences: tallyDimension(entries, (e) => e.tags.audiences, 3),
    grades: tallyDimension(entries, (e) => (e.grade ? [e.grade] : []), 1),
    ratios: tallyDimension(entries, (e) => [e.ratio], 1),
  };
}
