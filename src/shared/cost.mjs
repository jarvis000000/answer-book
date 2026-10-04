/**
 * 成本与性价比的通用算法。
 *
 * 单独抽出来是因为有三处要用：
 *   ① 构建期算每条条目的性价比档（src/build/parse.mjs）
 *   ② 排序时按「成本低→高」排（src/search/sort.mjs）
 *   ③ 界面上画性价比小柱（前端拿到的是算好的 ratio，不需要重算）
 * 权重表定义在这里，别处再抄一份迟早会漂移。
 */

/**
 * 三项成本的档位权重，取自上游 index.html 的 COST_W 常量。
 * 数值只用于横向比较，没有绝对含义。
 */
export const COST_W = {
  money: { '0': 0, 少: 1, 多: 2 },
  time: { 少: 0, 中: 1, 多: 2 },
  will: { 否: 0, 些: 1, 是: 2 },
};

/**
 * 把三项成本折成一个 0 到 6 的分值。分越低越省事。
 *
 * @param {object} cost 成本标签对象 { money, time, will, gain, caliber }
 * @returns {number} 成本分
 */
export function costScore(cost = {}) {
  const money = COST_W.money[cost.money] ?? 0;
  const time = COST_W.time[cost.time] ?? 0;
  const will = COST_W.will[cost.will] ?? 0;
  return money + time + will;
}

/**
 * 按上游规则合成性价比档位：极高 / 高 / 一般。
 * 规则来源：上游 CLAUDE.md「性价比档的规则和 index.html 的 COST_W、e.ratio 两行绑定」。
 *
 *   收益大且成本分为 0                     → 极高
 *   收益大且成本分 ≤ 2，或收益中且成本分为 0  → 高
 *   其余                                   → 一般
 *
 * @param {object} cost 成本标签对象
 * @returns {'极高'|'高'|'一般'}
 */
export function computeRatio(cost = {}) {
  const score = costScore(cost);

  if (cost.gain === '大' && score === 0) return '极高';
  if ((cost.gain === '大' && score <= 2) || (cost.gain === '中' && score === 0)) return '高';
  return '一般';
}

/** 性价比档位的排序权重，数值越大越靠前 */
export const RATIO_ORDER = { 极高: 0, 高: 1, 一般: 2 };

/** 证据等级的排序权重，数值越小越靠前 */
export const GRADE_ORDER = { A: 0, B: 1, C: 2 };
