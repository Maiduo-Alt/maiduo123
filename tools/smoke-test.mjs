#!/usr/bin/env node
/**
 * 冒烟测试：对真实运行的 API 服务做端到端业务验证。
 * 用法：USE_PG_MEM=true node backend/dist/main.js 启动服务后，执行 node tools/smoke-test.mjs
 */

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3000';
const results = [];
let failed = 0;
let agentSocket = null;

/**
 * 建立客服的实时连接。
 * 真实客户端（浏览器工作台）连接后会保持长连接；服务端的「断线超 60 秒视为异常中止」规则
 * 依赖这个连接判定在线状态，因此冒烟测试也必须像真实客户端一样连接，否则会被误判为断线。
 */
async function connectAgentSocket(token) {
  if (process.env.SMOKE_SKIP_SOCKET === 'true') return;
  const { io } = await import('socket.io-client');
  agentSocket = io(BASE, { path: '/realtime', auth: { token }, transports: ['websocket'] });
  await new Promise((resolve) => {
    const guard = setTimeout(resolve, 5000);
    agentSocket.on('reception.connected', () => {
      clearTimeout(guard);
      resolve();
    });
    agentSocket.on('connect_error', () => {
      clearTimeout(guard);
      resolve();
    });
  });
}

async function call(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return res.json();
}

