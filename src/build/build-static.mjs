/**
 * 静态构建：产出一个可以整个丢到 GitHub Pages / 任意静态托管上的 dist/。
 *
 * 用法：npm run build:static
 *
 * 和本地服务的区别只有一处——**检索跑在哪**。
 * 本地服务是 Node 进程现场算；静态托管没有进程，所以把同一份检索代码
 * （src/search/ 下的模块本来就是环境无关的）连同数据一起发给浏览器，
 * 由浏览器现场建索引。于是这里做的事只有三件：准备数据、拷前端、打标记。
 *
 * 产物结构：
 *   dist/index.html · app.js · style.css · data-source.mjs
 *   dist/vendor/…    检索内核（从 src/ 原样拷贝，不打包不改写）
 *   dist/data/…      条目、词表、同义词、节信息、元信息
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import { loadLocalEngine, ROOT } from '../node/load-local.mjs';
import { buildMeta } from '../shared/client-payload.mjs';
import { createEngine } from '../search/engine.mjs';

const DIST = join(ROOT, 'dist');

/**
 * 检索内核要用到的源文件。整份拷过去而不是打包：
 * 这些模块本来就是标准 ES module、零依赖，浏览器能直接 import，
 * 中间加一层打包器只会多出一个看不见的东西要维护。
 */
const VENDOR_FILES = [
  'src/search/tokenize.mjs',
  'src/search/index.mjs',
  'src/search/parse-query.mjs',
  'src/search/rank.mjs',
  'src/search/sort.mjs',
  'src/search/engine.mjs',
  'src/shared/cost.mjs',
  'src/shared/client-payload.mjs',
  'src/llm/adapter.mjs',
];

/**
 * 前端不需要的字段。
 *
 * sourceText 是来源栏的原始字符串，和解析好的 sources 数组重复；
 * crossRefs / extras / overridden 是构建期和排查用的，界面上没有出口。
 * 657 条加起来这些占了不小体积，静态托管下就是实打实的下载量。
 *
 * 注意：**删字段前先看 src/search/engine.mjs 的 bodyOf()**——
 * 那里列出的字段都参与建索引，删掉会让静态模式和本地服务算出不同的结果。
 * 构建末尾的索引一致性自检就是拦这件事的。
 */
const DROP_FIELDS = ['sourceText', 'crossRefs', 'extras', 'overridden'];

/**
 * 瘦身：去掉前端用不到的字段。
 *
 * @param {object} entry 条目
 * @returns {object} 精简后的条目
 */
function slim(entry) {
  const out = { ...entry };
  for (const f of DROP_FIELDS) delete out[f];
  return out;
}

/**
 * 读一个 JSON 文件（同义词这类原样透传的小文件用）。
 *
 * @param {string} rel 相对项目根
 * @returns {any}
 */
function readJson(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
}

/**
 * 递归拷贝目录。
 *
 * **刻意不用 fs.cpSync**：在本机沙箱环境里，它会让 node 进程被直接终止——
 * 退出码 127、stdout/stderr 一个字都没有，看起来像脚本根本没跑。
 * 换成 readdir + readFile + writeFile 逐项走一遍，全是普通文件操作，
 * 行为可预期，出问题也能看到是哪一步。
 *
 * @param {string} src 源目录
 * @param {string} dest 目标目录
 * @returns {number} 拷贝的文件数
 */
function copyTree(src, dest) {
  mkdirSync(dest, { recursive: true });
  let count = 0;

  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) {
      count += copyTree(from, to);
    } else {
      writeFileSync(to, readFileSync(from));
      count++;
    }
  }

  return count;
}

/**
 * 写 JSON，并报告原始与 gzip 后的体积。
 * 静态托管会自己压 gzip，所以真正决定用户下载量的是压缩后那一列。
 *
 * @param {string} relPath 相对 dist/ 的路径
 * @param {any} data 内容
 * @returns {{raw:number, gz:number}} 字节数
 */
function writeJson(relPath, data) {
  const buf = Buffer.from(JSON.stringify(data), 'utf8');
  const path = join(DIST, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buf);
  return { raw: buf.length, gz: gzipSync(buf).length };
}

/**
 * 把 web/ 下的前端资源拷进 dist/，并把绝对路径改成相对路径、注入静态标记。
 *
 * 改路径是必须的：GitHub Pages 的项目站点部署在 /<仓库名>/ 子路径下，
 * `/style.css` 会被解析到域名根目录，直接 404。
 *
 * @returns {{html:number, css:number, js:number, dataSource:number}}
 */
function buildFrontend() {
  copyTree(join(ROOT, 'web'), DIST);

  const htmlPath = join(DIST, 'index.html');
  const html = readFileSync(htmlPath, 'utf8')
    .replace('href="/style.css"', 'href="./style.css"')
    .replace(
      '<script src="/app.js"></script>',
      // 顺序有意义：data-source 先跑并把数据源挂到 window，app 再跑并 await 它。
      // 两个都是 module（默认 defer），文档顺序即执行顺序。
      '<script type="module" src="./data-source.mjs"></script>\n' +
        '<script>window.__ANSWER_BOOK_STATIC__ = true;</script>\n' +
        '<script type="module" src="./app.js"></script>'
    );
  writeFileSync(htmlPath, html, 'utf8');

  const size = (f) => statSync(join(DIST, f)).size;
  return { html: size('index.html'), css: size('style.css'), js: size('app.js'), dataSource: size('data-source.mjs') };
}

