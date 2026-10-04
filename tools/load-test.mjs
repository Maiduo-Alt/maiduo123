#!/usr/bin/env node
/**
 * 性能验收压测（方案 9.3）：50 人同时在线、其中 10 人各跑 4 路并发接待，
 * 统计接口响应耗时与消息推送延迟的 P50/P95。
 *
 * 用法（先启动服务）：
 *   npm run dev:api:mem
 *   node tools/load-test.mjs                # 默认 http://127.0.0.1:3000
 *   SMOKE_BASE=http://127.0.0.1:3000 LOAD_ONLINE=50 LOAD_CONCURRENT=10 node tools/load-test.mjs
 *
 * 说明：默认在内存库模式下测量，数字反映应用层与实时通道的开销；
 *      生产验收请在真实部署环境（PostgreSQL + Redis）重跑同一脚本。
 */
import { io } from 'socket.io-client';

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3000';
const ONLINE = Number(process.env.LOAD_ONLINE || 50);
const CONCURRENT = Number(process.env.LOAD_CONCURRENT || 10);
const RUN_MS = Number(process.env.LOAD_RUN_MS || 30000);
const ADMIN = { username: process.env.LOAD_ADMIN || 'admin', password: process.env.LOAD_ADMIN_PASSWORD || 'Admin@123' };
const AGENT_PASSWORD = 'Load@123';
const LEVEL = 'L4';

const httpDurations = [];
const pushLatencies = [];
const errors = [];

