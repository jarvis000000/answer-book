#!/usr/bin/env node
/**
 * 跨平台跑测试。
 *
 * 为什么不在 npm script 里直接写通配符 `test/*.test.mjs`：
 *   ① Node 21 之前不接受把 glob 交给 `--test` 自己展开；
 *   ② 各平台 shell 的展开行为还不一样——`test/*.test.mjs` 在 bash 里会被展开成文件列表，
 *      在 Windows 的 cmd 里原样传进去。
 * 两者叠加的结果就是「本地全绿、推上 CI 挂」（或者反过来），
 * 而且报错是 `Could not find '…/test/*.test.mjs'`，看半天不知道在说什么。
 *
 * 所以自己列文件：readdir 一次，把目录下所有 *.test.mjs 交给 node --test。
 * 新增测试文件不用改任何配置。
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = import.meta.dirname;
const files = readdirSync(dir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => join(dir, name));

if (!files.length) {
  console.error(`在 ${dir} 下没有找到任何 *.test.mjs`);
  process.exit(1);
}

// 用 process.execPath 而不是字面量 'node'：
// 确保跑的是当前这个 Node，而不是 PATH 里可能存在的另一个版本
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });

// spawnSync 在子进程被信号杀死时 status 为 null，这时按失败处理
process.exit(result.status ?? 1);
