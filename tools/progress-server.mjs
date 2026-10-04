#!/usr/bin/env node
/**
 * 验收进度看板服务：把 docs/验收看板.html 与实时核查结果（docs/验收进度.json）提供出来。
 *
 * 用法：npm run progress:serve   → 打开 http://127.0.0.1:4180
 *
 * 每次 /api/progress 请求都会重新核查（默认缓存 3 秒，refresh=1 强制重跑），
 * 所以页面上的数字始终是「当前代码库」的真实状态，改完代码不需要重启。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAudit } from './acceptance-audit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PROGRESS_PORT || 4180);
const HOST = process.env.PROGRESS_HOST || '127.0.0.1';
const CACHE_MS = 3000;

let cache = { at: 0, data: null };

function progressData(force) {
  const now = Date.now();
  if (!force && cache.data && now - cache.at < CACHE_MS) return cache.data;
  const started = Date.now();
  const data = runAudit();
  data.durations = { auditMs: Date.now() - started, cacheMs: CACHE_MS };
  cache = { at: now, data };
  // 顺手落盘，方便命令行或其它工具读取
  try {
    fs.writeFileSync(path.join(root, 'docs/验收进度.json'), JSON.stringify(data, null, 2));
  } catch {
    /* 落盘失败不影响看板 */
  }
  return data;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  if (url.pathname === '/api/progress') {
    try {
      const data = progressData(url.searchParams.get('refresh') === '1');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(data));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  const file = url.pathname === '/' || url.pathname === '/index.html' ? 'docs/验收看板.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const target = path.join(root, file);
  if (!target.startsWith(root) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
    return;
  }
  const type = target.endsWith('.html') ? 'text/html; charset=utf-8' : target.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(fs.readFileSync(target));
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`验收进度看板已启动：http://${HOST}:${PORT}\n`);
  process.stdout.write('页面每 5 秒自动重新核查一次，改完代码直接刷新看数字即可。\n');
});
