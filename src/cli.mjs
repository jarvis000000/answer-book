#!/usr/bin/env node
/**
 * 命令行入口。
 *
 * 用法：
 *   node src/cli.mjs "我是一个 45 岁女性，我需要注意哪些身体健康方面的问题"
 *   node src/cli.mjs --limit 5 "幽门螺杆菌要不要查"
 *   node src/cli.mjs --json "被裁员了能拿多少钱"      # 机读输出，方便接别的程序
 *   node src/cli.mjs                                  # 不带参数进入交互模式
 *   node src/cli.mjs --browse domain=健康              # 按标签浏览
 *
 * 退出码：0 正常；1 参数或数据错误；2 没有匹配结果。
 */

import { createInterface } from 'node:readline';
import { loadLocalEngine } from './node/load-local.mjs';

/** ANSI 颜色；--no-color 或管道输出时全部退化为空串 */
function makePalette(enabled) {
  const wrap = (code) => (s) => (enabled ? `\u001b[${code}m${s}\u001b[0m` : String(s));
  return {
    dim: wrap('2'),
    bold: wrap('1'),
    red: wrap('31'),
    green: wrap('32'),
    yellow: wrap('33'),
    blue: wrap('36'),
    gray: wrap('90'),
  };
}

/**
 * 解析命令行参数。
 * 不引第三方库——参数就这么几个，自己解析比装依赖更可控。
 *
 * @param {string[]} argv process.argv.slice(2)
 * @returns {{question:string, limit:number, json:boolean, color:boolean, browse:object|null, help:boolean}}
 */
function parseArgs(argv) {
  const out = { question: '', limit: 6, json: false, color: true, browse: null, help: false };
  const words = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') out.limit = Number(argv[++i]) || 6;
    else if (a === '--json') out.json = true;
    else if (a === '--no-color') out.color = false;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--browse') out.browse = parseBrowse(argv[++i] ?? '');
    else words.push(a);
  }

  out.question = words.join(' ').trim();
  // 输出被重定向时自动去掉颜色，避免日志里塞满转义符
  if (!process.stdout.isTTY) out.color = false;
  return out;
}

/**
 * 解析 `--browse` 的键值对写法，如 `domain=健康` 或 `age=老年,gender=female`。
 *
 * @param {string} spec 参数字符串
 * @returns {object} 过滤条件
 */
function parseBrowse(spec) {
  const filter = {};
  for (const pair of spec.split(',')) {
    const [k, v] = pair.split('=');
    if (k && v) filter[k.trim()] = v.trim();
  }
  return filter;
}

const HELP = `答案之书 · 命令行用法

  node src/cli.mjs "你的问题"            提问，默认返回 6 条
  node src/cli.mjs --limit 10 "问题"     指定返回条数
  node src/cli.mjs --json "问题"         输出 JSON，便于程序调用
  node src/cli.mjs --no-color "问题"     关闭彩色输出
  node src/cli.mjs                       进入交互模式，逐条提问
  node src/cli.mjs --browse domain=健康  按标签浏览

  --browse 支持的键：domain / age / gender / topic / audience / grade / ratio
  可用取值见 data/taxonomy.json，或跑 node src/cli.mjs --browse domain=健康 试。

  答案来自《高性价比人生指南》（CC BY 4.0），只做检索、不改写原文。`;

/**
 * 渲染单条结果。
 *
 * @param {object} item rank 产物
 * @param {number} idx 序号（从 1 开始）
 * @param {object} c 调色板
 * @returns {string} 多行文本
 */
function renderResult(item, idx, c) {
  const e = item.entry;
  const lines = [];

  lines.push(
    `${c.bold(idx + '.')} ${c.blue(e.ref)} ${c.bold(e.title)}`
  );
  lines.push(
    `   ${c.gray(`[证据 ${e.grade ?? '?'} 级 · 性价比 ${e.ratio} · 口径 ${e.cost?.caliber ?? '—'}]`)}`
  );
  if (e.plain) lines.push(`   ${c.green('说人话')}  ${e.plain}`);
  lines.push(`   ${c.gray('标签')}    ${formatTags(e.tags)}`);
  lines.push(`   ${c.gray('为什么')}  ${item.reasons.join(' · ') || '关键词与标签的常规匹配'}`);
  return lines.join('\n');
}

/**
 * 把标签对象压成一行可读文本。
 *
 * @param {object} tags 条目标签
 * @returns {string}
 */
