#!/usr/bin/env node
/**
 * 订单三态截图：把「待支付 / 待发货 / 已发货」三种订单卡片各截一张图，用于和客户给的参考图逐项对照。
 *
 * 为什么要单独一个脚本：订单卡片的字段与按钮随状态变（三张参考图三套布局），
 * 只跑 DOM 断言看不出排版问题，必须出图人工看。
 *
 * 用法：
 *   node tools/order-shots.mjs                # 输出到 docs/截图
 *   node tools/order-shots.mjs D:/tmp/订单截图  # 换目录
 *
 * 前置：接口服务（3000）与前端预览（4173）都在跑；本机装有 Edge 或 Chrome。会真实开局并结束接待。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = 'http://127.0.0.1:4173';
const API = 'http://127.0.0.1:3000';
const OUT = process.argv[2] || path.join(ROOT, 'docs', '截图');
const BROWSER = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const token = (await api('/auth/login', { method: 'POST', body: { username: 'leader', password: 'Leader@123' } })).token;

fs.mkdirSync(OUT, { recursive: true });
const probe = path.join(ROOT, 'frontend', 'dist', '__order-probe.html');
fs.writeFileSync(
  probe,
  `<!doctype html><html><body><script>
const q=new URLSearchParams(location.search);
if(q.get('t'))localStorage.setItem('cs-training-token',q.get('t'));
location.replace(q.get('to')||'/');
</script></body></html>`
);

const shoot = (url, file) => {
  fs.rmSync(file, { force: true });
  spawnSync(
    BROWSER,
    [
      '--headless=old',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      '--window-size=1600,1100',
      `--user-data-dir=${path.join(os.tmpdir(), 'cs-order-shots')}`,
      '--virtual-time-budget=9000',
      `--screenshot=${file}`,
      url,
    ],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024, windowsHide: true }
  );
  return fs.existsSync(file) ? fs.statSync(file).size : 0;
};

const wanted = { unpaid: '待支付', unshipped: '待发货', shipped: '已发货' };
const done = new Set();

/** 同一局里往前推进：回复一次买家就会推下一条问题，订单状态跟着问题变（售前→售后的顺序不保证，所以每轮都比一次）。 */
async function capture(attemptId, sessionId, label) {
  const snapshot = await api(`/receptions/${attemptId}/snapshot`, { token });
  const session = snapshot.sessions.find((s) => s.sessionId === sessionId) || snapshot.sessions[0];
  const stage = session?.order?.stage;
  console.log(`${label} 当前问题=${session?.questions?.find((q) => q.seq === session.seq)?.question} stage=${stage}`);
  if (stage && !done.has(stage)) {
    const file = path.join(OUT, `${stage}-${wanted[stage]}.png`);
    const size = shoot(
      `${APP}/__order-probe.html?t=${encodeURIComponent(token)}&to=${encodeURIComponent(`/reception?attemptId=${attemptId}&tab=order`)}`,
      file
    );
    console.log(`SHOT ${file} ${size} 字节`);
    done.add(stage);
  }
  return stage;
}

try {
  for (const level of ['L3', 'L1']) {
    if (done.size === 3) break;
    const current = await api('/receptions/current', { token });
    if (current) await api(`/receptions/${current.attemptId}/finish`, { token, method: 'POST', body: {} });
    const started = await api('/receptions', { token, method: 'POST', body: { level, source: 'free' } });
    await sleep(3500);
    const snapshot = await api(`/receptions/${started.attemptId}/snapshot`, { token });
    const sessionId = (snapshot.sessions.find((s) => s.state !== 'pending') || snapshot.sessions[0]).sessionId;
    const maxRounds = level === 'L1' ? 16 : 4;
    for (let round = 1; round <= maxRounds; round += 1) {
      if (done.size === 3) break;
      try {
        await capture(started.attemptId, sessionId, `${level}#${round}`);
      } catch (error) {
        console.log(`  · 取值失败（${error.message}），结束这一局`);
        break;
      }
      if (done.size === 3) break;
      if (round === maxRounds) break;
      /* 一个会话的问题问完就结束了，换下一个已进线的买家继续推进（顺便也让待接入的补位） */
      const snap2 = await api(`/receptions/${started.attemptId}/snapshot`, { token });
      const live = snap2.sessions.find((s) => !['finished', 'transferred', 'aborted', 'pending'].includes(s.state));
      if (!live) {
        console.log('  · 没有可回复的会话了，结束这一局');
        break;
      }
      try {
        await api(`/receptions/${started.attemptId}/sessions/${live.sessionId}/messages`, {
          method: 'POST',
          token,
          body: { content: '亲，您好，很高兴为您服务，我马上帮您核实一下～' },
        });
      } catch (error) {
        console.log(`  · 回复失败（${error.message}），继续下一轮`);
      }
      await sleep(6000);
    }
  }
  console.log('已覆盖状态：', [...done].join(', '));
} finally {
  const current = await api('/receptions/current', { token }).catch(() => null);
  if (current) await api(`/receptions/${current.attemptId}/finish`, { token, method: 'POST', body: {} }).catch(() => {});
  fs.rmSync(probe, { force: true });
}
