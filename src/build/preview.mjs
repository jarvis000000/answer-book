#!/usr/bin/env node
/**
 * 静态产物的本地预览服务。
 *
 * 用法：npm run build:static && npm run preview
 *
 * 为什么需要它：静态模式靠 fetch 读 data/*.json，
 * 而浏览器会拦掉 file:// 下的 fetch（同源策略），所以直接双击 dist/index.html 是打不开的。
 * 这个服务只做一件事——把 dist/ 用 http 发出去，模拟静态托管的真实环境。
 *
 * **它不是线上用的东西**。真实部署时由 GitHub Pages 这类静态托管直接发文件，
 * 不需要任何进程。这里只是本地验收用。
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { ROOT } from '../node/load-local.mjs';

const DIST = join(ROOT, 'dist');

/**
 * MIME 类型。.mjs 必须是 javascript，否则浏览器会拒绝执行 module 脚本——
 * 这是静态化里最容易踩的坑之一，本地预览就是为了提前撞上它。
 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function main() {
  const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 8080;

  // 先确认产物在，报错要能直接告诉人家跑哪条命令
  if (!existsSync(join(DIST, 'index.html'))) {
    console.error('还没构建过静态产物，请先运行：npm run build:static');
    process.exitCode = 1;
    return;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const full = normalize(join(DIST, rel));

    // 路径穿越检查：解析后的绝对路径必须仍在 dist/ 里
    if (!full.startsWith(DIST)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    try {
      const info = await stat(full);
      const target = info.isDirectory() ? join(full, 'index.html') : full;
      const data = await readFile(target);
      res.writeHead(200, {
        'Content-Type': MIME[extname(target)] ?? 'application/octet-stream',
        'Content-Length': data.length,
      });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`静态产物预览： http://127.0.0.1:${port}`);
    console.log('这一页没有服务端参与，检索全在浏览器里跑');
    console.log('按 Ctrl+C 停止');
  });
}

main();
