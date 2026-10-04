#!/usr/bin/env node
/**
 * 打上线包（方案 5.10 部署用）：把「服务器上构建镜像需要的东西」打成一个 zip，方便上传。
 *
 * 用法：
 *   node tools/make-release.mjs                 # 输出到 release/在线模拟接待训练系统-<日期>.zip
 *   node tools/make-release.mjs --out=D:\tmp    # 换输出目录
 *
 * 包含：compose、两个 Dockerfile、deploy/（nginx 与上线清单）、backend/ 与 frontend/ 源码、
 *       根 package.json/package-lock.json（镜像里用 npm 安装依赖）。
 * 不含：node_modules、dist（服务器上镜像内重新构建）、backups、release 自身、临时文件。
 *
 * 依赖：只用 Node 内置能力（zlib + 手写 zip 目录），不装任何第三方包。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = (process.argv.find((a) => a.startsWith('--out=')) || '').split('=')[1] || path.join(root, 'release');
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const zipPath = path.join(outDir, `在线模拟接待训练系统-${stamp}.zip`);

/** 打进包里的文件/目录（相对仓库根） */
const INCLUDE_FILES = ['docker-compose.yml', 'render.yaml', 'package.json', 'package-lock.json'];
const INCLUDE_DIRS = ['deploy', 'backend', 'frontend', 'docs', 'tools'];
/** 排除规则：目录名或文件名命中就跳过 */
const EXCLUDE = new Set(['node_modules', 'dist', 'release', 'backups', '.git', '_handoff', '截图']);
const EXCLUDE_EXT = new Set(['.log', '.zip', '.tmp']);

const files = [];
const addFile = (rel) => files.push(rel);
const walk = (relDir) => {
  for (const entry of fs.readdirSync(path.join(root, relDir), { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name)) continue;
    const rel = path.join(relDir, entry.name);
    if (entry.isDirectory()) walk(rel);
    else if (!EXCLUDE_EXT.has(path.extname(entry.name).toLowerCase())) addFile(rel);
  }
};
INCLUDE_FILES.forEach((rel) => {
  if (fs.existsSync(path.join(root, rel))) addFile(rel);
});
INCLUDE_DIRS.forEach((rel) => {
  if (fs.existsSync(path.join(root, rel))) walk(rel);
});

/* ---------- 手写 zip（store + deflate 两种都用，简单可靠） ---------- */

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

const chunks = [];
const central = [];
let offset = 0;

for (const rel of files.sort()) {
  const nameBuf = Buffer.from(rel.split(path.sep).join('/'), 'utf8');
  const raw = fs.readFileSync(path.join(root, rel));
  const deflated = zlib.deflateRawSync(raw, { level: 9 });
  const useDeflate = deflated.length < raw.length;
  const data = useDeflate ? deflated : raw;
  const method = useDeflate ? 8 : 0;
  const crc = crc32(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(0, 10); // 时间（不写具体时间，避免不可复现）
  local.writeUInt16LE(0, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  chunks.push(local, nameBuf, data);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0x0800, 8);
  cd.writeUInt16LE(method, 10);
  cd.writeUInt16LE(0, 12);
  cd.writeUInt16LE(0, 14);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(data.length, 20);
  cd.writeUInt32LE(raw.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt32LE(0, 38); // 外部属性
  cd.writeUInt32LE(offset, 42);
  central.push(cd, nameBuf);

  offset += local.length + nameBuf.length + data.length;
}

const centralBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(zipPath, Buffer.concat([...chunks, centralBuf, end]));

const sizeMb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
console.log(`上线包已生成：${zipPath}（${files.length} 个文件，${sizeMb} MB）`);
console.log('服务器上：unzip 后进目录执行  bash deploy/up.sh');
