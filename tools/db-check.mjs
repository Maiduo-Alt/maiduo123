#!/usr/bin/env node
/**
 * 数据库连通性检测（换库、上线前、部署排错用）。
 *
 * 用法：
 *   node tools/db-check.mjs "postgresql://user:pwd@host:5432/db?sslmode=require"
 *   node tools/db-check.mjs                      # 读取环境变量 DATABASE_URL
 *   node tools/db-check.mjs --probe-supabase <项目ref> <密码> <区域，如 ap-southeast-2>
 *   node tools/db-check.mjs --sslmode no-verify "<连接串>"     # 覆盖连接串里的 sslmode
 *
 * 输出里的密码一律打码。退出码 0=可用，1=不可用。
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { Client } = require(path.join(rootDir, 'node_modules', 'pg'));

/** 建库脚本里约定的表，用于判断结构是否已初始化。 */
const EXPECTED_TABLES = [
  'roles', 'groups', 'accounts', 'app_params', 'categories', 'products',
  'buyer_bg', 'buyer_qa', 'styles', 'scripts', 'attempts', 'sessions',
  'messages', 'session_actions', 'scores', 'annotations', 'tasks',
  'task_targets', 'task_assignees', 'cases', 'case_messages', 'phrases',
  'unlock_progress', 'action_logs', 'script_gen_tasks',
];

const CONNECT_TIMEOUT_MS = Number(process.env.DB_CHECK_TIMEOUT_MS || 10000);

function redact(text) {
  if (!text) return text;
  return String(text).replace(/:\/\/([^:/@]+):([^@]*)@/g, (_, user) => `://${user}:***@`);
}

function parseArgs(argv) {
  const args = { url: '', probe: null, sslmode: '', counts: false };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--probe-supabase') {
      args.probe = { ref: argv[i + 1], password: argv[i + 2], region: argv[i + 3] || 'ap-southeast-2' };
      i += 3;
    } else if (argv[i] === '--sslmode') {
      args.sslmode = argv[i + 1] || '';
      i += 1;
    } else if (argv[i] === '--url') {
      args.url = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--counts') {
      args.counts = true;
    } else {
      rest.push(argv[i]);
    }
  }
  if (!args.url && rest.length) args.url = rest[0];
  if (!args.url) args.url = process.env.DATABASE_URL || '';
  return args;
}

/** 按需覆盖连接串里的 sslmode（用于排查证书校验问题）。 */
function withSslmode(url, sslmode) {
  if (!sslmode) return url;
  return url.replace(/([?&])sslmode=[^&]*/i, '$1').replace(/[?&]$/, '') +
    (url.includes('?') ? '&' : '?') + `sslmode=${sslmode}`;
}

async function probe(url) {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  const startedAt = Date.now();
  try {
    await client.connect();
  } catch (err) {
    try { await client.end(); } catch { /* 连接未建立时忽略 */ }
    return { ok: false, error: err.message, code: err.code };
  }
  const connectMs = Date.now() - startedAt;
  try {
    const meta = await client.query(
      'select version() as version, current_database() as db, current_user as usr, inet_server_addr() as host',
    );
    const tables = await client.query(
      "select table_name from information_schema.tables where table_schema = 'public'",
    );
    const found = new Set(tables.rows.map((r) => r.table_name));
    const missing = EXPECTED_TABLES.filter((t) => !found.has(t));
    let encrypted = null;
    const socket = client.connection?.stream;
    if (socket && typeof socket.encrypted === 'boolean') encrypted = socket.encrypted;
    return {
      ok: true,
      connectMs,
      version: String(meta.rows[0].version).split(' ').slice(0, 2).join(' '),
      database: meta.rows[0].db,
      user: meta.rows[0].usr,
      host: meta.rows[0].host,
      encrypted,
      totalTables: found.size,
      missing,
      rows: null,
    };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code };
  } finally {
    try { await client.end(); } catch { /* 已断开时忽略 */ }
  }
}

/** 统计各表行数（--counts，用于确认初始化数据是否铺完）。 */
async function countRows(url) {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  await client.connect();
  try {
    const out = {};
    for (const table of EXPECTED_TABLES) {
      try {
        const r = await client.query(`select count(*)::int as n from "${table}"`);
        out[table] = r.rows[0].n;
      } catch {
        out[table] = null;
      }
    }
    return out;
  } finally {
    try { await client.end(); } catch { /* 忽略 */ }
  }
}

function describe(url) {
  try {
    const parsed = new URL(url.replace(/^postgres(ql)?:/, 'http:'));
    const sslmode = parsed.searchParams.get('sslmode') || '(未设置)';
    const isLocal = /^(127\.0\.0\.1|localhost|::1)$/.test(parsed.hostname);
    return { host: `${parsed.hostname}:${parsed.port || 5432}`, sslmode, isLocal };
  } catch {
    return { host: '(解析失败)', sslmode: '(解析失败)', isLocal: false };
  }
}

