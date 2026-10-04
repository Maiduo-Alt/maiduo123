#!/usr/bin/env node
/**
 * 交互流程自检：在真实浏览器里「真的点一下」，确认弹窗 / 抽屉 / 页签会打开且内容正确。
 *
 * 为什么需要它：tools/render-check.mjs 只能证明「页面渲染出来了」，证明不了「点按钮有反应」。
 * 组件里一个异常就会把整棵 React 树卸载成白屏（案例收藏的标签下拉曾因分组 options 写法不对
 * 直接白屏），静态渲染检查抓不到，只有真的点一次才看得见。
 *
 * 用法：
 *   npm run flow:check          # 全量
 *   node tools/flow-check.mjs --list
 *
 * 前置：接口服务（3000）与前端预览（4173）都在跑，frontend/dist 已构建；需要放行浏览器进程。
 * 说明：会在 frontend/dist 与 docs 下临时写探针页，跑完自动删除；接待页用例会真开一局训练并结束它。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = process.env.RENDER_APP || 'http://127.0.0.1:4173';
const BOARD = process.env.PROGRESS_BASE || 'http://127.0.0.1:4180';
const API = process.env.SMOKE_BASE || 'http://127.0.0.1:3000';
const TMP = os.tmpdir();
const LIST_ONLY = process.argv.includes('--list');
/** --shot-flows=目录：跑每个交互用例时顺便截图（人工看弹窗/抽屉的排版用） */
const SHOT_FLOWS_DIR = (process.argv.find((arg) => arg.startsWith('--shot-flows=')) || '').split('=')[1] || '';

const BROWSERS = [
  process.env.RENDER_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].filter(Boolean);
const browser = BROWSERS.find((candidate) => fs.existsSync(candidate));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 把本次结果合并进 docs/浏览器自检.json（另一个工具的键保留），供验收看板显示。 */
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

