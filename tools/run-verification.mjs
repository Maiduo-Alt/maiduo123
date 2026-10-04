#!/usr/bin/env node
/**
 * 一次跑完所有可自动化的验证项，把结果写进 docs/验收证据.json，
 * 供验收看板（tools/progress-server.mjs）展示。
 *
 * 覆盖：后端/前端类型编译 → 后端全量测试 → HTTP 冒烟 → 内容库自检 → 并发压测。
 * 不覆盖（需要在真实环境做，看板里会显示为「待运行」）：
 *   - 72 小时连续运行（soak）
 *   - Chrome / Edge 逐版本回归（compat）
 *
 * 用法：npm run verify
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3000';
const jestReport = path.join(root, 'docs', '_jest-report.json');

const strip = (text) => String(text || '').replace(/\u001b\[[0-9;]*m/g, '');
const tail = (text, lines = 12) => strip(text).trim().split('\n').slice(-lines).join('\n');

function run(label, command, args, options = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    timeout: options.timeout || 600000,
    shell: false,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const ok = result.status === 0;
  process.stdout.write(`${ok ? '✓' : '✗'} ${label}（${Math.round((Date.now() - started) / 1000)}s）\n`);
  if (!ok) process.stdout.write(tail(output, 14) + '\n');
  return { ok, output, status: result.status, ms: Date.now() - started };
}

async function apiAlive() {
  try {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'agent', password: 'Agent@123' }),
    });
    const json = await res.json();
    return json.code === 0;
  } catch {
    return false;
  }
}

const checks = {};
const startedAt = new Date().toISOString();
process.stdout.write(`开始完整验证（API：${API_BASE}）\n`);

/* 1. 类型编译 */
const backendTsc = run('后端类型编译', process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'backend/tsconfig.build.json', '--noEmit']);
const frontendTsc = run('前端类型编译', process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'frontend/tsconfig.json', '--noEmit']);
checks.build = {
  ok: backendTsc.ok && frontendTsc.ok,
  summary: `后端 tsc ${backendTsc.ok ? '0 错误' : '有错误'}；前端 tsc ${frontendTsc.ok ? '0 错误' : '有错误'}`,
};

/* 2. 后端全量测试（含安全与备份用例） */
if (fs.existsSync(jestReport)) fs.unlinkSync(jestReport);
const jest = run('后端测试', process.execPath, [path.join(root, 'node_modules/jest/bin/jest.js'), '--runInBand', '--json', `--outputFile=${jestReport}`], {
  cwd: path.join(root, 'backend'),
});
let jestData = null;
try {
  jestData = JSON.parse(fs.readFileSync(jestReport, 'utf8'));
} catch {
  jestData = null;
}
if (fs.existsSync(jestReport)) fs.unlinkSync(jestReport);

const suites = jestData?.testResults || [];
const securitySuites = suites.filter((suite) => /安全|security/i.test(suite.name) || (suite.assertionResults || []).some((t) => /安全|注入|XSS|脱敏/.test(t.title)));
const securityCases = securitySuites.flatMap((suite) => (suite.assertionResults || []).filter((t) => /安全|注入|XSS|脱敏/.test(t.title)));
const backupCases = suites.flatMap((suite) => (suite.assertionResults || []).filter((t) => /备份|恢复|backup/i.test(t.title)));

checks.tests = {
  ok: Boolean(jestData) && jestData.numFailedTests === 0 && jest.ok,
  summary: jestData
    ? `${jestData.numPassedTests}/${jestData.numTotalTests} 项通过，失败 ${jestData.numFailedTests} 项（${jestData.numTotalTestSuites} 个文件）`
    : '无法解析测试结果',
};
checks.security = {
  ok: securityCases.length > 0 && securityCases.every((t) => t.status === 'passed'),
  summary:
    securityCases.length > 0
      ? `安全相关用例 ${securityCases.filter((t) => t.status === 'passed').length}/${securityCases.length} 通过：` +
        securityCases.map((t) => t.title).slice(0, 4).join('；')
      : '未找到安全相关用例',
};
checks.backup = {
  ok: backupCases.length > 0 && backupCases.every((t) => t.status === 'passed'),
  summary: backupCases.length ? `备份/恢复用例 ${backupCases.length} 项通过：${backupCases.map((t) => t.title).join('；')}` : '未找到备份恢复用例',
};

/* 3. HTTP 冒烟（需要服务在跑） */
const alive = await apiAlive();
if (alive) {
  const smoke = run('HTTP 冒烟测试', process.execPath, ['tools/smoke-test.mjs'], { env: { SMOKE_BASE: API_BASE }, timeout: 300000 });
  const summaryLine = strip(smoke.output).split('\n').find((line) => line.includes('共 ') && line.includes('项检查')) || '未取到统计行';
  checks.smoke = { ok: smoke.ok, summary: summaryLine.trim() };

  const load = run('并发压测', process.execPath, ['tools/load-test.mjs'], { env: { SMOKE_BASE: API_BASE }, timeout: 300000 });
  const rawLoad = strip(load.output);
  const reportMatch = rawLoad.match(/压测结果：\s*(\{[\s\S]*?\n\})/);
  if (reportMatch) {
    try {
      const report = JSON.parse(reportMatch[1]);
      checks.load = {
        ok: load.ok,
        summary:
          `在线 ${report.在线人数} 人 / 并发 ${report.并发接待局数} 局共 ${report.会话数} 路会话；` +
          `接口 P95 ${report.接口耗时ms.P95}ms；实时通道往返 P95 ${report.实时通道往返ms.P95}ms；` +
          `消息推送延迟 P95 ${report.消息推送延迟ms.P95}ms；业务错误 ${report.业务错误数}`,
      };
    } catch {
      checks.load = { ok: load.ok, summary: '压测结果解析失败' };
    }
  } else {
    checks.load = { ok: load.ok, summary: tail(rawLoad, 3) || '未取到压测结论' };
  }
} else {
  checks.smoke = { ok: false, summary: `API ${API_BASE} 未启动，跳过（先运行 npm run dev:api:mem）` };
  checks.load = { ok: false, summary: `API ${API_BASE} 未启动，跳过` };
}

/* 4. 内容库自检 */
const content = run('内容库自检', process.execPath, ['tools/check-content.mjs']);
const contentLine = strip(content.output).split('\n').find((line) => line.includes('自检')) || '未取到结论';
checks.content = { ok: content.ok, summary: contentLine.trim() };

const failed = Object.entries(checks).filter(([, value]) => !value.ok).map(([key]) => key);
const report = {
  startedAt,
  finishedAt: new Date().toISOString(),
  apiBase: API_BASE,
  conclusion: failed.length ? `有 ${failed.length} 项未通过` : '全部通过',
  failed,
  checks,
};
fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
fs.writeFileSync(path.join(root, 'docs/验收证据.json'), JSON.stringify(report, null, 2));

process.stdout.write(`\n结论：${report.conclusion}\n`);
for (const [key, value] of Object.entries(checks)) {
  process.stdout.write(`  ${value.ok ? '✓' : '✗'} ${key}：${value.summary}\n`);
}
process.stdout.write('已写入 docs/验收证据.json（验收看板会自动读到）\n');
process.exit(failed.length ? 1 : 0);