function check(name, condition, detail = '') {
  results.push({ name, pass: !!condition, detail });
  if (!condition) failed += 1;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  /**
   * 方案 5.10：健康检查接口 /api/health（免登录，供监控与容器 healthcheck 使用）。
   * 放在最前面：它不需要任何登录态，能最快确认「服务起来了」。
   */
  const health = await call('/api/health');
  check(
    '健康检查 /api/health（免登录）',
    health.code === 0 && health.data?.status === 'ok' && health.data?.db === 'up',
    `status=${health.data?.status} db=${health.data?.db} 延迟 ${health.data?.dbLatencyMs ?? '—'}ms`
  );

  const agentLogin = await call('/api/auth/login', { method: 'POST', body: { username: 'agent', password: 'Agent@123' } });
  check('客服登录', agentLogin.code === 0, agentLogin.message);
  const agentToken = agentLogin.data && agentLogin.data.token;
  await connectAgentSocket(agentToken);

  const adminLogin = await call('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'Admin@123' } });
  check('管理员登录', adminLogin.code === 0, adminLogin.message);
  const adminToken = adminLogin.data && adminLogin.data.token;

  const anon = await call('/api/products');
  check('未登录访问被拦截', anon.code === 1002, `code=${anon.code}`);

  const levels = await call('/api/receptions/levels', { token: agentToken });
  check('难度档位返回四档', levels.code === 0 && levels.data.length === 4);
  check('L1 默认开放且 1 名并发', levels.data[0].unlocked === true && levels.data[0].concurrent === 1);
  check('L2～L4 响应等待为标准口径', [1, 2, 3].every((i) => levels.data[i].waitTolerance === 1));
  check('单会话轮数四档统一为 6～10', levels.data.every((l) => l.rounds[0] === 6 && l.rounds[1] === 10));

  const products = await call('/api/products?pageSize=5', { token: adminToken });
  check('商品库有数据', products.code === 0 && products.data.list.length > 0, `共 ${products.data ? products.data.total : 0} 个商品`);
  const backgrounds = await call('/api/backgrounds?pageSize=5', { token: adminToken });
  check('买家咨询背景有数据', backgrounds.code === 0 && backgrounds.data.list.length > 0);
  const contents = await call('/api/contents?pageSize=5', { token: adminToken });
  check('买家咨询内容有数据', contents.code === 0 && contents.data.list.length > 0);
  const scripts = await call('/api/scripts?pageSize=5', { token: adminToken });
  check('剧本有数据', scripts.code === 0 && scripts.data && scripts.data.total > 0, `共 ${scripts.data ? scripts.data.total : 0} 个剧本`);
  check(
    '剧本轮数不少于 6 轮',
    scripts.code === 0 && scripts.data.list[0].rounds >= 6,
    scripts.code === 0 ? `${scripts.data.list[0].rounds} 轮` : `code=${scripts.code} ${scripts.message}`
  );

  const bgIds = backgrounds.data.list.slice(0, 3).map((b) => b.id);
  const qaIds = contents.data.list.slice(0, 4).map((c) => c.id);
  const productIds = products.data.list.slice(0, 2).map((p) => p.id);
  const batch = await call('/api/scripts/batch-generate', {
    method: 'POST',
    token: adminToken,
    body: { bgIds, qaIds, productIds, seed: 20261001 },
  });
  check('批量生成剧本 3×4=12', batch.code === 0 && batch.data.total === 12, JSON.stringify(batch.data.distribution || {}));

  const badRatios = await call('/api/styles/ratios', {
    method: 'PUT',
    token: adminToken,
    body: { items: [{ code: 'friendly', ratio: 60 }, { code: 'impatient', ratio: 60 }] },
  });
  check('沟通风格占比超过 100% 被拦截', badRatios.code === 3002, `code=${badRatios.code}`);

  // 自愈：上一次运行若留下未结束的接待，先收掉，避免被 2001 拦住（幂等，可重复跑）
  // 自由练习只对管理员/主管开放（客户新增需求），所以这一整段用管理员账号跑
  const leftover = (await call('/api/receptions/current', { token: adminToken })).data;
  if (leftover) {
    await call(`/api/receptions/${leftover.attemptId}/finish`, { method: 'POST', token: adminToken, body: {} });
    console.log(`（已自动结束上一次遗留的接待 ${leftover.attemptNo}）`);
  }

  // 客户新增需求：客服调自由练习必须被拦（1003），不能只是界面上藏起来
  const agentFree = await call('/api/receptions', { method: 'POST', token: agentToken, body: { level: 'L1', source: 'free' } });
  check('客服不能自由练习（返回 1003）', agentFree.code === 1003, `code=${agentFree.code}`);

  const start = await call('/api/receptions', { method: 'POST', token: adminToken, body: { level: 'L1', source: 'free' } });
  /**
   * 客户 2026-10-03 C7：L1 的「合计接待人数」默认 10，其中只有「同时在线」那一部分会立刻进线，
   * 其余以 pending（待接入）排队。所以这里断言的是「已进线人数 = L1 接入人数（1）」，
   * 而不是会话总数——总数跟着合计人数走。
   */
  const liveSessions = (start.data?.sessions || []).filter((session) => session.state !== 'pending');
  check(
    '开始接待成功',
    start.code === 0 && liveSessions.length === 1,
    `共 ${start.data?.sessions?.length ?? 0} 个会话，已进线 ${liveSessions.length} 人`
  );
  const attemptId = start.data.attemptId;

  const duplicate = await call('/api/receptions', { method: 'POST', token: adminToken, body: { level: 'L2' } });
  check('重复开始接待被拦截', duplicate.code === 2001, `code=${duplicate.code}`);

  await sleep(1200);
  const snapshot = await call(`/api/receptions/${attemptId}/snapshot`, { token: adminToken });
  const session = snapshot.data.sessions[0];
  check('买家自动进线并推送问题', snapshot.data.messages.some((m) => m.sender === 'buyer'));
  check('L1 超时口径 270 秒（180×1.5）', session.timeoutLimitSec === 270, `实际 ${session.timeoutLimitSec}`);

  const question = session.questions.find((q) => q.seq === session.seq) || session.questions[0];
  const reply = `亲，您好，${question.keyPoints.join('，')}，还有其他可以帮您的吗？`;
  const send = await call(`/api/receptions/${attemptId}/sessions/${session.sessionId}/messages`, {
    method: 'POST',
    token: adminToken,
    body: { content: reply },
  });
  check('客服回复成功且命中要点', send.code === 0 && send.data.ruleResult.hitPoints.length > 0, `命中 ${send.data.ruleResult.hitPoints.join('、')}`);
  check('响应耗时由服务端记录', typeof send.data.responseSec === 'number', `${send.data.responseSec} 秒`);

  const useless = await call(`/api/receptions/${attemptId}/sessions/${session.sessionId}/messages`, {
    method: 'POST',
    token: adminToken,
    body: { content: '。。。' },
  });
  check('无意义内容被拒绝', useless.code === 1001, `code=${useless.code}`);

  const finish = await call(`/api/receptions/${attemptId}/finish`, { method: 'POST', token: adminToken, body: {} });
  check('结束接待并生成评分', finish.code === 0 && typeof finish.data.totalScore === 'number', `总分 ${finish.data.totalScore}`);
  check('结论为达标/未达标之一', ['pass', 'fail'].includes(finish.data.conclusion));

  const records = await call('/api/records', { token: adminToken });
  check('明细落库', records.code === 0 && records.data.total > 0, `共 ${records.data.total} 条`);

  const detail = await call(`/api/records/${attemptId}`, { token: adminToken });
  check('明细详情可回放', detail.code === 0 && detail.data.messages.length > 1);
  check(
    '评分报告含四维得分与失分明细',
    detail.data.sessions[0].responseScore !== undefined && Array.isArray(detail.data.sessions[0].deductions)
  );

  const annotation = await call(`/api/records/${attemptId}/annotations`, {
    method: 'POST',
    // 批注属带教能力（方案 2.2：客服仅可查看与回复批注），用管理员身份写入
    token: adminToken,
    body: { sessionId: session.sessionId, content: '首响较快，结束语可以更自然' },
  });
  check('复盘批注可添加', annotation.code === 0);

  const agentAnnotation = await call(`/api/records/${attemptId}/annotations`, {
    method: 'POST',
    token: agentToken,
    body: { sessionId: session.sessionId, content: '客服不应能新建批注' },
  });
  check('客服不能新建批注（权限矩阵）', agentAnnotation.code === 1003, `code=${agentAnnotation.code}`);

  const denied = await call('/api/products', {
    method: 'POST',
    token: agentToken,
    body: { productNo: 'SMOKE-FORBIDDEN', title: '无权限商品', price: 1 },
  });
  check('客服不能创建商品（权限隔离）', denied.code === 1003, `code=${denied.code}`);

  const caseImport = await call('/api/cases/import/text', {
    method: 'POST',
    token: adminToken,
    body: {
      title: '冒烟测试案例',
      text: '买家:快递三天没有更新了！\n客服:亲，非常抱歉，我马上帮您核实～\n买家:什么时候答复？',
      stage: 'aftersale',
    },
  });
  check('案例文本导入成功', caseImport.code === 0 && caseImport.data.imported === 3, `导入 ${caseImport.data.imported} 条`);

  const toContent = await call(`/api/cases/${caseImport.data.id}/to-content`, { method: 'POST', token: adminToken });
  check('案例可转为买家咨询内容', toContent.code === 0 && toContent.data.questionList.length === 2);

  const lines = results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
  console.log(lines.join('\n'));
  console.log(`\n共 ${results.length} 项检查，通过 ${results.length - failed} 项，失败 ${failed} 项`);
  agentSocket?.close();
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('冒烟测试异常:', err.message);
  process.exit(1);
});