/** 探针页：把登录态写进 localStorage，再用 iframe 打开目标路由，在 iframe 上下文里执行注入脚本。 */
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
    if (!d) return set({ ok:false, reason:'取不到 iframe 文档（跨域？）' });
    const fn = new Function('d','sleep','return (async () => {' + decodeURIComponent(q.get('js') || '') + '})();');
    set(await fn(d, sleep));
  } catch (e) { set({ ok:false, reason:'脚本异常: ' + e.message }); }
}, Number(q.get('wait') || 6000));
f.src = q.get('to') || '/';
</script></body></html>`;

/** 每个流程：点哪里、点什么、应该看到什么。返回 { ok, reason, evidence }。 */
const FLOWS = [
  {
    // 客户新增需求 C2：客服不开放自由练习——菜单里不能有「在线模拟接待」，
    // 首页也不能出现难度档位/快速开始卡（此前只有代码标记，这里补运行时证据）
    name: '客服侧 · 入口收敛（无在线模拟接待）',
    role: 'agent',
    to: '/',
    js: `
      await sleep(1200);
      const nav = d.querySelector('.ant-layout-sider') || d.body;
      const navText = nav.innerText;
      const pageText = d.body.innerText;
      const hasMine = navText.includes('我的任务') && navText.includes('模拟接待明细');
      const noReception = !navText.includes('在线模拟接待');
      const noQuickStart = !pageText.includes('难度档位与快速开始');
      const ok = hasMine && noReception && noQuickStart;
      return {
        ok,
        reason: ok ? '' : '菜单含我的任务=' + hasMine + '，含在线模拟接待=' + !noReception + '，首页有快速开始=' + !noQuickStart,
        evidence: '菜单含 我的任务/模拟接待明细 且不含 在线模拟接待；首页无难度快速开始',
      };`,
  },
  {
    // 方案 4.4：难度逐步解锁——未解锁的档位在界面上必须点不动（任务允许也不行）。
    // 断言的是不变式「显示未解锁 ⇒ 按钮禁用」，所以不依赖当前解锁到哪一档。
    name: '接待页 · 未解锁难度不可开局',
    role: 'agent',
    to: null,
    prepare: async (apiCall, tokens) => {
      // 注意：这里**不要**去结束客服在跑的接待——主流程的两条接待页用例共用 main() 准备的那一局。
      // 本用例只打开「带 taskId 的开局界面」看难度卡的可用状态，不需要动任何进行中的接待。
      const tasks = await apiCall('/tasks', { token: tokens.agent });
      const task = tasks.find((row) => row.status === 'running') || tasks[0];
      if (!task) throw new Error('客服没有可用任务，先跑一次 npm run demo:data');
      return { route: `/reception?taskId=${task.id}` };
    },
    js: `
      await sleep(1500);
      const cards = [...d.querySelectorAll('.ant-card')];
      const rows = ['L1', 'L2', 'L3', 'L4'].map((code) => {
        const card = cards.find((c) => ((c.querySelector('.ant-card-head-title') || {}).textContent || '').trim().startsWith(code));
        if (!card) return null;
        const locked = card.textContent.includes('未解锁');
        const buttons = [...card.querySelectorAll('button')];
        const allDisabled = buttons.length > 0 && buttons.every((b) => b.disabled);
        return { code, locked, allDisabled };
      }).filter(Boolean);
      if (!rows.length) return { ok:false, reason:'一个难度卡都没找到' };
      // 不变式：显示「未解锁」的档位必须整卡按钮禁用
      const bad = rows.filter((r) => r.locked && !r.allDisabled);
      const anyEnabled = rows.some((r) => !r.allDisabled);
      const ok = bad.length === 0 && anyEnabled;
      return {
        ok,
        reason: ok ? '' : '未解锁却可点：' + bad.map((r) => r.code).join('、') + '；有可开局档位=' + anyEnabled,
        evidence: rows.map((r) => r.code + (r.locked ? '（未解锁·禁用）' : '（可开局）')).join(' '),
      };`,
  },
  {
    // 客户 2026-10-03：推送的问题要区分售前/售后，右栏订单卡片按「发货」这个节点给出对应状态的订单。
    // 真点开右栏「订单」页签 → 读卡片 → 点卡片里的「发送」确认内容进输入框。
    name: '接待页 · 右栏订单卡片与问题阶段一致',
    role: 'leader',
    to: null,
    wait: 8000,
    budget: 60000,
    prepare: async (apiCall, tokens) => {
      const current = await apiCall('/receptions/current', { token: tokens.leader }).catch(() => null);
      if (current?.attemptId) {
        await apiCall(`/receptions/${current.attemptId}/finish`, { token: tokens.leader, method: 'POST', body: {} }).catch(() => {});
      }
      const started = await apiCall('/receptions', { token: tokens.leader, method: 'POST', body: { level: 'L1', source: 'free' } });
      return { route: `/reception?attemptId=${started.attemptId}` };
    },
    cleanup: async (apiCall, tokens) => {
      const current = await apiCall('/receptions/current', { token: tokens.leader }).catch(() => null);
      if (current?.attemptId) {
        await apiCall(`/receptions/${current.attemptId}/finish`, { token: tokens.leader, method: 'POST', body: {} }).catch(() => {});
      }
    },
    js: `
      await sleep(2500);
      const tab = [...d.querySelectorAll('.ant-tabs-tab')].find((t) => t.textContent.trim() === '订单');
      if (!tab) return { ok:false, reason:'右栏没有「订单」页签' };
      tab.click();
      await sleep(1500);
      const card = d.querySelector('.order-card');
      if (!card) return { ok:false, reason:'订单页签下没有渲染订单卡片' };
      const text = d.body.innerText;
      const stages = ['待支付', '待发货', '已发货'].filter((s) => text.includes(s));
      if (!stages.length) return { ok:false, reason:'订单卡片上没有出现三种状态标签' };
      const hasFields = ['规格', '收货信息'].every((k) => text.includes(k)) && (text.includes('订单金额') || text.includes('实付金额'));
      if (!hasFields) return { ok:false, reason:'订单卡片缺少参考图里的字段', evidence: stages.join('/') };
      // 买家消息头上有售前/售后标签，订单状态必须跟它一致（以发货为节点）
      const heads = [...d.querySelectorAll('.message-head')].map((h) => h.textContent || '');
      const stage = heads.some((h) => h.includes('售后')) ? '售后' : heads.some((h) => h.includes('售前')) ? '售前' : '';
      if (!stage) return { ok:false, reason:'买家消息上没有售前/售后标签', evidence: stages.join('/') };
      const consistent = stage === '售后' ? stages.includes('已发货') : stages.includes('待支付') || stages.includes('待发货');
      if (!consistent) return { ok:false, reason: stage + '问题配了 ' + stages.join('/') + ' 的订单' };
      // 卡片里的「发送」把该行内容插进输入框（训练环境里是真行为）
      const sendLink = [...card.querySelectorAll('a, .ant-typography')].find((el) => (el.textContent || '').trim() === '发送');
      let inserted = false;
      if (sendLink) {
        sendLink.click();
        await sleep(400);
        const ta = d.querySelector('.reception-input textarea');
        inserted = !!(ta && ta.value.trim());
        if (inserted) {
          // 清空，免得影响后面的「业务动作」断言
          const win = d.defaultView;
          const setter = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value').set;
          setter.call(ta, '');
          ta.dispatchEvent(new win.Event('input', { bubbles: true }));
        }
      }
      /**
       * 客户 2026-10-03：平台侧操作「点击后记为一次业务动作」。
       * 真点一个卡片上的动作按钮（催付 / 去发货 / 发物流卡，跟着当前订单状态走），
       * 断言：按钮可用 → 出现成功提示 → 对话里留下「业务动作 · xxx」的标记。
       */
      const actionName = stages.includes('待支付') ? '催付' : stages.includes('待发货') ? '去发货' : '发物流卡';
      // AntD 会在两个汉字之间插空格（「催 付」），比较时统一去掉空白
      const norm = (value) => String(value || '').replace(/\\s/g, '');
      const actionBtn = [...card.querySelectorAll('button')].find((b) => norm(b.textContent) === norm(actionName));
      if (!actionBtn) return { ok:false, reason:'订单卡片上没找到「' + actionName + '」按钮', evidence: stages.join('/') };
      if (actionBtn.disabled) return { ok:false, reason:'「' + actionName + '」按钮是禁用的（应可点击记为业务动作）' };
      actionBtn.click();
      await sleep(2500);
      const afterText = d.body.innerText;
      const recorded = afterText.includes('已记为一次业务动作');
      const marked = afterText.includes('业务动作 · ' + actionName);
      const ok = consistent && inserted && recorded && marked;
      return {
        ok,
        reason: ok
          ? ''
          : [
              inserted ? '' : '卡片「发送」没有把内容插进输入框',
              recorded ? '' : '点业务动作后没有出现「已记为一次业务动作」提示',
              marked ? '' : '对话里没有留下「业务动作 · ' + actionName + '」标记',
            ].filter(Boolean).join('；'),
        evidence:
          '问题维度=' + stage + '，订单状态=' + stages.join('/') + '，字段齐全，发送入输入框=' + inserted +
          '，业务动作「' + actionName + '」已记录=' + recorded + '，对话留痕=' + marked,
      };`,
  },
  {
    // 验收主链路（验收指引「5 分钟快速路径」第 1 步）：开局 → 买家进线 → 回复 → 评分弹窗
    name: '完整接待链路 · 开局→回复→评分',
    role: 'leader',
    to: '/reception',
    wait: 9000,
    budget: 70000,
    prepare: async (apiCall, tokens) => {
      const current = await apiCall('/receptions/current', { token: tokens.leader }).catch(() => null);
      if (current?.attemptId) {
        await apiCall(`/receptions/${current.attemptId}/finish`, { token: tokens.leader, method: 'POST', body: {} }).catch(() => {});
      }
      return {};
    },
    cleanup: async (apiCall, tokens) => {
      const current = await apiCall('/receptions/current', { token: tokens.leader }).catch(() => null);
      if (current?.attemptId) {
        await apiCall(`/receptions/${current.attemptId}/finish`, { token: tokens.leader, method: 'POST', body: {} }).catch(() => {});
      }
    },
    js: `
      const win = d.defaultView;
      const step = [];
      const startBtn = [...d.querySelectorAll('button')].find((b) => b.textContent.trim() === '开始接待');
      if (!startBtn) return { ok:false, reason:'难度卡上没找到「开始接待」按钮' };
      startBtn.click();
      await sleep(6000);
      const t1 = d.body.innerText;
      if (!t1.includes('结束本次接待并生成评分')) return { ok:false, reason:'点了开始接待但没进入接待页', evidence: t1.slice(0, 60).replace(/\\s+/g, ' ') };
      step.push('已开局');
      if (/买家\\d+/.test(t1)) step.push('买家已进线');

      const textarea = d.querySelector('.reception-input textarea');
      if (!textarea) return { ok:false, reason:'接待页没有输入框', evidence: step.join(' → ') };
      const setter = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, '亲，您好，我马上帮您核实一下，还有其他可以帮您的吗？');
      textarea.dispatchEvent(new win.Event('input', { bubbles: true }));
      await sleep(400);
      const send = [...d.querySelectorAll('.reception-send-row button')].find((b) => b.textContent.includes('发送'));
      if (!send) return { ok:false, reason:'没找到发送按钮', evidence: step.join(' → ') };
      send.click();
      await sleep(2500);
      const t2 = d.body.innerText;
      if (t2.includes('响应')) step.push('已出现响应时长');

      const finish = [...d.querySelectorAll('button')].find((b) => b.textContent.includes('结束本次接待'));
      if (!finish) return { ok:false, reason:'没找到「结束本次接待」按钮', evidence: step.join(' → ') };
      finish.click();
      await sleep(4000);
      const t3 = d.body.innerText;
      const ok = t3.includes('本次接待结果') && t3.includes('接待总分');
      return {
        ok,
        reason: ok ? '' : '结束后没出现评分弹窗（缺「本次接待结果 / 接待总分」）',
        evidence: step.join(' → ') + (ok ? ' → 评分弹窗已出现' : ''),
      };`,
  },
  {
    name: '案例收藏 · 编辑弹窗',
    role: 'leader',
    to: '/cases',
    js: `
      const b = [...d.querySelectorAll('button')].find((x) => x.textContent.trim() === '编辑');
      if (!b) return { ok:false, reason:'没找到「编辑」按钮' };
      b.click(); await sleep(2500);
      const t = d.body.innerText;
      const ok = t.includes('编辑案例') && t.includes('案例标题') && t.includes('标签');
      return { ok, reason: ok ? '' : '点击后没有出现「编辑案例」弹窗（页面文本长度 ' + t.length + '）', evidence: t.slice(0, 60).replace(/\\s+/g, ' ') };`,
  },
  {
    // 方案 F5-06 / F5-07：案例详情里能标记「优秀回复」，标记后会作为转咨询内容的参考答案
    name: '案例收藏 · 优秀回复标记',
    role: 'leader',
    to: '/cases',
    js: `
      await sleep(800);
      const view = [...d.querySelectorAll('button')].find((b) => b.textContent.trim() === '查看');
      if (!view) return { ok:false, reason:'没找到「查看」按钮' };
      view.click();
      await sleep(2000);
      const drawerButtons = () => [...d.querySelectorAll('.ant-drawer button')];
      // 幂等：上一次跑可能已经标过（按钮会变成「取消优秀」），先取消再标记
      const already = drawerButtons().find((b) => b.textContent.includes('取消优秀'));
      if (already) {
        already.click();
        await sleep(1800);
      }
      const mark = drawerButtons().find((b) => b.textContent.includes('标为优秀回复'));
      if (!mark) return { ok:false, reason:'案例详情里没有「标为优秀回复」入口' };
      mark.click();
      await sleep(2000);
      const tagged = [...d.querySelectorAll('.ant-drawer .ant-tag')].some((x) => x.textContent.includes('优秀回复'));
      return {
        ok: tagged,
        reason: tagged ? '' : '点击后没有出现「优秀回复」标签',
        evidence: tagged ? '案例详情可标记优秀回复，标记后显示标签' : '',
      };`,
  },
  {
    name: '案例收藏 · 文件导入弹窗',
    role: 'leader',
    to: '/cases',
    js: `
      const b = [...d.querySelectorAll('button')].find((x) => x.textContent.includes('导入文件'));
      if (!b) return { ok:false, reason:'没找到「导入文件」按钮' };
      b.click(); await sleep(2500);
      const t = d.body.innerText;
      const ok = t.includes('导入会话文件') && t.includes('下载模板') && t.includes('会话文件');
      return { ok, reason: ok ? '' : '点击后没有出现文件导入弹窗', evidence: t.slice(0, 60).replace(/\\s+/g, ' ') };`,
  },
  {
    // 参考图 4：新建聊天剧本弹窗要分「基础设置 / 剧本信息 / 剧本内容」三段，
    // 并带创建模式、创建方式、剧本分类、接待类型、关联商品、背景/内容多选
    name: '客户问题剧本 · 新建剧本弹窗',
    role: 'leader',
    to: '/scripts',
    js: `
      await sleep(1000);
      const btn = [...d.querySelectorAll('button')].find((b) => b.textContent.trim() === '新建剧本');
      if (!btn) return { ok:false, reason:'没找到「新建剧本」按钮' };
      btn.click();
      await sleep(2500);
      const t = d.body.innerText;
      const need = ['基础设置', '剧本信息', '剧本内容', '创建模式', '创建方式', '剧本分类', '接待类型', '关联商品', '买家咨询背景', '买家咨询内容'];
      const missing = need.filter((k) => !t.includes(k));
      const modal = d.querySelector('.ant-modal');
      // 再等 6 秒复查一次：既能验证弹窗不会被"莫名关掉"，也让截图有机会拍到它
      await sleep(6000);
      const stillOpen = !!d.querySelector('.ant-modal');
      const ok = !!modal && missing.length === 0 && stillOpen;
      return {
        ok,
        reason: ok ? '' : '弹窗缺少段落/字段：' + (missing.join('、') || '无') + '；6 秒后仍在=' + stillOpen,
        evidence: '三段与各字段齐全；弹窗宽 ' + (modal ? Math.round(modal.getBoundingClientRect().width) : 0) + 'px；6 秒后仍在=' + stillOpen,
      };`,
  },
  {
    name: '客户问题剧本 · 统计抽屉',
    role: 'leader',
    to: '/scripts',
    js: `
      const b = [...d.querySelectorAll('button')].find((x) => x.textContent.trim() === '剧本统计');
      if (!b) return { ok:false, reason:'没找到「剧本统计」按钮' };
      b.click(); await sleep(2500);
      const t = d.body.innerText;
      const ok = t.includes('剧本统计') && t.includes('最需要补练的剧本') && t.includes('超时率');
      return { ok, reason: ok ? '' : '统计抽屉里没出现「最需要补练的剧本 / 超时率」', evidence: (t.slice(t.indexOf('剧本统计'), t.indexOf('剧本统计') + 60) || t.slice(0, 60)).replace(/\\s+/g, ' ') }; `,
  },
  {
    name: '模拟接待明细 · 对比所选',
    role: 'leader',
    to: '/records',
    js: `
      await sleep(800);
      const boxes = [...d.querySelectorAll('tbody .ant-checkbox-input')];
      if (boxes.length < 2) return { ok:false, reason:'明细不足 2 条，无法对比（当前 ' + boxes.length + ' 行）' };
      boxes[0].click(); await sleep(200); boxes[1].click(); await sleep(800);
      const btn = [...d.querySelectorAll('button')].find((x) => x.textContent.includes('对比所选'));
      if (!btn) return { ok:false, reason:'没找到「对比所选」按钮' };
      btn.click(); await sleep(2500);
      const t = d.body.innerText;
      const ok = t.includes('接待对比') && t.includes('最慢首响');
      return { ok, reason: ok ? '' : '对比抽屉里没出现「最慢首响」', evidence: (t.slice(t.indexOf('接待对比'), t.indexOf('接待对比') + 60) || '').replace(/\\s+/g, ' ') };`,
  },
  {
    name: '回复模拟任务 · 任务报表',
    role: 'leader',
    to: '/tasks',
    js: `
      await sleep(600);
      const b = [...d.querySelectorAll('button')].find((x) => x.textContent.trim() === '查看报表');
      if (!b) return { ok:false, reason:'没找到「查看报表」按钮（是否还没有任务？）' };
      b.click(); await sleep(2500);
      const t = d.body.innerText;
      // 带教视角的列表列是「完成人数」（客服视角是「我的进度」），两个口径不能混
      const ok = t.includes('任务报表') && t.includes('已完成次数') && t.includes('完成率') && t.includes('完成人数');
      return { ok, reason: ok ? '' : '报表抽屉里没出现「已完成次数 / 完成率」，或列表缺少「完成人数」列', evidence: (t.slice(t.indexOf('任务报表'), t.indexOf('任务报表') + 80) || '').replace(/\\s+/g, ' ') };`,
  },
  {
    // 方案 F1-04 / F1-05：左栏会话队列与「切换会话不丢状态」。
    // 客户 2026-10-03：列表项改成飞鸽样式——圆形头像（内含编号）+ 昵称 + 时间 + 最后一条消息预览。
    name: '接待页 · 会话队列与切换',
    role: 'agent',
    to: null,
    js: `
      await sleep(1500);
      const items = [...d.querySelectorAll('.conversation-item')];
      if (items.length < 2) return { ok:false, reason:'队列里会话不足 2 个（当前 ' + items.length + '）' };
      const first = items[0].innerText.replace(/\\s+/g, ' ');
      const hasIndex = /\\d{2}/.test(first);
      const hasAvatar = !!items[0].querySelector('.conversation-avatar');
      const hasTime = !!items[0].querySelector('.conversation-time');
      const preview = (items[0].querySelector('.conversation-preview') || {}).textContent || '';
      const beforeName = (d.querySelector('.center-buyer-name') || {}).textContent || '';
      items[1].click();
      await sleep(1200);
      const afterName = (d.querySelector('.center-buyer-name') || {}).textContent || '';
      const stillThere = d.querySelectorAll('.conversation-item').length >= 2;
      const ok = hasIndex && hasAvatar && hasTime && preview.length > 0 && afterName !== beforeName && afterName.length > 0 && stillThere;
      return {
        ok,
        reason:
          ok
            ? ''
            : '编号=' + hasIndex + ' 头像=' + hasAvatar + ' 时间=' + hasTime + ' 预览=' + JSON.stringify(preview.slice(0, 20)) +
              ' 昵称变化=' + (afterName !== beforeName) + ' 会话仍在=' + stillThere,
        evidence:
          '队列项含圆形头像编号/时间/预览（预览：' + preview.slice(0, 16) + '…）；切换后顶部昵称 ' +
          beforeName + ' → ' + afterName + '，两个会话都还在',
      };`,
  },
  {
    // 方案 F1-08 / F4-09：把咨询商品卡片插入对话流
    name: '接待页 · 商品卡片插入对话',
    role: 'agent',
    to: null,
    js: `
      await sleep(1200);
      const win = d.defaultView;
      const buttons = [...d.querySelectorAll('.reception-toolbar .ant-btn')].filter((b) => !b.disabled);
      const target = buttons.find((b) => b.querySelector('.anticon-shopping'));
      if (!target) return { ok:false, reason:'没找到「插入商品卡片」按钮（可用按钮 ' + buttons.length + ' 个）' };
      // 第一步：插入 → 输入框里应出现商品卡片文本（F1-08「可插入到对话流」）
      target.click();
      await sleep(800);
      const textarea = d.querySelector('.reception-input textarea');
      const drafted = String((textarea || {}).value || '');
      if (!drafted.includes('【商品卡片】') || !drafted.includes('商品ID')) {
        return { ok:false, reason:'点按钮后输入框里没有商品卡片文本（' + drafted.slice(0, 40) + '）' };
      }
      // 第二步：发送 → 对话流里应出现商品卡片气泡（F4-09「发给买家」）
      // 客服发出的商品卡片渲染成飞鸽式商品卡 .feige-product-card（首条「咨询宝贝」才是 .message-bubble-card）
      const before = d.querySelectorAll('.feige-product-card').length;
      const send = [...d.querySelectorAll('.reception-send-row button')].find((b) => b.textContent.includes('发送'));
      if (!send) return { ok:false, reason:'没找到发送按钮', evidence: '已插入输入框' };
      send.click();
      await sleep(2500);
      const after = d.querySelectorAll('.feige-product-card').length;
      return {
        ok: after > before,
        reason: after > before ? '' : '发送后对话流里没有出现商品卡片气泡（' + before + ' → ' + after + '）',
        evidence: '插入输入框 ✓；发送后商品卡片气泡 ' + before + ' → ' + after,
      };`,
  },
  {
    name: '接待页 · 飞鸽版式元素',
    role: 'agent',
    to: null, // 运行中的接待页，运行时替换
    js: `
      await sleep(800);
      const t = d.body.innerText;
      const actions = d.querySelectorAll('.center-header-actions .ant-btn').length;
      const hint = (d.querySelector('.reception-input-hint') || {}).textContent || '';
      const card = d.querySelectorAll('.message-bubble-card').length;
      /** 客户 2026-10-03：输入区提示改成飞鸽的「发送给 X，使用 Enter 发送消息…」+ 字数计数 */
      const count = (d.querySelector('.reception-input-count') || {}).textContent || '';
      const tags = d.querySelectorAll('.center-header-tags .ant-tag').length;
      const ok =
        actions >= 5 &&
        hint.includes('发送给') &&
        hint.includes('使用 Enter 发送消息') &&
        /\\d+\\/\\d+/.test(count) &&
        card >= 1 &&
        tags >= 1 &&
        t.includes('结束本次接待并生成评分');
      return {
        ok,
        reason: ok
          ? ''
          : '会话头图标 ' + actions + ' 个 / 输入提示「' + hint + '」/ 字数「' + count + '」/ 商品卡 ' + card + ' 个 / 顶部标签 ' + tags + ' 个',
        evidence: '会话头图标 ' + actions + ' 个；输入提示「' + hint.trim() + '」；字数 ' + count + '；顶部信息标签 ' + tags + ' 个',
      };`,
  },
  {
    name: '接待页 · 右栏切到快捷短语',
    role: 'agent',
    to: null,
    js: `
      await sleep(800);
      const tab = [...d.querySelectorAll('.ant-tabs-tab')].find((x) => x.textContent.includes('快捷短语'));
      if (!tab) return { ok:false, reason:'没找到「快捷短语」页签', evidence: [...d.querySelectorAll('.ant-tabs-tab')].map((x) => x.textContent.trim()).join(' / ') };
      tab.click(); await sleep(1800);
      const t = d.body.innerText;
      const ok = t.includes('用过');
      return { ok, reason: ok ? '' : '切到快捷短语后没看到「用过 N 次」', evidence: t.slice(-80).replace(/\\s+/g, ' ') };`,
  },
  {
    name: '内容库预览 · 页签切换',
    role: null,
    to: '/docs/' + encodeURIComponent('内容库预览.html'),
    base: 'board',
    js: `
      const tab = [...d.querySelectorAll('.tab')].find((x) => x.textContent.includes('客户问题剧本'));
      if (!tab) return { ok:false, reason:'没找到「客户问题剧本」页签' };
      tab.click(); await sleep(600);
      const t = d.body.innerText;
      const ok = t.includes('共 900 条') && t.includes('SC20261001-');
      return { ok, reason: ok ? '' : '切到剧本页签后没有 900 条剧本', evidence: (t.match(/共 \\d+ 条[^，]*/) || [''])[0] };`,
  },
  {
    // 客户新增需求 C5：总量多于同时在线时，左栏要能看出「剩余会话」与「待接入」；
    // 客户 2026-10-03（对齐赤兔火眼）：接待买家 = **累计已进线**，不含还在排队的
    name: '接待页 · C5 待接入与「接待买家=累计已进线」',
    role: 'admin',
    to: null,
    prepare: async (apiCall, tokens) => {
      const current = await apiCall('/receptions/current', { token: tokens.admin }).catch(() => null);
      if (current?.attemptId) {
        await apiCall(`/receptions/${current.attemptId}/finish`, { token: tokens.admin, method: 'POST', body: {} }).catch(() => {});
      }
      await apiCall('/settings', {
        token: tokens.admin,
        method: 'PUT',
        body: { maxConcurrent: 4, levelConcurrent: { L2: 2 }, levelTotal: { L2: 4 } },
      });
      const started = await apiCall('/receptions', {
        token: tokens.admin,
        method: 'POST',
        body: { level: 'L2', source: 'free' },
      });
      return { route: `/reception?attemptId=${started.attemptId}`, attemptId: started.attemptId };
    },
    cleanup: async (apiCall, tokens, ctx) => {
      if (ctx?.attemptId) {
        await apiCall(`/receptions/${ctx.attemptId}/finish`, { token: tokens.admin, method: 'POST', body: {} }).catch(() => {});
      }
      // 恢复「总接待人数留空 = 按接入人数兜底」，避免影响后续验收
      await apiCall('/settings', { token: tokens.admin, method: 'PUT', body: { levelTotal: {} } }).catch(() => {});
    },
    js: `
      await sleep(1200);
      const t = d.body.innerText;
      // 客户 2026-10-03：左栏顶部改成飞鸽式横幅，计数在这一行里（原来是 2×2 网格）
      const banner = (d.querySelector('.reception-banner-text') || {}).textContent || '';
      const stat = (label) => {
        const m = new RegExp(label + '\\\\s*(\\\\d+)').exec(banner);
        return m ? m[1] : null;
      };
      const remaining = stat('剩余会话');
      // 「当前会话」页签里不该出现待接入的买家（客户 2026-10-03）
      const servingRows = d.querySelectorAll('.conversation-item').length;
      const tabText = [...d.querySelectorAll('.queue-tab')].map((x) => x.textContent.trim()).join(' | ');
      // 切到「待接入」页签，确认排队买家单独列在这里
      const pendingTab = [...d.querySelectorAll('.queue-tab')].find((x) => x.textContent.includes('待接入'));
      if (!pendingTab) return { ok:false, reason:'左栏没有「待接入」页签', evidence: tabText };
      pendingTab.click();
      await sleep(700);
      const pendingTags = [...d.querySelectorAll('.conversation-item .ant-tag')].filter((x) => x.textContent.includes('待接入')).length;
      // 本局：L2 合计 4 人、同时在线 2 人 → 接待买家(已进线)=2、剩余会话(排队)=2
      const ok =
        remaining === '2' &&
        stat('接待买家') === '2' &&
        servingRows === 2 &&
        pendingTags === 2 &&
        t.includes('接待买家') &&
        tabText.includes('当前会话');
      return {
        ok,
        reason: ok
          ? ''
          : '左栏横幅「' + banner.trim() + '」' +
            '，待接入标签 ' + pendingTags + ' 个，正在接待页签行数 ' + servingRows + '，页签：' + tabText,
        evidence:
          '横幅：' + banner.replace(/\\s+/g, ' ').trim() + '；当前会话=' + servingRows + '（页签 ' + tabText + '），' +
          '剩余会话(排队)=' + remaining + '，待接入标签 ' + pendingTags + ' 个',
      };`,
  },
  {
    // 客户 2026-10-03：会话页对齐飞鸽——商品卡带动作按钮，点「规格/属性」要看到
    // 管理员在《商品库》里配的真实商品信息（规格 SKU / 售价 / 库存 / 分类 / 服务承诺 / 适用场景）。
    name: '接待页 · 商品「规格/属性」显示商品库真实信息',
    role: 'admin',
    to: null,
    wait: 6000,
    budget: 50000,
    prepare: async (apiCall, tokens) => {
      const current = await apiCall('/receptions/current', { token: tokens.admin }).catch(() => null);
      if (current?.attemptId) {
        await apiCall(`/receptions/${current.attemptId}/finish`, { token: tokens.admin, method: 'POST', body: {} }).catch(() => {});
      }
      const started = await apiCall('/receptions', { token: tokens.admin, method: 'POST', body: { level: 'L1', source: 'free' } });
      return { route: `/reception?attemptId=${started.attemptId}`, attemptId: started.attemptId };
    },
    cleanup: async (apiCall, tokens, ctx) => {
      if (ctx?.attemptId) {
        await apiCall(`/receptions/${ctx.attemptId}/finish`, { token: tokens.admin, method: 'POST', body: {} }).catch(() => {});
      }
    },
    js: `
      await sleep(1500);
      const card = d.querySelector('.feige-product-card');
      if (!card) return { ok:false, reason:'对话区没有渲染飞鸽式商品卡' };
      const specBtn = [...card.querySelectorAll('.feige-product-actions button')].find((b) => (b.textContent || '').includes('规格'));
      if (!specBtn) return { ok:false, reason:'商品卡上没有「规格/属性」按钮' };
      specBtn.click();
      await sleep(1200);
      const modal = d.querySelector('.ant-modal-content');
      const t = modal ? modal.innerText : '';
      if (!t) return { ok:false, reason:'点了「规格/属性」没有弹出窗口' };
      const need = ['规格 / 属性', '商品ID', '商品分类', '总库存', '上架状态', '规格（SKU）', '服务承诺', '适用场景'];
      const missing = need.filter((k) => !t.includes(k));
      // SKU 表要么有数据行，要么给出「还没维护规格」的明确提示，不能是空白
      const skuRows = modal.querySelectorAll('.ant-table-tbody tr').length;
      const hasHint = t.includes('还没有维护规格');
      const ok = missing.length === 0 && (skuRows > 0 || hasHint);
      return {
        ok,
        reason: ok ? '' : '弹窗缺字段：' + missing.join(' / ') + '；SKU 行数 ' + skuRows,
        evidence: '弹窗字段齐全；SKU 行数 ' + skuRows + '；' + t.replace(/\\s+/g, ' ').slice(0, 80),
      };`,
  },
  {
    // 客户 2026-10-03：商品库要能维护「规格（SKU）」，否则接待页的属性就成了死数据
    name: '商品库 · 编辑弹窗可维护规格（SKU）',
    role: 'admin',
    to: '/products',
    js: `
      await sleep(1200);
      const edit = [...d.querySelectorAll('button')].find((b) => b.textContent.trim() === '编辑');
      if (!edit) return { ok:false, reason:'商品列表里没有「编辑」按钮' };
      edit.click();
      await sleep(2000);
      const t = d.body.innerText;
      const hasField = t.includes('规格（SKU）');
      const hasAdd = [...d.querySelectorAll('.ant-modal button')].some((b) => (b.textContent || '').includes('添加规格'));
      const inputs = d.querySelectorAll('.ant-modal .ant-form-item input').length;
      const ok = hasField && hasAdd;
      return {
        ok,
        reason: ok ? '' : '商品编辑弹窗里没有「规格（SKU）」维护入口（字段=' + hasField + '，添加按钮=' + hasAdd + '）',
        evidence: '编辑弹窗含「规格（SKU）」字段与「添加规格」按钮；弹窗内输入框 ' + inputs + ' 个',
      };`,
  },
  {
    // 客户新增需求 C6：同轮连发一模一样的话，要当场提醒并给该条消息打标
    name: '接待页 · C6 无效回复当场预警',
    role: 'admin',
    to: null,
    prepare: async (apiCall, tokens) => {
      const current = await apiCall('/receptions/current', { token: tokens.admin }).catch(() => null);
      if (current?.attemptId) {
        await apiCall(`/receptions/${current.attemptId}/finish`, { token: tokens.admin, method: 'POST', body: {} }).catch(() => {});
      }
      await apiCall('/settings', {
        token: tokens.admin,
        method: 'PUT',
        body: {
          invalidReplyEnabled: true,
          invalidReplyDuplicateMode: 'identical',
          invalidReplyDuplicateStreak: 3,
          maxConcurrent: 4,
          levelConcurrent: { L1: 1 },
          levelTotal: {},
        },
      });
      const started = await apiCall('/receptions', {
        token: tokens.admin,
        method: 'POST',
        body: { level: 'L1', source: 'free' },
      });
      return { route: `/reception?attemptId=${started.attemptId}`, attemptId: started.attemptId };
    },
    cleanup: async (apiCall, tokens, ctx) => {
      if (ctx?.attemptId) {
        await apiCall(`/receptions/${ctx.attemptId}/finish`, { token: tokens.admin, method: 'POST', body: {} }).catch(() => {});
      }
      await apiCall('/settings', {
        token: tokens.admin,
        method: 'PUT',
        body: { invalidReplyEnabled: false, banalWords: [] },
      }).catch(() => {});
    },
    js: `
      await sleep(2500);
      const win = d.defaultView;
      const textarea = d.querySelector('.reception-input textarea');
      if (!textarea) return { ok:false, reason:'没找到输入框' };
      const setter = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value').set;
      const text = '亲，您好，我马上帮您核实一下，还有其他可以帮您的吗？';
      for (let i = 0; i < 2; i += 1) {
        setter.call(textarea, text);
        textarea.dispatchEvent(new win.Event('input', { bubbles: true }));
        await sleep(300);
        const send = [...d.querySelectorAll('.reception-send-row button')].find((b) => b.textContent.includes('发送'));
        if (!send) return { ok:false, reason:'没找到发送按钮' };
        send.click();
        await sleep(2000);
      }
      const t = d.body.innerText;
      const toast = (d.querySelector('.ant-message') || {}).textContent || '';
      const tagged = [...d.querySelectorAll('.message-meta .ant-tag')].some((x) => x.textContent.includes('被判无效回复'));
      const ok = t.includes('被判无效回复') && (toast.includes('被判无效回复') || tagged);
      return {
        ok,
        reason: ok ? '' : '没有出现「被判无效回复」提示或标签（toast=' + toast.slice(0, 40) + '）',
        evidence: (toast || '页面已标记该条消息').replace(/\\s+/g, ' ').slice(0, 60),
      };`,
  },
];

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

function runFlow(flow, tokens, probeDir) {
  const probe = path.join(probeDir, '__flow-probe.html');
  fs.writeFileSync(probe, PROBE_HTML);
  const base = flow.base === 'board' ? BOARD : APP;
  // 看板服务的探针放在 docs 下，通过 /docs/... 访问；前端预览的探针直接放 dist 根
  const probePath = flow.base === 'board' ? '/docs/__flow-probe.html' : '/__flow-probe.html';
  const wait = flow.wait || 7000;
  const budget = flow.budget || wait + 14000;
  const url =
    `${base}${probePath}?t=${encodeURIComponent(tokens[flow.role] || '')}` +
    `&to=${encodeURIComponent(flow.to)}&js=${encodeURIComponent(flow.js)}&wait=${wait}`;
  try {
    // 需要人工看排版时：同一次跑用 --screenshot 再跑一遍（用例里的点击会重新执行，
    // 截图取的是「注入脚本跑完、弹窗已经打开」那一刻的探针页）。
    if (SHOT_FLOWS_DIR) {
      fs.mkdirSync(SHOT_FLOWS_DIR, { recursive: true });
      const shotFile = path.join(SHOT_FLOWS_DIR, `${flow.name.replace(/[\\/:*?"<>|\s]+/g, '-')}.png`);
      spawnSync(
        browser,
        [
          '--headless=old',
          '--disable-gpu',
          '--no-sandbox',
          '--hide-scrollbars',
          '--window-size=1460,960',
          `--user-data-dir=${path.join(TMP, 'cs-training-flow-shot')}`,
          `--virtual-time-budget=${budget}`,
          `--screenshot=${shotFile}`,
          url,
        ],
        { encoding: 'utf8', timeout: 120000, windowsHide: true }
      );
    }
    const res = spawnSync(
      browser,
      [
        '--headless=old',
        '--disable-gpu',
        '--no-sandbox',
        '--hide-scrollbars',
        '--window-size=1460,960',
        `--user-data-dir=${path.join(TMP, 'cs-training-flow-check')}`,
        `--virtual-time-budget=${budget}`,
        '--dump-dom',
        url,
      ],
      { encoding: 'utf8', timeout: 120000, maxBuffer: 128 * 1024 * 1024, windowsHide: true }
    );
    const matched = /RESULT\|([\s\S]*?)\|END/.exec(res.stdout || '');
    if (!matched) return { ok: false, reason: '未取到结果（页面没跑完或探针没加载）', evidence: '' };
    try {
      const parsed = JSON.parse(matched[1]);
      return { ok: !!parsed.ok, reason: parsed.reason || '', evidence: parsed.evidence || '' };
    } catch {
      return { ok: false, reason: '结果解析失败', evidence: '' };
    }
  } finally {
    fs.rmSync(probe, { force: true });
  }
}