async function call(path, { method = 'GET', token, body } = {}) {
  const started = process.hrtime.bigint();
  try {
    const res = await fetch(`${BASE}/api${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json();
    if (json.code !== 0) throw new Error(`${path} -> ${json.code} ${json.message}`);
    return json.data;
  } finally {
    httpDurations.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
}

const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const round = (n) => Math.round(n * 10) / 10;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ensureAccounts(adminToken, count) {
  const usernames = [];
  for (let i = 1; i <= count; i += 1) {
    const username = `load${String(i).padStart(3, '0')}`;
    usernames.push(username);
    try {
      await call('/accounts', {
        method: 'POST',
        token: adminToken,
        // 客户新增需求后客服不能自由练习，压测账号用主管角色（压测只关心并发与延迟，不关心角色语义）
        body: { username, password: AGENT_PASSWORD, displayName: `压测账号 ${i}`, roleCode: 'leader' },
      });
    } catch (err) {
      if (!String(err.message).includes('已存在')) throw err;
    }
  }
  return usernames;
}

async function main() {
  const admin = await call('/auth/login', { method: 'POST', body: ADMIN });
  const usernames = await ensureAccounts(admin.token, ONLINE);

  const tokens = [];
  for (const username of usernames) {
    const data = await call('/auth/login', { method: 'POST', body: { username, password: AGENT_PASSWORD } });
    tokens.push(data.token);
  }

  const sockets = [];
  const pushByAttempt = new Map();
  let connected = 0;
  await Promise.all(
    tokens.map(
      (token) =>
        new Promise((resolve) => {
          const socket = io(BASE, { path: '/realtime', auth: { token }, transports: ['websocket'] });
          socket.on('reception.connected', () => {
            connected += 1;
            resolve();
          });
          socket.on('buyer.message', (payload) => {
            if (payload?.sentAt) {
              pushLatencies.push(Date.now() - Date.parse(payload.sentAt));
              if (payload.attemptId) pushByAttempt.set(payload.attemptId, (pushByAttempt.get(payload.attemptId) || 0) + 1);
            }
          });
          sockets.push(socket);
        })
    )
  );
  console.log(`已建立 ${connected} 个实时连接`);

  // 其中 CONCURRENT 人各开一局 4 路并发接待
  const attempts = [];
  try {
    await Promise.all(
      tokens.slice(0, CONCURRENT).map(async (token) => {
        // 自愈：清掉上一次压测遗留的进行中接待，保证压测可重复运行
        const leftover = await call('/receptions/current', { token });
        if (leftover) {
          await call(`/receptions/${leftover.attemptId}/finish`, { method: 'POST', token });
        }
        const data = await call('/receptions', { method: 'POST', token, body: { level: LEVEL, source: 'free' } });
        /**
         * 客户 2026-10-03 C7：一局的「合计接待人数」默认 10，其中只有「同时在线」（L4 = 4）那部分立刻进线，
         * 其余以 pending（待接入）排队。压测只回复**已进线**的会话——对排队的会话发消息会被接口拒绝，
         * 那不是性能问题，会把「业务错误数」打成一片红。
         */
        const live = data.sessions.filter((s) => s.state !== 'pending').map((s) => s.sessionId);
        attempts.push({ token, attemptId: data.attemptId, sessions: live, sessionTotal: data.sessions.length });
      })
    );
  } catch (err) {
    // 半途失败也要把已经开出去的接待收掉，否则下次运行会被 2001 拦住
    await finishAttempts(attempts);
    throw err;
  }
  const sessionTotal = attempts.reduce((sum, a) => sum + a.sessions.length, 0);
  const createdTotal = attempts.reduce((sum, a) => sum + a.sessionTotal, 0);
  console.log(
    `已开始 ${attempts.length} 局 ${LEVEL} 接待，已进线 ${sessionTotal} 路会话（每局合计 ${createdTotal / (attempts.length || 1)} 人，其余排队待接入）`
  );

  // 心跳往返：用 client.ack 的 ack 回调测实时通道往返时延
  const rtts = [];
  for (let round = 0; round < 5; round += 1) {
    await Promise.all(
      sockets.slice(0, ONLINE).map(
        (socket) =>
          new Promise((resolve) => {
            const startedAt = process.hrtime.bigint();
            const timer = setTimeout(resolve, 2000);
            socket.emit('client.ack', { sessionId: undefined }, () => {
              clearTimeout(timer);
              rtts.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
              resolve();
            });
          })
      )
    );
    await sleep(200);
  }

  // 接待进行中：持续回复，制造真实负载
  const deadline = Date.now() + RUN_MS;
  const reply = '亲，这款目前有现货，我帮您确认一下，运费险也是支持的～';
  while (Date.now() < deadline) {
    await Promise.all(
      attempts.map(async (attempt) => {
        for (const sessionId of attempt.sessions) {
          try {
            await call(`/receptions/${attempt.attemptId}/sessions/${sessionId}/messages`, {
              method: 'POST',
              token: attempt.token,
              body: { content: reply },
            });
          } catch (err) {
            errors.push(err.message);
          }
        }
      })
    );
    await sleep(2000);
  }

  for (const socket of sockets) socket.close();
  // 收尾：结束压测开出的接待，让压测环境可重复运行
  const finished = await finishAttempts(attempts);
  console.log(`已结束 ${finished} 局接待，压测环境已复位`);

  const report = {
    在线人数: connected,
    并发接待局数: attempts.length,
    会话数: sessionTotal,
    接口调用次数: httpDurations.length,
    接口耗时ms: { P50: round(percentile(httpDurations, 50)), P95: round(percentile(httpDurations, 95)), P99: round(percentile(httpDurations, 99)) },
    实时通道往返ms: { P50: round(percentile(rtts, 50)), P95: round(percentile(rtts, 95)), 样本: rtts.length },
    消息推送延迟ms: { P50: round(percentile(pushLatencies, 50)), P95: round(percentile(pushLatencies, 95)), 样本: pushLatencies.length },
    业务错误数: errors.length,
  };
  console.log('\n压测结果：');
  console.log(JSON.stringify(report, null, 2));

  const reasons = [
    report.接口耗时ms.P95 > 500 ? `接口 P95 ${report.接口耗时ms.P95}ms > 500ms` : '',
    report.实时通道往返ms.P95 > 500 ? `实时通道 P95 ${report.实时通道往返ms.P95}ms > 500ms` : '',
    report.业务错误数 > 0 ? `业务错误 ${report.业务错误数} 次（首条：${errors[0] || ''}）` : '',
  ].filter(Boolean);
  const pass = reasons.length === 0;
  console.log(`\n判定：接口 P95 与实时通道 P95 ${pass ? '均 ≤ 500ms，且无业务错误' : '未达标 —— ' + reasons.join('；')}`);
  process.exit(pass ? 0 : 1);
}

/** 结束压测开出的接待；已经结束或不允许结束的都忽略。 */
async function finishAttempts(attempts) {
  let done = 0;
  await Promise.all(
    attempts.map(async (attempt) => {
      try {
        await call(`/receptions/${attempt.attemptId}/finish`, { method: 'POST', token: attempt.token });
        done += 1;
      } catch {
        /* 已经结束 / 会话早已关闭，忽略即可 */
      }
    })
  );
  return done;
}

main().catch((err) => {
  console.error('压测执行失败：', err.message);
  process.exit(1);
});
