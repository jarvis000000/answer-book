/**
 * 源书 Markdown 解析器
 *
 * 输入：data/source/*.md（上游《高性价比人生指南》原样副本，不改动）
 * 输出：结构化条目数组 + 章节元信息
 *
 * 源文件格式（657 条全部一致，无例外）：
 *   # 1. 不要早死                    ← h1，一节一个文件
 *   节首引言段落……
 *   ### 12. 标题                    ← h3，一条
 *   <!-- 成本标签: 钱=0 时间=少 毅力=否 收益=大 口径=死亡率 -->
 *   - 成本：……
 *   - 说人话：……
 *   - 收益：……
 *   - 证据等级：A
 *   - 来源：…… <https://……>
 *   - 备注：……
 *
 * 解析策略是「宽松读取 + 严格校验」：字段缺失不抛异常，只记入 warnings，
 * 由调用方决定是否视为失败——这样上游改格式时能看见哪里变了，而不是整个崩掉。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { computeRatio } from '../shared/cost.mjs';

// 性价比算法在 src/shared/cost.mjs，这里只做转发，保持既有调用方不受影响
export { computeRatio };

/** 条目标题行：`### 12. 标题文本` */
const RE_ENTRY_HEADING = /^###\s+(\d+)\s*[.、]\s*(.+?)\s*$/;
/** 章节标题行：`# 1. 不要早死` */
const RE_SECTION_HEADING = /^#\s+(\d+)\s*[.、]\s*(.+?)\s*$/;
/** 成本标签 HTML 注释行 */
const RE_COST_COMMENT = /^<!--\s*成本标签[:：]\s*(.*?)\s*-->$/;
/** 备注 / 导览里的「见第 X 节第 Y 条」式引用，用于后续做相关条目推荐 */
const RE_REF = /第\s*(\d+)\s*节\s*第\s*(\d+)\s*条/g;
/**
 * 文件级尾巴（页脚）识别。命中后其后全部内容都不再算进最后一条条目的正文——
 * 否则末条会凭空多出几行「未归类正文」。两种形态：
 *   ① 节级尾部标题：全书只有第 26 节末尾的 `## 许可`（h2 在本书里不参与条目标题结构）
 *   ② 许可声明正文行，如「正文按 [CC BY 4.0] 发布，……」
 */
const RE_FILE_FOOTER = /^(##\s|正文按\s*\[?CC BY|本文档?按\s*\[?CC BY|.*\[MIT\]\(.*LICENSE)/;

/** 成本标签里五个键的中文名 → 内部字段名 */
const COST_KEYS = {
  钱: 'money',
  时间: 'time',
  毅力: 'will',
  收益: 'gain',
  口径: 'caliber',
};

/**
 * 解析「钱=0 时间=少 毅力=否 收益=大 口径=死亡率」这一串成本标签。
 * 无法识别的键值对会被忽略并记入 warnings，不让脏数据污染下游。
 *
 * @param {string} raw 注释里的原始串
 * @param {string[]} warnings 收集解析异常的数组（原地追加）
 * @returns {{money?:string,time?:string,will?:string,gain?:string,caliber?:string}}
 */
function parseCostTags(raw, warnings) {
  const out = {};
  for (const part of raw.split(/\s+/)) {
    const [key, value] = part.split('=');
    if (!key || !value) continue;
    const field = COST_KEYS[key.trim()];
    if (!field) {
      warnings.push(`未知的成本标签键：${key}`);
      continue;
    }
    out[field] = value.trim();
  }
  return out;
}

/**
 * 解析「来源」栏，拆成一条条带 URL 的引文。
 * 支持两种写法：尖括号 <https://x> 和 markdown 链接 [文字](https://x)。
 * 多条来源之间用 ` ; ` 或 ` ； ` 分隔。
 *
 * @param {string} text 来源栏正文
 * @returns {{text:string,url:string|null}[]}
 */
export function parseSources(text) {
  if (!text) return [];
  return text
    .split(/\s+[;；]\s+/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const md = chunk.match(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/);
      if (md) {
        return { text: (chunk.replace(md[0], md[1]) || md[1]).trim(), url: md[2] };
      }
      const angle = chunk.match(/<(https?:\/\/[^>\s]+)>/);
      if (angle) {
        return { text: chunk.replace(angle[0], '').trim(), url: angle[1] };
      }
      const bare = chunk.match(/https?:\/\/\S+/);
      if (bare) {
        return { text: chunk.replace(bare[0], '').trim(), url: bare[0].replace(/[)>,。]+$/, '') };
      }
      return { text: chunk, url: null };
    });
}

/**
 * 解析单个章节文件。
 *
 * @param {string} filePath 绝对路径
 * @param {string} raw 文件内容
 * @returns {{section:object, entries:object[], warnings:string[]}}
 */
