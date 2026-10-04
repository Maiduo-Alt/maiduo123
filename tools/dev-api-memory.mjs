#!/usr/bin/env node
/** 启动 API 服务（内存数据库模式），用于本机在没有 PostgreSQL 的环境下直接体验系统。 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'backend', 'dist', 'main.js');

if (!fs.existsSync(entry)) {
  console.error('未找到编译产物，请先执行: npm run build -w backend');
  process.exit(1);
}

console.log('启动 API 服务（内存数据库模式，数据在进程退出后清空）...');
const child = spawn(process.execPath, [entry], {
  cwd: path.join(root, 'backend'),
  env: { ...process.env, USE_PG_MEM: 'true', PORT: process.env.PORT || '3000' },
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 0));
