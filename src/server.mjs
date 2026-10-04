#!/usr/bin/env node
/**
 * 本地网页服务（零依赖）。
 *
 * 用法：npm run serve   （或 node src/server.mjs --port 5173）
 *
 * 只监听回环地址：这本书的检索不需要联网，也不该被同网段的其他机器访问。
 *
 * 路由：
 *   GET /                 网页界面
 *   GET /app.js /style.css  静态资源
 *   GET /api/ask?q=问题&limit=8   提问，返回结构化结果
 *   GET /api/browse?domain=健康   按标签浏览
 *   GET /api/meta          可用的标签取值，供界面生成筛选器
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { loadLocalEngine } from './node/load-local.mjs';
import { SORT_KEYS } from './search/sort.mjs';
import { buildMeta, toAskPayload } from './shared/client-payload.mjs';

const ROOT = join(import.meta.dirname, '..');
const WEB_DIR = join(ROOT, 'web');

/** 静态资源的 MIME 类型；未列出的按二进制流返回 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** 单个响应体的上限，防止有人构造超大请求把内存吃满 */
const MAX_URL_LENGTH = 2048;

/**
 * 解析命令行参数。
 *
 * @param {string[]} argv process.argv.slice(2)
 * @returns {{port:number, host:string}}
 */
function parseArgs(argv) {
  let port = 5173;
  let host = '127.0.0.1';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') port = Number(argv[++i]) || 5173;
    else if (argv[i] === '--host') host = argv[++i] ?? '127.0.0.1';
  }
  return { port, host };
}

/**
 * 统一发送 JSON 响应。
 *
 * @param {import('node:http').ServerResponse} res 响应对象
 * @param {number} status HTTP 状态码
 * @param {any} body 响应体
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

/**
 * 发送静态文件。做了路径穿越检查：解析后的绝对路径必须仍在 web/ 目录里。
 *
 * @param {import('node:http').ServerResponse} res 响应对象
 * @param {string} urlPath 请求路径
 */
async function sendStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const full = normalize(join(WEB_DIR, rel));

  if (!full.startsWith(WEB_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const info = await stat(full);
    if (!info.isFile()) throw new Error('not a file');
    const data = await readFile(full);
    res.writeHead(200, {
      'Content-Type': MIME[extname(full)] ?? 'application/octet-stream',
      'Content-Length': data.length,
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
  }
}

function main() {
  const { port, host } = parseArgs(process.argv.slice(2));

  const book = loadLocalEngine();
  // 元信息与结果格式都由 src/shared/client-payload.mjs 定义，
  // 纯静态模式用的是同一份，两边不会漂移
  const meta = buildMeta(book);

  const server = createServer(async (req, res) => {
    if (req.url.length > MAX_URL_LENGTH) {
      res.writeHead(414).end('URI Too Long');
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    try {
      if (url.pathname === '/api/meta') {
        sendJson(res, 200, meta);
        return;
      }

      if (url.pathname === '/api/ask') {
        const q = (url.searchParams.get('q') ?? '').slice(0, 500).trim();
        // 上限放到 100：界面要支持「看到所有相关的」，默认给 12 条只是首屏的量
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 12, 1), 100);
        const sortParam = url.searchParams.get('sort') ?? 'relevance';
        const sort = SORT_KEYS.has(sortParam) ? sortParam : 'relevance';

        if (!q) {
          sendJson(res, 400, { error: '缺少参数 q' });
          return;
        }

        const r = book.ask(q, { limit, sort });
        sendJson(res, 200, {
          question: q,
          ...toAskPayload(r),
        });
        return;
      }

      if (url.pathname === '/api/browse') {
        const filter = {};
        for (const key of ['domain', 'age', 'gender', 'topic', 'audience', 'grade', 'ratio']) {
          const v = url.searchParams.get(key);
          if (v) filter[key] = v;
        }
        const hits = book.browse(filter);
        sendJson(res, 200, { filter, count: hits.length, entries: hits.slice(0, 200).map((e) => ({
          id: e.id, ref: e.ref, title: e.title, grade: e.grade, ratio: e.ratio, tags: e.tags,
        })) });
        return;
      }

      await sendStatic(res, url.pathname);
    } catch (err) {
      console.error('请求处理失败：', err);
      sendJson(res, 500, { error: '服务器内部错误' });
    }
  });

  server.listen(port, host, () => {
    console.log(`答案之书已启动： http://${host}:${port}`);
    console.log(`已加载 ${book.entries.length} 条 / ${book.sections.length} 节`);
    console.log('按 Ctrl+C 停止');
  });
}

main();
