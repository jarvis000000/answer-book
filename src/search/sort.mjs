/**
 * 结果排序方式。
 *
 * 相关性是默认口径，但它不是唯一有意义的口径：
 * 有人想先看证据最硬的（A 级），有人想先看不花钱不费劲的（成本最低），
 * 还有人就是想把这一节从头到尾读一遍（章节顺序）。
 * 所以排序在**已经筛出相关条目之后**再做——换排序不改变「哪些条目相关」，
 * 只改变「相关的这些先看哪个」。这一点很重要：按等级排不该把不相关的 A 级条目捞进来。
 */

import { costScore, GRADE_ORDER, RATIO_ORDER } from '../shared/cost.mjs';

/** 可选的排序方式。key 用于接口参数，label 用于界面，hint 说明这一档在比什么 */
export const SORT_MODES = [
  { key: 'relevance', label: '相关性', hint: '综合关键词与标签匹配度' },
  { key: 'grade', label: '证据等级', hint: 'A 级在前，同级按相关性' },
  { key: 'ratio', label: '性价比', hint: '极高在前，同级按相关性' },
  { key: 'cheap', label: '成本最低', hint: '钱、时间、毅力花得最少在前' },
  { key: 'section', label: '章节顺序', hint: '按源书目录顺序读' },
];

/** 合法的排序 key 集合，用于校验接口参数 */
export const SORT_KEYS = new Set(SORT_MODES.map((m) => m.key));

/**
 * 取证据等级的排序值，未知等级排最后。
 *
 * @param {object} entry 条目
 * @returns {number}
 */
function gradeValue(entry) {
  return GRADE_ORDER[entry.grade] ?? 99;
}

/**
 * 取性价比的排序值，未知档位排最后。
 *
 * @param {object} entry 条目
 * @returns {number}
 */
function ratioValue(entry) {
  return RATIO_ORDER[entry.ratio] ?? 99;
}

/**
 * 各排序方式的比较函数。每个都以相关性作为同档内的次级排序依据，
 * 这样「同样都是 A 级」时，更相关的仍然排前面。
 */
const COMPARATORS = {
  grade: (a, b) => gradeValue(a.entry) - gradeValue(b.entry) || b.score - a.score,
  ratio: (a, b) => ratioValue(a.entry) - ratioValue(b.entry) || b.score - a.score,
  cheap: (a, b) => costScore(a.entry.cost) - costScore(b.entry.cost) || b.score - a.score,
  section: (a, b) => a.entry.section - b.entry.section || a.entry.num - b.entry.num,
};

/**
 * 对已排好相关性的结果重新排序。
 *
 * 传入的数组会被复制，不原地改动——调用方往往还要用原始顺序做别的事。
 *
 * @param {object[]} results rank() 的产物（已按相关性降序）
 * @param {string} key 排序方式，见 SORT_MODES
 * @returns {object[]} 重排后的新数组
 */
export function sortResults(results, key = 'relevance') {
  const comparator = COMPARATORS[key];
  if (!comparator) return [...results]; // relevance 或未知 key：保持原顺序

  return [...results].sort(comparator);
}