function report(label, result, info) {
  console.log(`\n[${label}] ${info.host}  sslmode=${info.sslmode}`);
  if (!result.ok) {
    console.log(`  ✗ 失败：${redact(result.error)}${result.code ? ` (${result.code})` : ''}`);
    if (/sslmode|SSL|ssl/i.test(result.error || '')) {
      console.log('  → 提示：托管 PostgreSQL 一般要求 SSL，请在连接串末尾加 ?sslmode=require');
    } else if (result.code === 'ENOTFOUND') {
      console.log('  → 提示：主机名解析不了，检查项目 ref / 区域是否写对');
    } else if (result.code === 'ENETUNREACH' || result.code === 'EHOSTUNREACH') {
      console.log('  → 提示：本机没有对应协议栈（Supabase 直连可能只解析到 IPv6），改用连接池地址');
    } else if (result.code === '28P01') {
      console.log('  → 提示：密码错误');
    } else if (/timeout|ETIMEDOUT/i.test(result.error || '')) {
      console.log('  → 提示：连不上，可能是网络/防火墙，或该地址在本机不可达');
    }
    return false;
  }
  console.log(`  ✓ 连接成功（${result.connectMs} ms）`);
  console.log(`    版本：${result.version}`);
  console.log(`    库/用户：${result.database} / ${result.user}`);
  console.log(`    服务端地址：${result.host}`);
  console.log(`    链路加密：${result.encrypted === null ? '未知' : result.encrypted ? '是' : '否'}`);
  console.log(`    public 表数量：${result.totalTables}`);
  if (result.missing.length === 0) {
    console.log('    结构：25 张表齐全（已执行过 migrate）');
  } else if (result.totalTables === 0) {
    console.log('    结构：空库（容器启动时跑 migrate + seed 即可）');
  } else {
    console.log(`    结构：缺少 ${result.missing.length} 张表 → ${result.missing.join(', ')}`);
  }
  return true;
}

function candidates({ ref, password, region }) {
  const pwd = encodeURIComponent(password);
  const base = (host) => `postgresql://postgres:${pwd}@${host}/postgres?sslmode=require`;
  const poolUser = `postgres.${ref}`;
  const poolPwd = encodeURIComponent(password);
  const pooler = (cluster, port, mode) => ({
    label: `Supabase 连接池(${cluster} ${mode} ${port})`,
    url: `postgresql://${poolUser}:${poolPwd}@${cluster}-${region}.pooler.supabase.com:${port}/postgres?sslmode=require`,
  });
  return [
    { label: 'Supabase 直连', url: base(`db.${ref}.supabase.co:5432`) },
    pooler('aws-0', 5432, '会话模式'),
    pooler('aws-1', 5432, '会话模式'),
    pooler('aws-0', 6543, '事务模式'),
    pooler('aws-1', 6543, '事务模式'),
  ];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.probe) {
    if (!args.probe.ref || !args.probe.password) {
      console.error('用法：node tools/db-check.mjs --probe-supabase <项目ref> <密码> <区域>');
      process.exit(2);
    }
    console.log(`探测 Supabase 项目 ${args.probe.ref}（区域 ${args.probe.region}）`);
    if (args.sslmode) console.log(`（sslmode 统一覆盖为 ${args.sslmode}）`);
    let anyOk = false;
    for (const cand of candidates(args.probe)) {
      const result = await probe(withSslmode(cand.url, args.sslmode));
      if (report(cand.label, result, describe(cand.url))) anyOk = true;
    }
    console.log(anyOk ? '\n结论：至少一条可用。' : '\n结论：三条都不可用，先看上面的失败提示。');
    process.exit(anyOk ? 0 : 1);
  }

  if (!args.url) {
    console.error('用法：node tools/db-check.mjs <连接串>，或先设置 DATABASE_URL');
    process.exit(2);
  }

  const target = withSslmode(args.url, args.sslmode);
  const info = describe(target);
  if (!info.isLocal && info.sslmode === '(未设置)') {
    console.log('⚠ 连接串里没有 sslmode，托管库通常会拒绝这种连接（本项目默认 ssl=false）。');
  }
  const ok = report('DATABASE_URL', await probe(target), info);
  if (ok && args.counts) {
    console.log('\n各表行数：');
    const rows = await countRows(target);
    for (const [table, n] of Object.entries(rows)) {
      console.log(`  ${table.padEnd(18)} ${n === null ? '(不存在)' : n}`);
    }
  }
  console.log(ok ? '\n结论：数据库可用。' : '\n结论：数据库不可用。');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('检测脚本异常：', redact(err.message));
  process.exit(1);
});
