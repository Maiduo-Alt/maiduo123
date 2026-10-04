#!/usr/bin/env node
/**
 * 前端本地体验服务：把 frontend/dist 静态托管，并把 /api、/realtime 代理到后端。
 *
 * 为什么需要它：前端是 SPA，直接双击 dist/index.html（file://）跑不起来——
 * 它要用相对路径调 /api 与 WebSocket 实时通道。这个脚本零依赖（只用 node 内置模块），
 * 一条命令就能在任意装了 Node 的机器上把界面跑起来。
 *
 * 用法：
 *   node tools/serve-web.mjs                       # 默认：托管 frontend/dist，后端 127.0.0.1:3000
 *   node tools/serve-web.mjs --port=8080           # 换端口
 *   node tools/serve-web.mjs --dist=D:/web --api=http://192.168.1.10:3000   # 换目录/换后端
 *
 * 打开：http://127.0.0.1:<port>/   （账号 admin/Admin@123、leader/Leader@123、agent/Agent@123）
 */
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => (process.argv.find((item) => item.startsWith(`--${name}=`)) || '').split('=')[1] || fallback;

const PORT = Number(arg('port', process.env.WEB_PORT || 8080));
const HOST = arg('host', process.env.WEB_HOST || '127.0.0.1');
const DIST = path.resolve(arg('dist', process.env.WEB_DIST || path.join(root, 'frontend', 'dist')));
const API = new URL(arg('api', process.env.WEB_API || 'http://127.0.0.1:3000'));

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error(`找不到前端产物：${DIST}\\index.html`);
  console.error('先构建一次：cd frontend && node ../node_modules/vite/bin/vite.js build');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** 把请求转发给后端（含 SSE/WebSocket 需要的流式透传）。 */
function proxy(req, res, body) {
  const upstream = http.request(
    {
      hostname: API.hostname,
      port: API.port || 80,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `${API.hostname}:${API.port || 80}` },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    }
  );
  upstream.on('error', (error) => {
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ code: 502, message: `后端不可达：${error.message}（先启动 API 服务）`, data: null }));
  });
  if (body && body.length) upstream.write(body);
  upstream.end();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  // 接口与实时通道交给后端（实时通道的握手走 upgrade，见下面）
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/realtime') || url.pathname.startsWith('/uploads')) {
    if (req.method === 'GET' || req.method === 'HEAD') return proxy(req, res);
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => proxy(req, res, Buffer.concat(chunks)));
    return;
  }

  // 静态资源 + SPA 兜底（找不到文件就回 index.html，交给前端路由）
  const safePath = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = path.join(DIST, safePath);
  if (!file.startsWith(DIST)) file = path.join(DIST, 'index.html');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    const candidate = path.join(DIST, safePath, 'index.html');
    file = fs.existsSync(candidate) ? candidate : path.join(DIST, 'index.html');
  }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

// WebSocket（socket.io 走 /realtime）：直接 TCP 转发，避免引入 ws 依赖
server.on('upgrade', (req, socket, head) => {
  if (!String(req.url || '').startsWith('/realtime')) {
    socket.destroy();
    return;
  }
  const upstream = net.connect(Number(API.port) || 80, API.hostname, () => {
    const headers = Object.entries({ ...req.headers, host: `${API.hostname}:${API.port || 80}` })
      .map(([key, value]) => `${key}: ${value}`)
      .join('\r\n');
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
});

server.listen(PORT, HOST, () => {
  console.log(`界面已启动：http://${HOST}:${PORT}/`);
  console.log(`静态目录：${DIST}`);
  console.log(`后端代理：/api、/realtime、/uploads → ${API.origin}`);
  console.log('账号：admin / Admin@123（管理员）、leader / Leader@123（带教）、agent / Agent@123（客服）');
  console.log('如果页面能开但接口报错，说明后端没起来：先跑 node tools/dev-api-memory.mjs 或 docker compose up -d');
});