async function main() {
  if (LIST_ONLY) {
    FLOWS.forEach((flow) => console.log(`${(flow.role || '匿名').padEnd(7)} ${String(flow.to).padEnd(34)} ${flow.name}`));
    return;
  }
  if (!browser) {
    console.error('未找到 Edge / Chrome，无法跑交互自检。可用 RENDER_BROWSER 指定浏览器路径。');
    process.exit(1);
  }
  const appDir = path.join(root, 'frontend', 'dist');
  const boardDir = path.join(root, 'docs');
  if (!fs.existsSync(appDir)) {
    console.error('未找到 frontend/dist，请先执行：node node_modules/vite/bin/vite.js build（在 frontend 目录下）');
    process.exit(1);
  }

  const tokens = {
    agent: (await api('/auth/login', { method: 'POST', body: { username: 'agent', password: 'Agent@123' } })).token,
    leader: (await api('/auth/login', { method: 'POST', body: { username: 'leader', password: 'Leader@123' } })).token,
    admin: (await api('/auth/login', { method: 'POST', body: { username: 'admin', password: 'Admin@123' } })).token,
  };

  // 接待页用例需要一局「进行中」的训练
  let attemptId = null;
  try {
    const tasks = await api('/tasks', { token: tokens.agent });
    const current = await api('/receptions/current', { token: tokens.agent });
    if (current) await api(`/receptions/${current.attemptId}/finish`, { token: tokens.agent, method: 'POST', body: {} });
    const started = await api('/receptions', { token: tokens.agent, method: 'POST', body: { level: 'L2', source: 'task', taskId: tasks[0].id } });
    attemptId = started.attemptId;
    await sleep(4000);
  } catch (error) {
    console.error(`准备接待页用例失败：${error.message}（相关用例会跳过）`);
  }

  const results = [];
  try {
    for (const flow of FLOWS) {
      let ctx = null;
      try {
        // 少数用例要先改系统参数 / 开一局，跑完再还原
        if (flow.prepare) ctx = await flow.prepare(api, tokens);
        const target = flow.to || ctx?.route || `/reception?attemptId=${attemptId}`;
        if (!flow.to && !target) {
          results.push({ name: flow.name, ok: false, detail: '没有可用的进行中接待' });
          continue;
        }
        const probeDir = flow.base === 'board' ? boardDir : appDir;
        const outcome = runFlow({ ...flow, to: target }, tokens, probeDir);
        results.push({
          name: flow.name,
          ok: outcome.ok,
          detail: outcome.ok ? outcome.evidence : `${outcome.reason}${outcome.evidence ? ` ｜ ${outcome.evidence}` : ''}`,
        });
      } catch (error) {
        results.push({ name: flow.name, ok: false, detail: `准备/执行失败：${error.message}` });
      } finally {
        if (flow.cleanup) {
          try {
            await flow.cleanup(api, tokens, ctx);
          } catch (error) {
            console.error(`清理「${flow.name}」失败：${error.message}`);
          }
        }
      }
    }
  } finally {
    if (attemptId) {
      try {
        await api(`/receptions/${attemptId}/finish`, { token: tokens.agent, method: 'POST', body: {} });
      } catch {
        /* 已结束则忽略 */
      }
    }
  }

  const failed = results.filter((item) => !item.ok);
  writeBrowserCheck('flow', results.length, results.length - failed.length, failed.map((item) => item.name));
  results.forEach((item) => console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name.padEnd(26)} ${item.detail}`));
  console.log(`\n交互流程自检：${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('交互流程自检失败：', error.message);
  console.error('请确认接口服务（3000）、前端预览（4173）、验收看板（4180）都在跑。');
  process.exit(1);
});