/**
 * 把检索内核从 src/ 拷进 dist/vendor/，保持相对目录结构。
 * 这些文件之间用相对路径互相 import，整体搬过去就能直接跑。
 *
 * @returns {number} 拷贝的模块数
 */
function copyVendor() {
  for (const rel of VENDOR_FILES) {
    const dest = join(DIST, 'vendor', relative('src', rel));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(join(ROOT, rel)));
  }
  return VENDOR_FILES.length;
}

/**
 * 自检：拿瘦身后的数据重建一次索引，跑几个查询，与完整数据逐条比对。
 *
 * 这是静态化最容易出错的地方——少拷一个参与建索引的字段，BM25 算出来的分就变了，
 * 但页面照样能跑、看上去一切正常，只有搜索结果悄悄变差。
 * 所以在构建期直接比出来，比发到线上再发现要好。
 *
 * @param {object[]} slimEntries 瘦身后的条目
 * @param {object} reference 完整数据的引擎，用来取 taxonomy / sections
 * @returns {{ok:boolean, count:number, mismatched:string[]}}
 */
function verifyIndexParity(slimEntries, reference) {
  const slimBook = createEngine({
    entries: slimEntries,
    sections: reference.sections,
    // 深拷一份：createEngine 会就地剥掉下划线开头的注释键，不能污染原对象
    taxonomy: JSON.parse(JSON.stringify(reference.taxonomy)),
    synonyms: readJson('data/synonyms.json'),
  });

  const probes = [
    '我是一个45岁女性，我需要注意哪些身体健康方面的问题',
    '一个6岁儿童有哪些建议和指南',
    '幽门螺杆菌要不要查',
    '家里老人总是摔跤怎么办',
    '被公司裁员了能拿多少钱',
    '租房押金不退怎么办',
    '孩子被同学欺负了怎么办',
  ];

  const mismatched = [];
  let count = 0;

  for (const q of probes) {
    const ids = (book) => book.ask(q, { limit: 100, sort: 'relevance' }).results.map((r) => r.entry.id).join(',');
    const full = ids(reference);
    const slimIds = ids(slimBook);
    count += full ? full.split(',').length : 0;
    if (full !== slimIds) mismatched.push(q);
  }

  return { ok: mismatched.length === 0, count, mismatched };
}

function main() {
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  const book = loadLocalEngine();
  const entries = book.entries.map(slim);

  const sizes = {
    条目: writeJson('data/entries.json', entries),
    词表: writeJson('data/taxonomy.json', book.taxonomy),
    同义词: writeJson('data/synonyms.json', readJson('data/synonyms.json')),
    节信息: writeJson('data/sections.json', book.sections.map((s) => ({ num: s.num, title: s.title }))),
    元信息: writeJson('data/meta.json', buildMeta(book)),
  };

  const front = buildFrontend();
  const vendorCount = copyVendor();
  // GitHub Pages 默认走 Jekyll，下划线开头的文件会被它吃掉；.nojekyll 关掉这层处理
  writeFileSync(join(DIST, '.nojekyll'), '');

  const check = verifyIndexParity(entries, book);

  // —— 报告 ——
  const kb = (n) => (n / 1024).toFixed(1).padStart(7);
  console.log('静态构建完成 → dist/\n');
  console.log('数据                     原始       gzip');
  for (const [name, s] of Object.entries(sizes)) {
    console.log(`  ${name.padEnd(8)} ${kb(s.raw)} KB ${kb(s.gz)} KB`);
  }

  console.log(
    `\n前端  index.html ${(front.html / 1024).toFixed(1)} KB · ` +
      `style.css ${(front.css / 1024).toFixed(1)} KB · ` +
      `app.js ${(front.js / 1024).toFixed(1)} KB · ` +
      `data-source.mjs ${(front.dataSource / 1024).toFixed(1)} KB`
  );
  console.log(`检索内核 ${vendorCount} 个模块（零依赖，浏览器直接 import）`);

  const jsonGz = Object.values(sizes).reduce((a, s) => a + s.gz, 0);
  const jsonRaw = Object.values(sizes).reduce((a, s) => a + s.raw, 0);
  console.log(
    `\n打开页面要下载的 JSON：${(jsonRaw / 1024).toFixed(0)} KB（gzip 后 ${(jsonGz / 1024).toFixed(0)} KB），` +
      `加上静态资源约 ${((jsonGz + front.css + front.js + front.dataSource) / 1024).toFixed(0)} KB`
  );

  if (!check.ok) {
    console.error(`\n✗ 索引一致性自检未通过，以下查询在两种数据下结果不同：`);
    for (const q of check.mismatched) console.error(`    ${q}`);
    console.error('  多半是 DROP_FIELDS 裁掉了参与建索引的字段，请核对后重新构建。');
    process.exitCode = 1;
    return;
  }
  console.log(`\n✓ 索引一致性自检通过：7 个查询共 ${check.count} 条候选，与服务端逐条一致`);
}

main();
