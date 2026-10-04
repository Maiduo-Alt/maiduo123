#!/usr/bin/env node
/**
 * 白屏扫查：逐页把所有「会打开弹窗 / 抽屉」的入口都点一遍，确认页面没被点崩。
 *
 * 为什么需要它：这一类缺陷很隐蔽 —— 组件里一个异常会把整棵 React 树卸载成白屏，
 * 静态渲染检查（render-check）和指定路径检查（flow-check）都可能漏掉没被覆盖的那个弹窗。
 * 案例收藏的「编辑」弹窗就是这么炸的（分组 options 写法不对），扫查能把同类问题一次找出来。
 *
 * 用法：
 *   npm run sweep:check        # 全量扫查
 *   node tools/click-sweep.mjs --list
 *
 * 只点「打开类」按钮（新建/编辑/查看/详情/预览/统计/报表/导入/配置/添加/分配/对比），
 * 不点任何会改数据的按钮（删除 / 停用 / 启用 / 保存 / 确定 / 提交 / 生成 / 结束 / 开始接待），
 * 每点一次后按 Esc + 取消 把弹窗关掉再点下一个；跑完自动删探针。
 *
 * 前置：接口服务（3000）与前端预览（4173）在跑，frontend/dist 已构建；需要放行浏览器进程。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = process.env.RENDER_APP || 'http://127.0.0.1:4173';
const API = process.env.SMOKE_BASE || 'http://127.0.0.1:3000';
const TMP = os.tmpdir();
const LIST_ONLY = process.argv.includes('--list');
const ONLY = (process.argv.find((arg) => arg.startsWith('--only=')) || '').split('=')[1] || '';
/** --labels：只列出每页会被点到的入口名，不真的点（用来审计扫查范围 / 排查问题） */
const LABELS_ONLY = process.argv.includes('--labels');
/** --budget=毫秒：虚拟时间预算，排查卡死时调小可以让 dump 落在半途 */
const BUDGET = Number((process.argv.find((arg) => arg.startsWith('--budget=')) || '').split('=')[1]) || 180000;
/** --label=名字：只点这一个入口（排查卡死/白屏时用来逐个隔离） */
const ONLY_LABEL = (process.argv.find((arg) => arg.startsWith('--label=')) || '').split('=')[1] || '';

const BROWSERS = [
  process.env.RENDER_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].filter(Boolean);
const browser = BROWSERS.find((candidate) => fs.existsSync(candidate));

/** 扫查范围：与 render-check 的页面清单保持一致 */
const PAGES = [
  ['客服首页', 'agent', '/'],
  ['客服任务列表', 'agent', '/tasks'],
  ['客服明细列表', 'agent', '/records'],
  ['带教剧本列表', 'leader', '/scripts'],
  ['带教素材库', 'leader', '/library'],
  ['带教案例收藏', 'leader', '/cases'],
  ['带教任务列表', 'leader', '/tasks'],
  ['带教接待页', 'leader', '/reception'],
  ['管理员商品库', 'admin', '/products'],
  ['管理员数据字典', 'admin', '/dictionary'],
  ['管理员系统参数', 'admin', '/settings'],
  ['管理员沟通风格', 'admin', '/styles'],
  ['管理员快捷短语', 'admin', '/phrases'],
  ['管理员账号', 'admin', '/accounts'],
  ['管理员首页', 'admin', '/'],
];