function formatTags(tags) {
  const genderText = { female: '女性专属', male: '男性专属', any: '不限性别' }[tags.gender] ?? tags.gender;
  const parts = [
    tags.ages.join('/'),
    genderText,
    tags.domains.slice(0, 4).join('/'),
  ];
  if (tags.topics.length) parts.push('主题：' + tags.topics.slice(0, 3).join('/'));
  if (tags.audiences.length) parts.push('人群：' + tags.audiences.slice(0, 2).join('/'));
  return parts.filter(Boolean).join(' · ');
}

/**
 * 把一次 ask() 的结果渲染成终端文本。
 *
 * @param {object} result engine.ask 的返回
 * @param {object} c 调色板
 * @param {string} question 原问题
 * @returns {string}
 */
function renderAnswer(result, c, question) {
  const out = [];

  if (result.safety) out.push(`${c.red('⚠ ' + result.safety)}\n`);

  out.push(`${c.gray('问题')}  ${question}`);
  out.push(`${c.gray('理解')}  年龄 ${result.query.ages.bands.join('/') || '未提到'} · 性别 ${result.query.gender} · ` +
    `领域 ${result.query.domains.join('/') || '未识别'}${result.query.topics.length ? ' · 主题 ' + result.query.topics.join('/') : ''}`);
  out.push(`${c.gray('命中')}  ${result.totalCandidates} 条候选，展示前 ${result.results.length} 条\n`);

  if (!result.results.length) {
    out.push('没有找到相关条目。换个说法再试，或者用 --browse 按标签浏览。');
    return out.join('\n');
  }

  result.results.forEach((item, i) => {
    out.push(renderResult(item, i + 1, c));
    out.push('');
  });

  out.push(c.gray('答案正文来自《高性价比人生指南》(github.com/eternity4719/HowToLiveBetter)，CC BY 4.0。'));
  out.push(c.gray('通用口径，不替代医生、律师、会计。'));
  return out.join('\n');
}

/**
 * 交互模式：逐行读取问题，输入 exit / quit / 空行退出。
 *
 * @param {object} book 检索引擎
 * @param {object} options 参数
 */
async function interactive(book, options) {
  const c = makePalette(options.color);
  console.log(c.bold('答案之书 · 交互模式'));
  console.log(c.gray('直接输入问题回车；输入 exit 退出。\n'));

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

  for (;;) {
    const q = (await ask(c.blue('问> '))).trim();
    if (!q || ['exit', 'quit', 'q'].includes(q.toLowerCase())) break;

    const result = book.ask(q, { limit: options.limit });
    console.log('\n' + renderAnswer(result, c, q) + '\n');
  }

  rl.close();
  console.log(c.gray('再见喵～'));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const c = makePalette(options.color);

  if (options.help) {
    console.log(HELP);
    return;
  }

  let book;
  try {
    book = loadLocalEngine();
  } catch (err) {
    console.error(c.red(err.message));
    process.exitCode = 1;
    return;
  }

  // 按标签浏览
  if (options.browse) {
    const hits = book.browse(options.browse);
    if (options.json) {
      console.log(JSON.stringify(hits, null, 2));
      return;
    }
    console.log(c.gray(`筛选条件 ${JSON.stringify(options.browse)}，命中 ${hits.length} 条\n`));
    hits.slice(0, options.limit * 3).forEach((e, i) => {
      console.log(renderResult({ entry: e, reasons: [] }, i + 1, c));
      console.log('');
    });
    return;
  }

  // 没有提问就进交互模式
  if (!options.question) {
    await interactive(book, options);
    return;
  }

  const result = book.ask(options.question, { limit: options.limit });

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          question: options.question,
          query: result.query,
          safety: result.safety,
          results: result.results.map((r) => ({
            ref: r.entry.ref,
            id: r.entry.id,
            title: r.entry.title,
            plain: r.entry.plain,
            gain: r.entry.gain,
            note: r.entry.note,
            grade: r.entry.grade,
            ratio: r.entry.ratio,
            cost: r.entry.cost,
            tags: r.entry.tags,
            sources: r.entry.sources,
            score: Number(r.score.toFixed(4)),
            reasons: r.reasons,
          })),
        },
        null,
        2
      )
    );
    return;
  }

  console.log(renderAnswer(result, c, options.question));
  if (!result.results.length) process.exitCode = 2;
}

main();
