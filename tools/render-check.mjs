#!/usr/bin/env node
/**
 * 页面真实渲染自检：用本机 Edge/Chrome 的无头模式把每个页面渲染出来，
 * 再检查 DOM 里是否真的出现了该页面应有的内容。
 *
 * 为什么需要它：接口形状、类型编译、e2e 都通过，不代表页面在浏览器里能渲染出来
 * （字段读错、空数组、组件里一个未定义访问都可能白屏或空白区块）。
 * 这个脚本是「验收前最后一次兜底」。
 *
 * 用法：
 *   npm run render:check              # 全量（含运行中接待页、明细详情等深度用例）
 *   npm run render:check -- --list    # 只看用例清单
 *   node tools/render-check.mjs --no-deep   # 只跑静态页面渲染
 *
 * 前置：接口服务（3000）与前端预览（4173）都在跑；本机装有 Edge 或 Chrome。
 * 注意：会启动浏览器进程，需要放行；深度用例会真实开一局接待并结束它。
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
const NO_DEEP = process.argv.includes('--no-deep');
const LIST_ONLY = process.argv.includes('--list');
const SHOTS_DIR = (process.argv.find((arg) => arg.startsWith('--shots=')) || '').split('=')[1] || null;
const SIZE = (process.argv.find((arg) => arg.startsWith('--size=')) || '').split('=')[1] || '1366x768';
const SKIP_LAYOUT = process.argv.includes('--no-layout');

const BROWSERS = [
  process.env.RENDER_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].filter(Boolean);

const browser = BROWSERS.find((candidate) => fs.existsSync(candidate));

/** 静态页面用例：角色 + 路由 + 该页面必须出现的内容关键字。 */
const PAGE_CASES = [
  ['客服首页', 'agent', '/', ['你好', '我的最近接待', '开始训练']],
  ['客服接待页（引导）', 'agent', '/reception', ['从《我的任务》进入训练', '去我的任务']],
  ['客服任务列表', 'agent', '/tasks', ['回复模拟任务', '开始训练']],
  ['客服明细列表', 'agent', '/records', ['模拟接待明细', '接待编号', '无效回复']],
  ['带教剧本列表', 'leader', '/scripts', ['剧本列表', '剧本统计']],
  ['带教素材库', 'leader', '/library', ['买家咨询背景', '模板分类']],
  ['带教案例收藏', 'leader', '/cases', ['案例收藏', '导入文件']],
  // 客户 2026-10-03：任务列表要能看到「范围」列（剧本/商品/品类多选的结果）
  ['带教任务列表', 'leader', '/tasks', ['回复模拟任务', '查看报表', '范围']],
  ['带教接待页（模拟训练）', 'leader', '/reception', ['模拟训练（管理员 / 带教）', '开始接待']],
  ['管理员商品库', 'admin', '/products', ['商品库', '导出 Excel']],
  ['管理员数据字典', 'admin', '/dictionary', ['数据字典', '商品场景标签']],
  [
    '管理员系统参数',
    'admin',
    '/settings',
    [
      '系统参数',
      '考核规则',
      '评分权重与达标线',
      '难度与接待参数',
      '沟通风格与消息',
      '接入人数',
      '总接待人数',
      // 客户 2026-10-03 C14：售前 / 售后问题占比
      '问题构成（售前 / 售后）',
      '售后问题占比',
      '无效 / 敷衍回复判定',
      '非平台官方口径',
      '教学与登录安全',
      '提示模式',
    ],
  ],
  ['管理员沟通风格', 'admin', '/styles', ['沟通风格', '达标率', '新建风格']],
  ['管理员快捷短语', 'admin', '/phrases', ['快捷短语', '使用次数']],
  ['管理员账号', 'admin', '/accounts', ['账号', '新人客服 A']],
  // 客户 2026-10-03：《我的训练》只放训练任务；自由练习入口统一到《在线模拟接待》。
  // 当天下午客户又要求把这张提示卡整块删掉，所以这里改成「不该出现」的负向断言。
  [
    '管理员首页',
    'admin',
    '/',
    ['我的最近接待', '我的成长曲线', '当天每次模拟'],
    ['自由练习已统一放在《在线模拟接待》里', '去自由练习', '难度档位与快速开始'],
  ],
];

