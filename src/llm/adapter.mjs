/**
 * LLM 适配层（可选，默认关闭）。
 *
 * 这一层的职责边界是刻意的：**LLM 只做两件事——把问题解析得更准、把候选重新排序。
 * 答案正文永远来自本地 657 条，一个字都不由模型生成。**
 * 源书的全部价值在于「每个数字都能指回原始文献」，一旦让模型改写或补全，
 * 这个价值立刻归零，而且会以最难发现的方式出错（编出来的 DOI、记错的百分比）。
 *
 * 没配环境变量时自动退回纯规则实现，离线路径是默认路径而不是降级路径。
 *
 * 环境变量：
 *   ANSWER_BOOK_LLM_BASE   形如 http://127.0.0.1:8080/v1（OpenAI 兼容接口）
 *   ANSWER_BOOK_LLM_KEY    密钥，本地网关可留空
 *   ANSWER_BOOK_LLM_MODEL  模型名
 */

import { parseQuery } from '../search/parse-query.mjs';

/** 规划器的共同接口：name + plan(); rerank 可选 */
const ENV = {
  base: process.env.ANSWER_BOOK_LLM_BASE?.replace(/\/+$/, '') ?? '',
  key: process.env.ANSWER_BOOK_LLM_KEY ?? '',
  model: process.env.ANSWER_BOOK_LLM_MODEL ?? '',
};

/**
 * 是否配置了 LLM。三样缺一不可——只配了一半时静默退回规则实现，
 * 而不是带着半截配置去发请求，那样只会得到一个更难懂的报错。
 *
 * @returns {boolean}
 */
export function isLLMConfigured() {
  return Boolean(ENV.base && ENV.model);
}

/**
 * 调用 OpenAI 兼容的 chat/completions 接口。
 *
 * @param {Array<{role:string,content:string}>} messages 对话消息
 * @param {object} [options] { temperature, maxTokens, timeoutMs }
 * @returns {Promise<string>} 模型回复的正文
 */
async function chat(messages, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20000);

  try {
    const res = await fetch(`${ENV.base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(ENV.key ? { Authorization: `Bearer ${ENV.key}` } : {}),
      },
      body: JSON.stringify({
        model: ENV.model,
        messages,
        temperature: options.temperature ?? 0,
        max_tokens: options.maxTokens ?? 800,
      }),
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`LLM 接口返回 ${res.status}`);
    const data = await res.json();
    return data?.choices?.[0]?.message?.content ?? '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从模型回复里抠出 JSON。
 * 模型常把 JSON 包在 ```json 代码块里或前后加一句解释，这里做一次宽松提取。
 *
 * @param {string} text 模型回复
 * @returns {object|null} 解析结果
 */
function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 规则规划器：包装 parseQuery，是默认实现。
 *
 * @param {object} taxonomy taxonomy.json
 * @param {(text:string)=>string[]} tokenizeFn 切分函数
 * @param {(from:number,to:number)=>string[]} bandsForRange 年龄区间映射
 * @returns {object} 规划器
 */
export function createRulePlanner(taxonomy, tokenizeFn, bandsForRange) {
  return {
    name: 'rule',
    async plan(question) {
      return parseQuery(question, taxonomy, tokenizeFn, bandsForRange);
    },
  };
}

/**
 * LLM 规划器：让模型把问题解析成结构化条件，并可选地对候选重排。
 *
 * 提示词里把词表一并给模型，并要求「只能用给定取值」——
 * 否则模型会自造领域名，下游拿不到对应的标签也就白解析了。
 *
 * @param {object} taxonomy taxonomy.json
 * @param {object} rulePlanner 兜底用的规则规划器
 * @returns {object} 规划器
 */
export function createLLMPlanner(taxonomy, rulePlanner) {
  const domainNames = Object.keys(taxonomy.domains.list).join('、');
  const bandNames = taxonomy.ageBands.bands.map((b) => b.name).join('、');

  return {
    name: 'llm',

    /**
     * 解析问题。模型失败时无条件退回规则结果，绝不让检索因为模型挂了而停摆。
     *
     * @param {string} question 用户问题
     * @returns {Promise<object>} 与 parseQuery 同构的查询对象
     */
    async plan(question) {
      const fallback = await rulePlanner.plan(question);

      const system = [
        '你在为一个中文检索系统解析用户的问题，只输出 JSON，不要解释。',
        `领域只能从这些里选：${domainNames}`,
        `年龄段只能从这些里选：${bandNames}`,
        '字段：domains 数组、ageBands 数组、gender 取 female/male/any、keywords 数组（用户问题里真正有检索价值的实词，去掉「我想」「怎么办」这类套话）。',
        '无法判断的字段给空数组。不要编造用户没说的年龄或性别。',
      ].join('\n');

      try {
        const reply = await chat(
          [
            { role: 'system', content: system },
            { role: 'user', content: question },
          ],
          { maxTokens: 400 }
        );
        const parsed = extractJson(reply);
        if (!parsed) return fallback;

        // 只接受词表里已有的取值，模型自造的标签一律丢弃
        const validDomains = new Set(Object.keys(taxonomy.domains.list));
        const validBands = new Set(taxonomy.ageBands.bands.map((b) => b.name));

        return {
          ...fallback,
          domains: (parsed.domains ?? []).filter((d) => validDomains.has(d)),
          ages: {
            ...fallback.ages,
            bands: (parsed.ageBands ?? []).filter((b) => validBands.has(b)),
          },
          gender: ['female', 'male', 'any'].includes(parsed.gender) ? parsed.gender : fallback.gender,
          tokens: Array.isArray(parsed.keywords) && parsed.keywords.length ? parsed.keywords : fallback.tokens,
          plannedBy: 'llm',
        };
      } catch {
        return fallback;
      }
    },

    /**
     * 对候选重排。只换顺序，不改内容——模型看不到也改不了条目正文。
     *
     * @param {string} question 原始问题
     * @param {object[]} results 已排好序的结果
     * @param {number} keep 重排后保留多少条
     * @returns {Promise<object[]>} 重排后的结果
     */
    async rerank(question, results, keep) {
      if (results.length <= 2) return results.slice(0, keep);

      const list = results
        .map((r, i) => `${i}. ${r.entry.title}｜${r.entry.plain.slice(0, 60)}`)
        .join('\n');

      try {
        const reply = await chat(
          [
            {
              role: 'system',
              content:
                '你在给一个生活建议检索系统的结果重排。只输出 JSON 数组，元素是原序号，按与用户问题的相关程度从高到低排列。不要新增、删除或解释。',
            },
            { role: 'user', content: `用户问题：${question}\n\n候选条目：\n${list}\n\n输出 JSON 数组。` },
          ],
          { maxTokens: 200 }
        );

        const arr = extractJson(reply);
        const order = Array.isArray(arr) ? arr : extractJson(`{${reply}}`)?.order;
        if (!Array.isArray(order)) return results.slice(0, keep);

        const seen = new Set();
        const out = [];
        for (const i of order) {
          const idx = Number(i);
          if (Number.isInteger(idx) && idx >= 0 && idx < results.length && !seen.has(idx)) {
            seen.add(idx);
            out.push(results[idx]);
          }
        }
        // 模型漏掉的按原顺序补在后面，保证条数不缩水
        for (let i = 0; i < results.length && out.length < keep; i++) {
          if (!seen.has(i)) out.push(results[i]);
        }
        return out.slice(0, keep);
      } catch {
        return results.slice(0, keep);
      }
    },
  };
}