export function parseSectionFile(filePath, raw) {
  const warnings = [];
  const lines = raw.split(/\r?\n/);

  let sectionNum = null;
  let sectionTitle = '';
  let introLines = [];
  let current = null;
  let inFooter = false;
  const entries = [];

  /** 把当前正在累积的条目收尾并入列 */
  const flush = () => {
    if (!current) return;
    const entry = finalizeEntry(current, sectionNum, sectionTitle, warnings);
    entries.push(entry);
    current = null;
  };

  for (const line of lines) {
    // 文件页脚之后的全部内容都不属于任何条目，直接跳过
    if (inFooter) continue;
    if (RE_FILE_FOOTER.test(line.trim())) {
      inFooter = true;
      continue;
    }

    const mSection = line.match(RE_SECTION_HEADING);
    // 只有 h3 才可能是条目标题，h1 是章节标题；h2 在源书里出现过一次，不参与结构
    if (mSection && !line.startsWith('## ')) {
      sectionNum = Number(mSection[1]);
      sectionTitle = mSection[2];
      continue;
    }

    const mEntry = line.match(RE_ENTRY_HEADING);
    if (mEntry) {
      flush();
      current = {
        num: Number(mEntry[1]),
        title: mEntry[2],
        costRaw: null,
        fields: {},
        extras: [],
      };
      continue;
    }

    if (!current) {
      // 还没进入第一条条目之前的内容都是节首引言
      if (line.trim()) introLines.push(line);
      continue;
    }

    const mCost = line.match(RE_COST_COMMENT);
    if (mCost) {
      current.costRaw = mCost[1];
      continue;
    }

    const mField = line.match(/^-\s*([^：:]{1,12})\s*[：:]\s*(.*)$/);
    if (mField) {
      const key = mField[1].trim();
      const value = mField[2].trim();
      // 同名键重复出现时用换行拼接，不丢内容
      current.fields[key] = current.fields[key] ? `${current.fields[key]}\n${value}` : value;
      continue;
    }

    if (line.trim()) current.extras.push(line.trim());
  }
  flush();

  const section = {
    num: sectionNum,
    title: sectionTitle,
    file: filePath,
    intro: introLines.join('\n').trim(),
  };

  return { section, entries, warnings };
}

/**
 * 把原始条目对象转成规范结构：补出处引用、性价比、来源列表。
 *
 * @param {object} raw 累积中的原始条目
 * @param {number|null} sectionNum 所属节号
 * @param {string} sectionTitle 所属节名
 * @param {string[]} warnings 异常收集
 */
function finalizeEntry(raw, sectionNum, sectionTitle, warnings) {
  const f = raw.fields;
  for (const key of ['成本', '说人话', '收益', '证据等级', '来源', '备注']) {
    if (f[key] === undefined) warnings.push(`第 ${sectionNum} 节第 ${raw.num} 条缺少「${key}」栏`);
  }

  const cost = raw.costRaw ? parseCostTags(raw.costRaw, warnings) : {};
  if (!raw.costRaw) warnings.push(`第 ${sectionNum} 节第 ${raw.num} 条缺少成本标签注释`);

  const grade = (f['证据等级'] || '').trim().charAt(0).toUpperCase() || null;
  if (grade && !'ABC'.includes(grade)) {
    warnings.push(`第 ${sectionNum} 节第 ${raw.num} 条证据等级异常：${f['证据等级']}`);
  }

  const text = [raw.title, f['说人话'], f['收益'], f['备注'], f['成本']].filter(Boolean).join('\n');
  const refs = [];
  for (const m of text.matchAll(RE_REF)) {
    refs.push({ section: Number(m[1]), num: Number(m[2]) });
  }

  return {
    id: `S${String(sectionNum).padStart(2, '0')}E${String(raw.num).padStart(3, '0')}`,
    section: sectionNum,
    sectionTitle,
    num: raw.num,
    ref: `第 ${sectionNum} 节第 ${raw.num} 条`,
    title: raw.title,
    cost,
    ratio: computeRatio(cost),
    grade,
    costText: f['成本'] ?? '',
    plain: f['说人话'] ?? '',
    gain: f['收益'] ?? '',
    note: f['备注'] ?? '',
    sources: parseSources(f['来源'] ?? ''),
    sourceText: f['来源'] ?? '',
    crossRefs: refs,
    // extras 保存解析器没归类的正文行，正常情况下应为空；非空说明源文格式变了
    extras: raw.extras,
  };
}

/**
 * 读取整个 data/source 目录，解析全部章节。
 *
 * @param {string} sourceDir data/source 的绝对路径
 * @returns {{sections:object[], entries:object[], warnings:string[]}}
 */
export function parseBook(sourceDir) {
  const files = readdirSync(sourceDir)
    .filter((name) => name.endsWith('.md'))
    .sort();

  const sections = [];
  const entries = [];
  const warnings = [];

  for (const name of files) {
    const filePath = join(sourceDir, name);
    const raw = readFileSync(filePath, 'utf8');
    const parsed = parseSectionFile(filePath, raw);
    parsed.section.file = name;
    sections.push(parsed.section);
    entries.push(...parsed.entries);

    for (const w of parsed.warnings) warnings.push(`${name}: ${w}`);
    for (const e of parsed.entries) {
      if (e.extras.length) warnings.push(`${name}: 第 ${e.num} 条有 ${e.extras.length} 行未归类正文`);
    }
  }

  return { sections, entries, warnings };
}