const api = async (route, { token, method = 'GET', body } = {}) => {
  const res = await fetch(`${API}/api${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (json.code !== 0) throw new Error(`${route} -> ${json.code} ${json.message}`);
  return json.data;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 把本次结果合并进 docs/浏览器自检.json（另一个工具的键保留），
 * 验收看板会读它显示「浏览器层自检」的最近一次结果与时间。
 */
function writeBrowserCheck(key, total, passed, failedNames) {
  const file = path.join(root, 'docs', '浏览器自检.json');
  let merged = {};
  try {
    if (fs.existsSync(file)) merged = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    merged = {};
  }
  merged[key] = { ok: passed === total, total, passed, failed: failedNames, finishedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(merged, null, 2));
}

/** 渲染一个 URL，返回 DOM 文本。 */
function renderDom(url, options = {}) {
  const width = options.width || 1440;
  const height = options.height || 900;
  const result = spawnSync(
    browser,
    [
      '--headless=old',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      `--window-size=${width},${height}`,
      `--user-data-dir=${path.join(TMP, 'cs-training-render-check')}`,
      `--virtual-time-budget=${options.budget || 8000}`,
      '--dump-dom',
      url,
    ],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 128 * 1024 * 1024, windowsHide: true }
  );
  return result.stdout || '';
}

/** 用探测页把登录态写进 localStorage，再跳到目标路由（前端登录态就存在 localStorage）。 */
function probeUrl(token, route) {
  return `${APP}/__render-probe.html?t=${encodeURIComponent(token)}&to=${encodeURIComponent(route)}`;
}

/**
 * 截图（人工看排版用）：按 --size 指定的尺寸渲染一个 URL 并存成 PNG。
 * 方案 9.3 要求「1366×768 下接待页可用」，就是用这个看。
 */
/**
 * 布局检查：把目标页放进一个 --size 宽的 iframe 里渲染，量它的 scrollWidth 是否超过视口宽。
 * 固定列宽的表格在窄屏下很容易把整页撑宽（曾用它在 1366 宽下抓到案例收藏溢出 18px）。
 */
function measureOverflow(token, route) {
  const [width, height] = SIZE.split('x').map(Number);
  const probe = path.join(root, 'frontend', 'dist', '__render-layout.html');
  fs.writeFileSync(
    probe,
    `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}iframe{border:0;display:block}</style></head><body>
<div id="out">WAITING</div><iframe id="f" width="${width}" height="${height}"></iframe>
<script>
const q = new URLSearchParams(location.search);
if (q.get('t')) localStorage.setItem('cs-training-token', q.get('t'));
const f = document.getElementById('f');
f.src = q.get('to') || '/';
f.onload = () => setTimeout(() => {
  try {
    const d = f.contentDocument, de = d.documentElement;
    document.getElementById('out').textContent = 'DIAG:' + JSON.stringify({ sw: de.scrollWidth, cw: de.clientWidth });
  } catch (e) { document.getElementById('out').textContent = 'DIAG:' + JSON.stringify({ error: e.message }); }
}, 4000);
</script></body></html>`
  );
  try {
    const dom = renderDom(`${APP}/__render-layout.html?t=${encodeURIComponent(token)}&to=${encodeURIComponent(route)}`, { width, height, budget: 14000 });
    const matched = /DIAG:(\{.*?\})/.exec(dom);
    if (!matched) return { ok: false, detail: '未取到布局诊断' };
    const parsed = JSON.parse(matched[1]);
    if (parsed.error) return { ok: false, detail: parsed.error };
    return {
      ok: parsed.sw <= parsed.cw + 2,
      detail: `内容宽 ${parsed.sw} / 视口宽 ${parsed.cw}`,
    };
  } finally {
    fs.rmSync(probe, { force: true });
  }
}

function shoot(url, file) {
  fs.rmSync(file, { force: true });
  spawnSync(
    browser,
    [
      '--headless=old',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      `--window-size=${SIZE.replace('x', ',')}`,
      `--user-data-dir=${path.join(TMP, 'cs-training-render-check')}`,
      '--virtual-time-budget=8000',
      `--screenshot=${file}`,
      url,
    ],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024, windowsHide: true }
  );
  return fs.existsSync(file) ? fs.statSync(file).size : 0;
}

async function main() {
  if (!browser) {
    console.error('未找到 Edge / Chrome，跳过渲染自检。可用 RENDER_BROWSER 指定浏览器路径。');
    process.exit(0);
  }
  if (LIST_ONLY) {
    PAGE_CASES.forEach(([name, role, route]) => console.log(`${role.padEnd(7)} ${route.padEnd(28)} ${name}`));
    return;
  }

  const tokens = {
    agent: (await api('/auth/login', { method: 'POST', body: { username: 'agent', password: 'Agent@123' } })).token,
    leader: (await api('/auth/login', { method: 'POST', body: { username: 'leader', password: 'Leader@123' } })).token,
    admin: (await api('/auth/login', { method: 'POST', body: { username: 'admin', password: 'Admin@123' } })).token,
  };

  const probe = path.join(root, 'frontend', 'dist', '__render-probe.html');
  if (!fs.existsSync(path.dirname(probe))) {
    console.error('未找到 frontend/dist，请先 npm run build -w frontend');
    process.exit(1);
  }
  fs.writeFileSync(
    probe,
    `<!doctype html><html><body><script>
const q = new URLSearchParams(location.search);
if (q.get('t')) localStorage.setItem('cs-training-token', q.get('t'));
location.replace(q.get('to') || '/');
</script></body></html>`
  );

  const results = [];
  let attemptId = null;
  try {
    // 第 5 个元素（可选）= 「不该出现」的关键字：页面删掉某块内容时用
    for (const [name, role, route, expects, mustNot = []] of PAGE_CASES) {
      const dom = renderDom(probeUrl(tokens[role], route));
      const missing = expects.filter((keyword) => !dom.includes(keyword));
      const leaked = mustNot.filter((keyword) => dom.includes(keyword));
      results.push({
        name,
        ok: dom.length > 500 && missing.length === 0 && leaked.length === 0,
        detail: `${dom.length} 字节${missing.length ? `，缺 ${missing.join(' / ')}` : ''}${leaked.length ? `，不该出现：${leaked.join(' / ')}` : ''}`,
      });
    }

    // 布局检查：每个页面在 --size 宽度下不允许出现横向溢出
    if (!SKIP_LAYOUT) {
      for (const [name, role, route] of PAGE_CASES) {
        const measured = measureOverflow(tokens[role], route);
        results.push({ name: `布局 · ${name}（${SIZE} 无横向溢出）`, ok: measured.ok, detail: measured.detail });
      }
    }

    if (!NO_DEEP) {
      // 运行中的接待页：真实开一局任务训练
      const tasks = await api('/tasks', { token: tokens.agent });
      const current = await api('/receptions/current', { token: tokens.agent });
      if (current) await api(`/receptions/${current.attemptId}/finish`, { token: tokens.agent, method: 'POST', body: {} });
      const started = await api('/receptions', { token: tokens.agent, method: 'POST', body: { level: 'L2', source: 'task', taskId: tasks[0].id } });
      attemptId = started.attemptId;
      await sleep(4000);
      const live = renderDom(probeUrl(tokens.agent, `/reception?attemptId=${attemptId}`));
      [
        ['运行中接待页 · 结束接待按钮', ['结束本次接待并生成评分']],
        ['运行中接待页 · 任务训练标识', ['任务训练']],
        // 客户 2026-10-03：输入区改成飞鸽文案（发送给 X，使用 Enter 发送消息…）
        ['运行中接待页 · 输入区', ['发送给', '使用 Enter 发送消息']],
        ['运行中接待页 · 任务卡', ['需完成']],
      ].forEach(([name, expects]) =>
        results.push({ name, ok: expects.every((k) => live.includes(k)), detail: `${live.length} 字节` })
      );

      /**
       * 客户 2026-10-03：推送的问题要区分售前/售后，右栏订单卡片按问题的订单状态展示。
       * 订单卡片是三张参考图（待支付 / 待发货 / 已发货）里的字段结构，这里只兜住"卡片真的渲染出来了"。
       */
      const orderTab = renderDom(probeUrl(tokens.agent, `/reception?attemptId=${attemptId}&tab=order`));
      results.push({
        name: '运行中接待页 · 订单页签卡片',
        ok: ['规格', '收货信息', '发送'].every((k) => orderTab.includes(k)),
        detail: `${orderTab.length} 字节`,
      });
      results.push({
        name: '运行中接待页 · 订单状态与问题阶段对应',
        ok: ['待支付', '待发货', '已发货'].some((k) => orderTab.includes(k)),
        detail: ['待支付', '待发货', '已发货'].filter((k) => orderTab.includes(k)).join(' / ') || '三种状态标签都没出现',
      });

      // 明细详情（客服与带教视角）
      const agentRecords = await api('/records?pageSize=1', { token: tokens.agent });
      const agentDetail = renderDom(probeUrl(tokens.agent, `/records/${agentRecords.list[0].id}`));
      [
        ['明细详情 · 会话回放', ['会话回放']],
        ['明细详情 · 四维得分', ['响应时效', '问题解决']],
      ].forEach(([name, expects]) =>
        results.push({ name, ok: expects.every((k) => agentDetail.includes(k)), detail: `${agentDetail.length} 字节` })
      );

      const leaderRecords = await api('/records?pageSize=1', { token: tokens.leader });
      const leaderDetail = renderDom(probeUrl(tokens.leader, `/records/${leaderRecords.list[0].id}`));
      results.push({
        name: '明细详情（带教）· 转案例入口',
        ok: ['转为案例', '标记为典型案例'].every((k) => leaderDetail.includes(k)),
        detail: `${leaderDetail.length} 字节`,
      });
    }

    // 可选：截图关键页面（人工看排版，方案 9.3 的 1366×768 兼容验收）
    if (SHOTS_DIR) {
      fs.mkdirSync(SHOTS_DIR, { recursive: true });
      const shots = [
        ['01-客服首页', 'agent', '/'],
        ['02-客服我的任务', 'agent', '/tasks'],
        ['03-接待页-客服引导', 'agent', '/reception'],
        ['04-接待页-带教自由练习', 'leader', '/reception'],
        ['05-系统参数', 'admin', '/settings'],
        ['06-数据字典', 'admin', '/dictionary'],
        ['07-明细列表', 'agent', '/records'],
        // 下面这些是纯人工目视用的：页面内容断言过了不代表排版没问题
        // （成长曲线曾出现"横轴标签是空的、图内写死天数"就是靠看截图才发现的）
        ['08-带教剧本列表', 'leader', '/scripts'],
        ['09-带教素材库', 'leader', '/library'],
        ['10-带教案例收藏', 'leader', '/cases'],
        ['11-管理员商品库', 'admin', '/products'],
        ['12-管理员账号', 'admin', '/accounts'],
        ['13-管理员沟通风格', 'admin', '/styles'],
        ['14-管理员快捷短语', 'admin', '/phrases'],
        ['16-管理员首页', 'admin', '/'],
        ['17-带教任务列表', 'leader', '/tasks'],
      ];
      if (attemptId) shots.splice(3, 0, ['03b-接待页-运行中', 'agent', `/reception?attemptId=${attemptId}`]);
      if (attemptId) shots.splice(4, 0, ['03c-接待页-订单页签', 'agent', `/reception?attemptId=${attemptId}&tab=order`]);
      // 客户 2026-10-03：「商品」页签展示的是《商品库》里的商品（不再放咨询宝贝）
      if (attemptId) shots.splice(5, 0, ['03d-接待页-商品页签', 'agent', `/reception?attemptId=${attemptId}&tab=product`]);
      // 明细详情（人工看评分报告与会话回放的排版）：借一条带教的记录
      try {
        const oneRecord = await api('/records?pageSize=1', { token: tokens.leader });
        const recordId = oneRecord.list?.[0]?.id;
        if (recordId) shots.push(['15-明细详情', 'leader', `/records/${recordId}`]);
      } catch {
        /* 没有记录就跳过这张 */
      }
      for (const [name, role, route] of shots) {
        const file = path.join(SHOTS_DIR, `${name}.png`);
        const size = shoot(probeUrl(tokens[role], route), file);
        console.log(`SHOT  ${name.padEnd(24)} ${size} 字节  ${file}`);
      }
    }
  } finally {
    if (attemptId) {
      try {
        await api(`/receptions/${attemptId}/finish`, { token: tokens.agent, method: 'POST', body: {} });
      } catch {
        /* 已经结束就忽略 */
      }
    }
    fs.rmSync(probe, { force: true });
  }

  const failed = results.filter((item) => !item.ok);
  // 只有全量跑才写看板数据：带 --no-layout / --no-deep 的局部跑会把「16/16」这类子集数字
  // 覆盖掉全量结果，看板上就会误显示成「渲染只有 16 项」。
  if (!SKIP_LAYOUT && !NO_DEEP) {
    writeBrowserCheck('render', results.length, results.length - failed.length, failed.map((item) => item.name));
  }
  results.forEach((item) => console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name.padEnd(30)} ${item.detail}`));
  console.log(`\n页面渲染自检：${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('渲染自检失败：', error.message);
  console.error('请确认接口服务（3000）与前端预览（4173）都在跑，且 frontend/dist 已构建。');
  process.exit(1);
});