/** 只点这些标签的按钮；其余（尤其删除/停用/保存/生成/开始接待）一律不碰 */
const OPEN_PATTERNS = ['新建', '编辑', '查看', '详情', '预览', '统计', '报表', '导入', '配置', '添加', '分配', '对比', '标记'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PROBE_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="out">WAITING</div><iframe id="f" width="1440" height="900" style="border:0"></iframe>
<script>
const q = new URLSearchParams(location.search);
if (q.get('t')) localStorage.setItem('cs-training-token', q.get('t'));
const f = document.getElementById('f');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const set = (v) => { document.getElementById('out').textContent = 'RESULT|' + JSON.stringify(v) + '|END'; };
f.onload = () => setTimeout(async () => {
  try {
    const d = f.contentDocument;
    if (!d) return set({ ok:false, reason:'取不到 iframe 文档' });
    const fn = new Function('d','sleep','return (async () => {' + decodeURIComponent(q.get('js') || '') + '})();');
    set(await fn(d, sleep));
  } catch (e) { set({ ok:false, reason:'脚本异常: ' + e.message }); }
}, Number(q.get('wait') || 7000));
f.src = q.get('to') || '/';
</script></body></html>`;

const DETECT_JS = `
  const win = d.defaultView;
  // 无头模式没人应答原生对话框，且内嵌/沙箱 iframe 里 prompt 会被直接忽略：
  // 扫查时统一打桩，避免卡住；真实环境里这类入口应改用页面内弹窗。
  try { win.prompt = () => null; win.confirm = () => true; win.alert = () => {}; } catch (e) {}
  const inOverlay = (el) => !!(el.closest && el.closest('.ant-modal, .ant-drawer'));
  const patterns = ${JSON.stringify(OPEN_PATTERNS)};
  const onlyLabel = __ONLY_LABEL__;
  const labels = [...new Set(
    [...d.querySelectorAll('button')]
      .filter((b) => !b.disabled && !inOverlay(b))
      .map((b) => (b.textContent || '').trim())
      .filter((t) => t && patterns.some((p) => t.includes(p)))
  )].filter((t) => !onlyLabel || t === onlyLabel);
`;

const LABELS_JS = DETECT_JS + `
  return { ok:true, labels, textLen: d.body.innerText.length };
`;

const SWEEP_JS = DETECT_JS + `
  const errors = [];
  win.addEventListener('error', (e) => errors.push(String(e.message)));
  // 未处理的 Promise 拒绝同样算「真问题」：接口失败、剪贴板被拒等都会走这里，
  // 页面可能照样渲染，但控制台是红的，验收的人会以为是坏掉了。
  win.addEventListener('unhandledrejection', (e) => {
    const reason = e && e.reason;
    errors.push('未处理的 Promise 拒绝: ' + String((reason && reason.message) || reason).slice(0, 160));
  });
  // console.error 只做记录不做判定（AntD 的告警也走这里，容易误报）
  const consoleErrors = [];
  const rawConsoleError = win.console.error.bind(win.console);
  win.console.error = (...args) => {
    consoleErrors.push(args.map((a) => String(a)).join(' ').slice(0, 160));
    rawConsoleError(...args);
  };

  const rootEl = () => d.getElementById('root');
  const isBlank = () => {
    const el = rootEl();
    if (!el || el.childElementCount === 0) return true;
    return d.body.innerText.trim().length < 40;
  };
  const closeOverlays = async () => {
    for (let i = 0; i < 3; i += 1) {
      d.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
      await sleep(350);
      const cancel = [...d.querySelectorAll('.ant-modal button, .ant-drawer button')]
        .find((x) => /取消|关闭|返回/.test(x.textContent || '') && !x.disabled);
      if (cancel) { cancel.click(); await sleep(450); }
    }
  };

  const clicked = [];
  const crashes = [];
  // 进度写回探针页，便于卡住时定位（最终 set() 会覆盖成 RESULT）
  const progress = (msg) => { try { document.getElementById('out').textContent = 'PROGRESS|' + msg; } catch (e) {} };
  progress('labels=' + labels.length);
  for (const label of labels) {
    progress('clicking=' + label);
    const btn = [...d.querySelectorAll('button')]
      .find((x) => (x.textContent || '').trim() === label && !x.disabled && !inOverlay(x));
    if (!btn) continue;
    const errBefore = errors.length;
    btn.click();
    await sleep(1500);
    progress('clicked=' + label + ';blank=' + isBlank());
    if (isBlank()) {
      crashes.push({ label, errors: errors.slice(errBefore) });
      return { ok: false, clicked: clicked.length, total: labels.length, crashes, errors, consoleErrors };
    }
    clicked.push(label);
    await closeOverlays();
  }
  return { ok: errors.length === 0, clicked: clicked.length, total: labels.length, crashes: [], errors, consoleErrors };
`;

const api = async (route, { token, method = 'GET', body } = {}) => {
  const res = await fetch(`${API}/api${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (json.code !== 0) throw new Error(`${route} -> ${json.code} ${json.message}`);
  return json.data;
};

function writeBrowserCheck(key, total, passed, failedNames) {
  const file = path.join(root, 'docs', '浏览器自检.json');
  let merged = {};
  try {
    if (fs.existsSync(file)) merged = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    merged = {};
  }
  merged[key] = { ok: passed === total, total, passed, failed: failedNames, finishedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(merged, null, 2));
}

function runProbe(token, route, js, budget) {
  const probe = path.join(root, 'frontend', 'dist', '__sweep-probe.html');
  fs.writeFileSync(probe, PROBE_HTML);
  const script = js.replace('__ONLY_LABEL__', ONLY_LABEL ? JSON.stringify(ONLY_LABEL) : 'null');
  const url =
    `${APP}/__sweep-probe.html?t=${encodeURIComponent(token)}` +
    `&to=${encodeURIComponent(route)}&js=${encodeURIComponent(script)}&wait=7000`;
  try {
    const res = spawnSync(
      browser,
      [
        '--headless=old',
        '--disable-gpu',
        '--no-sandbox',
        '--hide-scrollbars',
        '--window-size=1460,960',
        `--user-data-dir=${path.join(TMP, 'cs-training-click-sweep')}`,
        `--virtual-time-budget=${budget}`,
        '--dump-dom',
        url,
      ],
      { encoding: 'utf8', timeout: 180000, maxBuffer: 128 * 1024 * 1024, windowsHide: true }
    );
    const matched = /RESULT\|([\s\S]*?)\|END/.exec(res.stdout || '');
    if (!matched) {
      // 没跑完时把探针页上的进度文本带回来，便于定位卡在哪一步
      const stuck = /<div id="out">([\s\S]*?)<\/div>/.exec(res.stdout || '');
      return { ok: false, __stuck: stuck ? stuck[1].trim().slice(0, 160) : '(探针页没渲染)' };
    }
    return JSON.parse(matched[1]);
  } finally {
    fs.rmSync(probe, { force: true });
  }
}

function sweepPage(token, route) {
  const parsed = runProbe(token, route, SWEEP_JS, BUDGET);
  if (!parsed) return { ok: false, detail: '未取到结果（页面没跑完或探针没加载）', clicked: 0, total: 0 };
  if (parsed.__stuck !== undefined) {
    return { ok: false, detail: `未跑完，卡在：${parsed.__stuck || '(空)'}`, clicked: 0, total: 0 };
  }
  if (parsed.reason) {
    return { ok: false, detail: `注入脚本异常：${parsed.reason}`, clicked: parsed.clicked || 0, total: parsed.total || 0 };
  }
  try {
    const consoleNote = parsed.consoleErrors?.length ? `，控制台 error ${parsed.consoleErrors.length} 条：${parsed.consoleErrors[0]}` : '';
    const detail = parsed.crashes?.length
      ? `点「${parsed.crashes.map((c) => c.label).join('、')}」后整页白屏` +
        (parsed.crashes[0].errors?.length ? `｜${parsed.crashes[0].errors[0]}` : '')
      : parsed.errors?.length
        ? `未捕获异常 ${parsed.errors.length} 条：${parsed.errors[0]}`
        : `点了 ${parsed.clicked}/${parsed.total} 个入口，无白屏、无未捕获异常${consoleNote}`;
    return { ok: !!parsed.ok, detail, clicked: parsed.clicked, total: parsed.total };
  } catch (error) {
    return { ok: false, detail: `结果异常：${error.message}`, clicked: 0, total: 0 };
  }
}

async function main() {
  if (LIST_ONLY) {
    PAGES.forEach(([name, role, route]) => console.log(`${role.padEnd(7)} ${route.padEnd(14)} ${name}`));
    return;
  }
  if (!browser) {
    console.error('未找到 Edge / Chrome，无法跑白屏扫查。可用 RENDER_BROWSER 指定浏览器路径。');
    process.exit(1);
  }
  if (!fs.existsSync(path.join(root, 'frontend', 'dist'))) {
    console.error('未找到 frontend/dist，请先构建前端。');
    process.exit(1);
  }

  const tokens = {
    agent: (await api('/auth/login', { method: 'POST', body: { username: 'agent', password: 'Agent@123' } })).token,
    leader: (await api('/auth/login', { method: 'POST', body: { username: 'leader', password: 'Leader@123' } })).token,
    admin: (await api('/auth/login', { method: 'POST', body: { username: 'admin', password: 'Admin@123' } })).token,
  };

  const pages = ONLY ? PAGES.filter(([name]) => name.includes(ONLY)) : PAGES;
  if (!pages.length) {
    console.error(`没有匹配「${ONLY}」的页面，用 --list 看清单。`);
    process.exit(1);
  }

  const results = [];
  if (LABELS_ONLY) {
    for (const [name, role, route] of pages) {
      const parsed = runProbe(tokens[role], route, LABELS_JS, 30000);
      const labels = parsed?.labels || [];
      console.log(`${name}（${route}）→ ${labels.length} 个：${labels.join('、') || '无'}`);
    }
    return;
  }

  for (const [name, role, route] of pages) {
    const outcome = sweepPage(tokens[role], route);
    results.push({ name, ok: outcome.ok, detail: outcome.detail });
  }

  const failed = results.filter((item) => !item.ok);
  // 定向重跑（--only）不写看板数据，避免用「1/1」覆盖全量结果
  if (!ONLY) writeBrowserCheck('sweep', results.length, results.length - failed.length, failed.map((item) => item.name));
  results.forEach((item) => console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name.padEnd(20)} ${item.detail}`));
  console.log(`\n白屏扫查：${results.length - failed.length}/${results.length} 个页面通过（共点击 ${results.length} 个页面的全部打开类入口）`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('白屏扫查失败：', error.message);
  console.error('请确认接口服务（3000）与前端预览（4173）都在跑。');
  process.exit(1);
});
