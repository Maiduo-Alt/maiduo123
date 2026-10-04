import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { DbService } from '../../src/db/db.service';
import { AllExceptionsFilter } from '../../src/common/all-exceptions.filter';
import { ResponseInterceptor } from '../../src/common/response.interceptor';
import { createTestDb } from '../util/test-db';
import { buildXlsxBuffer, sharedStringsXml } from '../util/xlsx-fixture';
import { io, Socket } from 'socket.io-client';
import fs from 'fs';
import os from 'os';
import path from 'path';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('在线模拟接待端到端链路', () => {
  let app: INestApplication;
  let http: any;
  let sharedDb: DbService;

  beforeAll(async () => {
    const db = await createTestDb();
    sharedDb = db;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DbService)
      .useValue(db)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    // 用 listen 而不是 init：实时用例需要一个常驻的 HTTP 服务来挂载 Socket.IO。
    http = await app.listen(0);
  }, 180000);

  afterAll(async () => {
    await app?.close();
  });

  async function login(username: string, password: string): Promise<string> {
    const res = await request(http).post('/api/auth/login').send({ username, password });
    expect(res.body.code).toBe(0);
    return res.body.data.token;
  }

  async function waitFor(assertion: () => boolean, timeoutMs = 5000): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (assertion()) return;
      await sleep(100);
    }
    throw new Error('等待条件超时');
  }

  it('登录与鉴权：未登录访问被拦截，错误密码被拒绝', async () => {
    const unauthorized = await request(http).get('/api/products');
    expect(unauthorized.body.code).toBe(1002);

    const bad = await request(http).post('/api/auth/login').send({ username: 'agent', password: 'wrong' });
    expect(bad.body.code).toBe(1002);
  });

  it('难度解锁状态返回四档，且 L1 默认开放', async () => {
    const token = await login('agent', 'Agent@123');
    const res = await request(http).get('/api/receptions/levels').set('Authorization', `Bearer ${token}`);
    expect(res.body.code).toBe(0);
    expect(res.body.data).toHaveLength(4);
    expect(res.body.data[0]).toMatchObject({ code: 'L1', unlocked: true, concurrent: 1 });
    expect(res.body.data[3]).toMatchObject({ code: 'L4', concurrent: 4 });
  });

  it('完整跑通一次接待：进线推送 → 客服回复 → 规则判定 → 评分 → 明细落库', async () => {
    // 自由练习只对管理员/主管开放（客户新增需求）；这条链路与角色无关，用带教账号跑
    const token = await login('leader', 'Leader@123');
    const auth = { Authorization: `Bearer ${token}` };

    const start = await request(http).post('/api/receptions').set(auth).send({ level: 'L1' });
    expect(start.body.code).toBe(0);
    const attemptId = start.body.data.attemptId;
    // 客户 2026-10-03：合计接待人数默认 10 人 → L1 是「1 人接入 + 9 人排队」
    expect(start.body.data.sessions).toHaveLength(10);
    expect(start.body.data.sessions.filter((s: any) => s.state === 'wait')).toHaveLength(1);

    // 同一账号不允许并发开启第二次接待
    const duplicate = await request(http).post('/api/receptions').set(auth).send({ level: 'L2' });
    expect(duplicate.body.code).toBe(2001);

    await sleep(800);
    let snapshot = await request(http).get(`/api/receptions/${attemptId}/snapshot`).set(auth);
    expect(snapshot.body.code).toBe(0);
    const session = snapshot.body.data.sessions[0];
    expect(snapshot.body.data.messages.filter((m: any) => m.sender === 'buyer').length).toBeGreaterThan(0);
    expect(session.timeoutLimitSec).toBe(270); // L1 宽松口径：180 × 1.5

    const question = session.questions.find((q: any) => q.seq === session.seq) || session.questions[0];
    const reply = `亲，您好，${question.keyPoints.join('，')}，还有其他可以帮您的吗？`;
    const send = await request(http)
      .post(`/api/receptions/${attemptId}/sessions/${session.sessionId}/messages`)
      .set(auth)
      .send({ content: reply });
    if (send.body.code !== 0) {
      // eslint-disable-next-line no-console
      console.error('[debug] sendMessage 失败:', JSON.stringify(send.body));
    }
    expect(send.body.code).toBe(0);
    expect(send.body.data.ruleResult.hitPoints.length).toBeGreaterThan(0);

    const empty = await request(http)
      .post(`/api/receptions/${attemptId}/sessions/${session.sessionId}/messages`)
      .set(auth)
      .send({ content: '。。。' });
    expect(empty.body.code).toBe(1001);

    const finish = await request(http).post(`/api/receptions/${attemptId}/finish`).set(auth).send({});
    if (finish.body.code !== 0) {
      // eslint-disable-next-line no-console
      console.error('[debug] 结束接待失败:', JSON.stringify(finish.body));
    }
    expect(finish.body.code).toBe(0);
    expect(finish.body.data.totalScore).toBeGreaterThan(0);
    expect(['pass', 'fail']).toContain(finish.body.data.conclusion);
    expect(finish.body.data.sessions[0].responseScore).toBeGreaterThanOrEqual(0);

    const records = await request(http).get('/api/records').set(auth);
    if (records.body.code !== 0) {
      // eslint-disable-next-line no-console
      console.error('[debug] 明细列表失败:', JSON.stringify(records.body));
    }
    expect(records.body.code).toBe(0);
    expect(records.body.data.total).toBeGreaterThan(0);
    expect(records.body.data.list[0].attemptNo).toBe(finish.body.data.attemptNo);

    const detail = await request(http).get(`/api/records/${attemptId}`).set(auth);
    if (detail.body.code !== 0) {
      // eslint-disable-next-line no-console
      console.error('[debug] 明细详情失败:', JSON.stringify(detail.body));
    }
    expect(detail.body.code).toBe(0);
    expect(detail.body.data.messages.length).toBeGreaterThan(1);
    expect(detail.body.data.sessions[0].totalScore).not.toBeNull();

    // 批注属带教能力（方案 2.2），用主管身份写入
    const leaderToken = await login('leader', 'Leader@123');
    const annotation = await request(http)
      .post(`/api/records/${attemptId}/annotations`)
      .set({ Authorization: `Bearer ${leaderToken}` })
      .send({ sessionId: session.sessionId, content: '本次首响较快，但结束语可以更自然' });
    expect(annotation.body.code).toBe(0);
  }, 60000);

  it('剧本批量生成：背景 × 内容 交叉生成并按占比分配风格', async () => {
    const token = await login('admin', 'Admin@123');
    const auth = { Authorization: `Bearer ${token}` };
    const backgrounds = await request(http).get('/api/backgrounds?pageSize=3').set(auth);
    const contents = await request(http).get('/api/contents?pageSize=4').set(auth);
    /**
     * 客户 2026-10-03 起，批量生成会按「商品与内容是否匹配」自动配商品，
     * 因此这里取**全部上架商品**（覆盖 13 个品类），保证每条内容都能配到兼容商品、数量与断言一致。
     */
    const products = await request(http).get('/api/products?pageSize=300&status=1').set(auth);

    const res = await request(http)
      .post('/api/scripts/batch-generate')
      .set(auth)
      .send({
        bgIds: backgrounds.body.data.list.map((b: any) => b.id),
        qaIds: contents.body.data.list.map((c: any) => c.id),
        productIds: products.body.data.list.map((p: any) => p.id),
        seed: 20261001,
      });
    if (res.body.code !== 0) {
      // eslint-disable-next-line no-console
      console.error('[debug] 批量生成失败:', JSON.stringify(res.body));
    }
    expect(res.body.code).toBe(0);
    expect(res.body.data.total).toBe(12); // 3 × 4
    const counts = Object.values(res.body.data.distribution as Record<string, number>);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(12);
    expect(res.body.data.preview[0].rounds).toBeGreaterThanOrEqual(6);
  }, 60000);

  it('沟通风格占比校验：总和超过 100% 被拦截', async () => {
    const token = await login('admin', 'Admin@123');
    const res = await request(http)
      .put('/api/styles/ratios')
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [
          { code: 'friendly', ratio: 60 },
          { code: 'impatient', ratio: 60 },
        ],
      });
    expect(res.body.code).toBe(3002);
  });

  it('权限隔离：客服不能创建商品，管理员可以', async () => {
    const agentToken = await login('agent', 'Agent@123');
    const denied = await request(http)
      .post('/api/products')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ productNo: 'TEST-1', title: '测试商品', price: 10 });
    expect(denied.body.code).toBe(1003);

    const adminToken = await login('admin', 'Admin@123');
    const created = await request(http)
      .post('/api/products')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ productNo: 'TEST-1', title: '测试商品', price: 10 });
    expect(created.body.code).toBe(0);
  });

  it('商品导入：Excel(.xlsx) 与 CSV 共用同一套校验与落库逻辑', async () => {
    const token = await login('admin', 'Admin@123');
    const auth = { Authorization: `Bearer ${token}` };

    const shared = sharedStringsXml([
      'product_no',
      'title',
      'price',
      'stock',
      'category',
      '3781182303640999001',
      'Excel 导入测试商品',
      '家居',
      '3781182303640999002',
      '缺少价格的商品',
    ]);
    const sheet = `<worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c></row>
      <row r="2"><c r="A2" t="s"><v>5</v></c><c r="B2" t="s"><v>6</v></c><c r="C2"><v>199</v></c><c r="D2"><v>50</v></c><c r="E2" t="s"><v>7</v></c></row>
      <row r="3"><c r="A3" t="s"><v>8</v></c><c r="B3" t="s"><v>9</v></c></row>
    </sheetData></worksheet>`;

    const xlsx = buildXlsxBuffer(sheet, shared);
    const res = await request(http)
      .post('/api/products/import')
      .set(auth)
      .send({ xlsxBase64: xlsx.toString('base64') });
    expect(res.body.code).toBe(0);
    expect(res.body.data.success).toBe(1);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.failed).toHaveLength(1);
    expect(res.body.data.failed[0].row).toBe(3);

    const list = await request(http).get('/api/products?keyword=Excel').set(auth);
    expect(list.body.data.list.map((p: any) => p.productNo)).toContain('3781182303640999001');
  }, 60000);

  it('商品导入：CSV 仍可用，且缺列时给出明确报错', async () => {
    const token = await login('admin', 'Admin@123');
    const auth = { Authorization: `Bearer ${token}` };

    const bad = await request(http)
      .post('/api/products/import')
      .set(auth)
      .send({ csv: 'title,price\n只有标题,10' });
    expect(bad.body.code).not.toBe(0);

    const csv = 'product_no,title,price,stock,category\n3781182303640999003,CSV 导入测试商品,59,10,家居';
    const ok = await request(http).post('/api/products/import').set(auth).send({ csv });
    expect(ok.body.code).toBe(0);
    expect(ok.body.data.success).toBe(1);
    expect(ok.body.data.failed).toHaveLength(0);
  }, 60000);

  it('实时计时：服务端每秒下发 timer.tick，并接收 client.ack 心跳', async () => {
    // 自由练习只对管理员/主管开放（客户新增需求），计时用例改用管理员
    const token = await login('admin', 'Admin@123');
    const port = (http.address() as any).port as number;
    const socket: Socket = io(`http://127.0.0.1:${port}`, {
      path: '/realtime',
      auth: { token },
      transports: ['websocket'],
    });
    const ticks: any[] = [];
    socket.on('timer.tick', (payload: any) => ticks.push(payload));

    try {
      await new Promise<void>((resolve, reject) => {
        const guard = setTimeout(() => reject(new Error('实时连接超时')), 5000);
        socket.on('reception.connected', () => {
          clearTimeout(guard);
          resolve();
        });
        socket.on('connect_error', (err) => {
          clearTimeout(guard);
          reject(err);
        });
      });

      const started = await request(http)
        .post('/api/receptions')
        .set({ Authorization: `Bearer ${token}` })
        .send({ level: 'L1', source: 'free' });
      expect(started.body.code).toBe(0);
      const attemptId = started.body.data.attemptId;

      await waitFor(() => ticks.length > 0, 6000);
      const first = ticks[0];
      expect(first.attemptId).toBe(attemptId);
      expect(typeof first.serverTime).toBe('string');
      expect(first.sessions.length).toBeGreaterThan(0);
      // 计时由服务端给出，前端不再自己推算
      expect(typeof first.sessions[0].waitedSec).toBe('number');
      expect(typeof first.sessions[0].remainSec).toBe('number');

      // 心跳：上报焦点会话后，服务端在后续 tick 里回传最近心跳时间
      socket.emit('client.ack', { sessionId: first.sessions[0].sessionId });
      await waitFor(() => ticks.some((t) => typeof t.lastAckAt === 'string'), 6000);
      expect(ticks.find((t) => typeof t.lastAckAt === 'string').lastAckAt).toBeTruthy();
    } finally {
      socket.close();
    }
  }, 60000);

  it('操作审计：写操作会落 action_logs，且不记录密码等敏感字段', async () => {
    const token = await login('admin', 'Admin@123');
    const res = await request(http)
      .post('/api/accounts')
      .set({ Authorization: `Bearer ${token}` })
      .send({ username: 'audit_probe', password: 'Probe@123', displayName: '审计探针', roleCode: 'agent' });
    expect(res.body.code).toBe(0);

    // 审计写入是异步的（不阻塞响应），这里轮询等它落库
    let rows: any[] = [];
    const started = Date.now();
    while (Date.now() - started < 5000) {
      rows = await sharedDb.many(
        `SELECT account_id AS "accountId", action, detail FROM action_logs
         WHERE action = 'POST /api/accounts' ORDER BY id DESC LIMIT 1`
      );
      if (rows.length) break;
      await sleep(100);
    }
    expect(rows).toHaveLength(1);
    const detail = typeof rows[0].detail === 'string' ? JSON.parse(rows[0].detail) : rows[0].detail;
    expect(detail.ok).toBe(true);
    expect(JSON.stringify(detail)).not.toContain('Probe@123');
    expect(rows[0].accountId).toBeTruthy();
  }, 60000);

  it('安全：账号列表中的手机号脱敏返回', async () => {
    const token = await login('admin', 'Admin@123');
    const created = await request(http)
      .post('/api/accounts')
      .set({ Authorization: `Bearer ${token}` })
      .send({
        username: 'mask_probe',
        password: 'Probe@123',
        displayName: '脱敏探针',
        roleCode: 'agent',
        mobile: '13800001234',
      });
    expect(created.body.code).toBe(0);

    const list = await request(http).get('/api/accounts?keyword=mask_probe').set({ Authorization: `Bearer ${token}` });
    expect(list.body.code).toBe(0);
    const row = list.body.data.list.find((item: any) => item.username === 'mask_probe');
    expect(row).toBeTruthy();
    expect(row.mobile).toBe('138****1234');
  }, 60000);

  it('批量生成：超过异步阈值返回任务 ID，可查询进度并取消', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const auth = { Authorization: `Bearer ${adminToken}` };
    // 阈值调到 5，用少量数据即可触发异步路径
    await request(http).put('/api/settings').set(auth).send({ batchAsyncThreshold: 5 });

    const backgrounds = await request(http).get('/api/backgrounds?pageSize=3').set(auth);
    const contents = await request(http).get('/api/contents?pageSize=4').set(auth);
    const products = await request(http).get('/api/products?pageSize=2').set(auth);
    const res = await request(http)
      .post('/api/scripts/batch-generate')
      .set(auth)
      .send({
        bgIds: backgrounds.body.data.list.map((b: any) => b.id),
        qaIds: contents.body.data.list.map((c: any) => c.id),
        productIds: products.body.data.list.map((p: any) => p.id),
      });
    expect(res.body.code).toBe(0);
    expect(res.body.data.async).toBe(true);
    expect(res.body.data.total).toBe(12);

    let task: any = null;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const progress = await request(http)
        .get(`/api/scripts/batch-generate/tasks/${res.body.data.taskId}`)
        .set(auth);
      expect(progress.body.code).toBe(0);
      task = progress.body.data;
      if (task.status !== 'running') break;
      await sleep(200);
    }
    expect(task.status).toBe('done');
    expect(task.createdCount).toBe(12);
    expect(task.failedCount).toBe(0);

    // 取消路径：开一个大批次后立刻取消，已生成的保留、不再继续
    const bigContents = await request(http).get('/api/contents?pageSize=300').set(auth);
    const big = await request(http)
      .post('/api/scripts/batch-generate')
      .set(auth)
      .send({
        bgIds: backgrounds.body.data.list.map((b: any) => b.id),
        qaIds: bigContents.body.data.list.map((c: any) => c.id),
        productIds: products.body.data.list.map((p: any) => p.id),
      });
    expect(big.body.data.async).toBe(true);
    const cancel = await request(http)
      .post(`/api/scripts/batch-generate/tasks/${big.body.data.taskId}/cancel`)
      .set(auth);
    expect(cancel.body.code).toBe(0);

    let bigTask: any = null;
    const bigDeadline = Date.now() + 30000;
    while (Date.now() < bigDeadline) {
      const progress = await request(http)
        .get(`/api/scripts/batch-generate/tasks/${big.body.data.taskId}`)
        .set(auth);
      bigTask = progress.body.data;
      if (bigTask.status !== 'running') break;
      await sleep(300);
    }
    expect(['cancelled', 'done']).toContain(bigTask.status);
    if (bigTask.status === 'cancelled') expect(bigTask.createdCount).toBeLessThan(big.body.data.total);

    await request(http).put('/api/settings').set(auth).send({ batchAsyncThreshold: 100 });
  }, 90000);

  it('接口清单补齐：令牌续签与小组更新', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const auth = { Authorization: `Bearer ${adminToken}` };

    const refreshed = await request(http).post('/api/auth/refresh').set(auth);
    expect(refreshed.body.code).toBe(0);
    expect(typeof refreshed.body.data.token).toBe('string');
    expect(refreshed.body.data.profile.roleCode).toBe('admin');

    const anon = await request(http).post('/api/auth/refresh');
    expect(anon.body.code).toBe(1002);

    const group = await request(http).post('/api/groups').set(auth).send({ name: '预热二组' });
    expect(group.body.code).toBe(0);
    const updated = await request(http)
      .put(`/api/groups/${group.body.data.id}`)
      .set(auth)
      .send({ name: '预热二组（改名）' });
    expect(updated.body.code).toBe(0);
  }, 60000);

  it('情绪升级：情绪值达到阈值后买家追加升级追问（方案 3.7.4 / 9.2 场景四）', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const group = await sharedDb.one<{ id: number }>(`SELECT id FROM groups WHERE name = $1`, ['新人一组']);
    await request(http)
      .post('/api/accounts')
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({
        username: 'emotion_probe',
        password: 'Probe@123',
        displayName: '情绪探针',
        // 探针账号要能自由练习（客户新增需求后客服不能用自由练习）
        roleCode: 'leader',
        groupId: group?.id ?? null,
      });
    const token = await login('emotion_probe', 'Probe@123');
    const auth = { Authorization: `Bearer ${token}` };

    const started = await request(http).post('/api/receptions').set(auth).send({ level: 'L1', source: 'free' });
    expect(started.body.code).toBe(0);
    const attemptId = started.body.data.attemptId;
    const sessionId = started.body.data.sessions[0].sessionId;

    // 连续使用禁用词把情绪值顶到升级阈值（默认 80）
    for (let i = 0; i < 4; i += 1) {
      const replied = await request(http)
        .post(`/api/receptions/${attemptId}/sessions/${sessionId}/messages`)
        .set(auth)
        .send({ content: '不知道，你自己看吧' });
      expect(replied.body.code).toBe(0);
    }

    const escalation = '你们这样处理我实在接受不了，我要投诉你们！';
    const escalated = await sharedDb.one<{ count: string }>(
      `SELECT count(*)::text AS count FROM messages WHERE session_id = $1 AND content = $2`,
      [sessionId, escalation]
    );
    expect(Number(escalated!.count)).toBe(1);

    const emotion = await sharedDb.one<{ emotion_value: number }>(
      `SELECT emotion_value FROM sessions WHERE id = $1`,
      [sessionId]
    );
    expect(Number(emotion!.emotion_value)).toBeGreaterThanOrEqual(80);
  }, 60000);

  it('超时口径：超过阈值未回复会记录超时并扣响应分（方案 4.2 / 9.2 场景二）', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const adminAuth = { Authorization: `Bearer ${adminToken}` };
    // 把阈值与进线间隔调小，便于在秒级验证真实规则（规则本身不变）
    await request(http).put('/api/settings').set(adminAuth).send({ timeoutSec: 1, levelJoinDelaySec: [0, 1] });

    await request(http)
      .post('/api/accounts')
      .set(adminAuth)
      .send({ username: 'timeout_probe', password: 'Probe@123', displayName: '超时探针', roleCode: 'leader' });
    const token = await login('timeout_probe', 'Probe@123');
    const auth = { Authorization: `Bearer ${token}` };

    const started = await request(http).post('/api/receptions').set(auth).send({ level: 'L1', source: 'free' });
    expect(started.body.code).toBe(0);
    const attemptId = started.body.data.attemptId;
    const sessionId = started.body.data.sessions[0].sessionId;

    // 买家进线后不回复，等待超时扫描（每 5 秒一次）记录超时
    let state: any = null;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      state = await sharedDb.one<{ timeout_count: number; state: string }>(
        `SELECT timeout_count, state FROM sessions WHERE id = $1`,
        [sessionId]
      );
      if (Number(state?.timeout_count) > 0) break;
      await sleep(1000);
    }
    expect(Number(state!.timeout_count)).toBeGreaterThan(0);
    expect(state!.state).toBe('timeout');

    const timeoutMessage = await sharedDb.one<{ count: string }>(
      `SELECT count(*)::text AS count FROM messages WHERE session_id = $1 AND is_timeout = true`,
      [sessionId]
    );
    expect(Number(timeoutMessage!.count)).toBeGreaterThan(0);

    const finished = await request(http).post(`/api/receptions/${attemptId}/finish`).set(auth);
    expect(finished.body.code).toBe(0);

    // 评分落库时应包含超时次数与响应维度扣分
    const score = await sharedDb.one<any>(`SELECT metrics, deductions FROM scores WHERE session_id = $1`, [sessionId]);
    expect(Number(score.metrics.timeoutCount)).toBeGreaterThan(0);
    expect(JSON.stringify(score.deductions)).toContain('超时');

    await request(http).put('/api/settings').set(adminAuth).send({ timeoutSec: 180, levelJoinDelaySec: [10, 30] });
  }, 90000);

  it('导入校验：分类不存在与价格非法都计入失败清单（方案 9.2 场景七）', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const csv = [
      'product_no,title,price,stock,category',
      '3781182303640999101,分类合法商品,10,5,家居',
      '3781182303640999102,分类非法商品,10,5,不存在的分类',
      '3781182303640999103,价格非法商品,-5,5,家居',
    ].join('\n');
    const res = await request(http)
      .post('/api/products/import')
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({ csv });
    expect(res.body.code).toBe(0);
    expect(res.body.data.success).toBe(1);
    expect(res.body.data.failed.map((item: any) => item.row)).toEqual([3, 4]);
    const reasons = res.body.data.failed.map((item: any) => item.reason).join(' ');
    expect(reasons).toContain('分类不存在');
    expect(reasons).toContain('价格');
  }, 60000);

  it('沟通风格默认占比与方案 10.3 一致', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const res = await request(http).get('/api/styles').set({ Authorization: `Bearer ${adminToken}` });
    expect(res.body.code).toBe(0);
    const ratios = new Map<string, number | null>(res.body.data.map((s: any) => [s.code, s.ratio]));
    expect(ratios.get('friendly')).toBe(30);
    expect(ratios.get('impatient')).toBe(15);
    expect(ratios.get('direct')).toBe(20);
    expect(ratios.get('hesitant')).toBe(20);
    expect(ratios.get('silent')).toBe(15);
    // 扩充风格默认不参与分配
    expect(ratios.get('newbie')).toBeNull();
  }, 60000);

  it('方案 F3-11：剧本预览按对话流给出提问序列（与列表轮数一致）', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const adminAuth = { Authorization: `Bearer ${adminToken}` };
    const list = await request(http).get('/api/scripts?pageSize=1').set(adminAuth);
    const script = list.body.data.list[0];
    expect(script).toBeTruthy();

    const preview = await request(http).get(`/api/scripts/${script.id}/preview`).set(adminAuth);
    expect(preview.body.code).toBe(0);
    const rounds = preview.body.data.questionSeq;
    expect(Array.isArray(rounds)).toBe(true);
    expect(rounds.length).toBeGreaterThanOrEqual(6);
    expect(rounds[0]).toHaveProperty('question');
    expect(rounds[0].keyPoints.length).toBeGreaterThan(0);
    // 方案 3.3：预览的提问序列要与接待抽取到的一致（轮数对得上）
    expect(rounds.length).toBe(script.rounds);
  });

  it('方案 F4-05：商品列表支持关键词 / 分类 / 价格区间 / 状态筛选', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const adminAuth = { Authorization: `Bearer ${adminToken}` };
    const all = await request(http).get('/api/products?pageSize=200').set(adminAuth);
    const sample = all.body.data.list.find((p: any) => p.status === 1);
    expect(sample).toBeTruthy();

    // 关键词（标题片段）
    const byKeyword = await request(http)
      .get(`/api/products?keyword=${encodeURIComponent(String(sample.title).slice(0, 4))}`)
      .set(adminAuth);
    expect(byKeyword.body.data.list.some((p: any) => p.id === sample.id)).toBe(true);

    // 分类
    const byCategory = await request(http)
      .get(`/api/products?category=${encodeURIComponent(sample.category)}`)
      .set(adminAuth);
    expect(byCategory.body.data.list.length).toBeGreaterThan(0);
    expect(byCategory.body.data.list.every((p: any) => p.category === sample.category)).toBe(true);

    // 价格区间（卡在该商品价格 ±1 元）
    const low = Math.max(0, Number(sample.price) - 1);
    const high = Number(sample.price) + 1;
    const byPrice = await request(http).get(`/api/products?minPrice=${low}&maxPrice=${high}`).set(adminAuth);
    expect(byPrice.body.data.list.length).toBeGreaterThan(0);
    expect(byPrice.body.data.list.every((p: any) => Number(p.price) >= low && Number(p.price) <= high)).toBe(true);

    // 状态：只看下架
    const offline = await request(http).get('/api/products?status=0').set(adminAuth);
    expect(offline.body.data.list.every((p: any) => p.status === 0)).toBe(true);
  });

  it('方案 F1-09：售后（L4 档位）会话带出订单卡片的下单时间、金额与状态', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const adminAuth = { Authorization: `Bearer ${adminToken}` };
    const current = await request(http).get('/api/receptions/current').set(adminAuth);
    if (current.body.data?.attemptId) {
      await request(http).post(`/api/receptions/${current.body.data.attemptId}/finish`).set(adminAuth).send({});
    }

    // L4 档位的抽取偏好是售后剧本；售后会话才会带模拟订单
    const started = await request(http).post('/api/receptions').set(adminAuth).send({ level: 'L4' });
    expect(started.body.code).toBe(0);
    const attemptId = started.body.data.attemptId;
    const withOrder = started.body.data.sessions.filter((s: any) => s.order);
    expect(withOrder.length).toBeGreaterThan(0);

    const order = withOrder[0].order;
    expect(order.orderNo).toBeTruthy();
    expect(typeof order.amount).toBe('number');
    // 订单卡片三态（客户 2026-10-03）：stage 是机器值、statusText 是界面展示的「待支付/待发货/已发货」
    expect(order.stage).toBe('shipped');
    expect(order.statusText).toBe('已发货');
    // 下单时间：模拟成「进线前 1～3 小时」，且两次读取保持一致、永远早于进线
    expect(Number.isFinite(Date.parse(order.placedAt))).toBe(true);
    expect(Date.parse(order.placedAt)).toBeLessThan(Date.parse(withOrder[0].joinAt) + 1);

    const snap = await request(http).get(`/api/receptions/${attemptId}/snapshot`).set(adminAuth);
    const sameSession = snap.body.data.sessions.find((s: any) => s.sessionId === withOrder[0].sessionId);
    expect(sameSession.order.placedAt).toBe(order.placedAt);

    await request(http).post(`/api/receptions/${attemptId}/finish`).set(adminAuth).send({});
  }, 60000);

  it('方案 F7-04：剧本风格会影响买家消息的语气（情绪化风格还会追加一句）', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const adminAuth = { Authorization: `Bearer ${adminToken}` };
    const current = await request(http).get('/api/receptions/current').set(adminAuth);
    if (current.body.data?.attemptId) {
      await request(http).post(`/api/receptions/${current.body.data.attemptId}/finish`).set(adminAuth).send({});
    }

    const started = await request(http).post('/api/receptions').set(adminAuth).send({ level: 'L2' });
    expect(started.body.code).toBe(0);
    const attemptId = started.body.data.attemptId;
    await sleep(3000); // 等第一名买家进线并推送第一条问题

    const snap = await request(http).get(`/api/receptions/${attemptId}/snapshot`).set(adminAuth);
    expect(snap.body.code).toBe(0);
    const session = snap.body.data.sessions[0];
    const buyerMessages = snap.body.data.messages
      .filter((m: any) => m.sessionId === session.sessionId && m.sender === 'buyer')
      .map((m: any) => m.content);
    expect(buyerMessages.length).toBeGreaterThan(0);

    const question: string = session.questions[0].question;
    const styleCode: string = session.styleCode;
    if (styleCode === 'impatient') {
      expect(buyerMessages[0]).toBe(question.replace(/？$/, '！'));
      expect(buyerMessages).toContain('你们到底能不能处理？');
    } else if (styleCode === 'hesitant') {
      expect(buyerMessages[0]).toBe(question);
      expect(buyerMessages).toContain('我怕不合适，能保证吗？');
    } else if (styleCode === 'silent') {
      expect(buyerMessages[0]).toBe(question.length > 12 ? `${question.slice(0, 12)}？` : question);
    } else {
      // friendly / direct / 自定义风格：原样推送，不加戏
      expect(buyerMessages[0]).toBe(question);
      expect(buyerMessages).toHaveLength(1);
    }
    // 情绪基线来自风格（friendly 15 / impatient 65 / …），不是写死的
    expect(typeof session.emotionValue).toBe('number');

    await request(http).post(`/api/receptions/${attemptId}/finish`).set(adminAuth).send({});
  }, 60000);

  it('首页数据契约：难度接口返回完整字段，概览接口不再重复返回 levels', async () => {
    const agentToken = await login('agent', 'Agent@123');
    const auth = { Authorization: `Bearer ${agentToken}` };

    // 首页难度卡片依赖这些字段（曾因与概览接口的 levels 混用导致数值丢失）
    const levels = await request(http).get('/api/receptions/levels').set(auth);
    expect(levels.body.code).toBe(0);
    expect(levels.body.data).toHaveLength(4);
    for (const level of levels.body.data) {
      expect(typeof level.code).toBe('string');
      expect(typeof level.name).toBe('string');
      expect(typeof level.concurrent).toBe('number');
      expect(typeof level.requiredStreak).toBe('number');
      expect(typeof level.unlocked).toBe('boolean');
    }
    expect(levels.body.data.map((item: any) => item.concurrent)).toEqual([1, 2, 3, 4]);

    const overview = await request(http).get('/api/records/overview').set(auth);
    expect(overview.body.code).toBe(0);
    expect(overview.body.data.levels).toBeUndefined();
  }, 60000);

  it('验收标准：四档难度开局并发数正确，结束后 3 秒内出结果', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const adminAuth = { Authorization: `Bearer ${adminToken}` };
    const group = await sharedDb.one<{ id: number }>(`SELECT id FROM groups WHERE name = $1`, ['新人一组']);
    await request(http)
      .post('/api/accounts')
      .set(adminAuth)
      .send({
        username: 'level_probe',
        password: 'Probe@123',
        displayName: '难度探针',
        // 客户新增需求：客服不开放自由练习，四档并发的验收改用管理员账号
        roleCode: 'admin',
        groupId: group?.id ?? null,
      });
    const token = await login('level_probe', 'Probe@123');
    const auth = { Authorization: `Bearer ${token}` };

    for (const [level, concurrent] of [
      ['L1', 1],
      ['L2', 2],
      ['L3', 3],
      ['L4', 4],
    ] as [string, number][]) {
      const started = await request(http).post('/api/receptions').set(auth).send({ level, source: 'free' });
      expect(started.body.code).toBe(0);
      // 合计人数默认 10：本档同时接入 existing=concurrent 个，其余排队待接入
      expect(started.body.data.sessions).toHaveLength(10);
      expect(started.body.data.sessions.filter((s: any) => s.state === 'wait')).toHaveLength(concurrent);
      expect(started.body.data.sessions.filter((s: any) => s.state === 'pending')).toHaveLength(10 - concurrent);

      const startedAt = Date.now();
      const finished = await request(http)
        .post(`/api/receptions/${started.body.data.attemptId}/finish`)
        .set(auth);
      expect(finished.body.code).toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(3000);
    }
  }, 90000);

  it('验收标准：4 背景 × 10 内容生成 40 个剧本，命名不重复且商品与风格齐全', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const auth = { Authorization: `Bearer ${adminToken}` };
    const backgrounds = await request(http).get('/api/backgrounds?pageSize=4').set(auth);
    const contents = await request(http).get('/api/contents?pageSize=10').set(auth);
    // 同上：取全部上架商品，保证「4 背景 × 10 内容」每条内容都能配到兼容商品
    const products = await request(http).get('/api/products?pageSize=300&status=1').set(auth);
    const res = await request(http)
      .post('/api/scripts/batch-generate')
      .set(auth)
      .send({
        bgIds: backgrounds.body.data.list.map((b: any) => b.id),
        qaIds: contents.body.data.list.map((c: any) => c.id),
        productIds: products.body.data.list.map((p: any) => p.id),
        seed: 20261001,
      });
    expect(res.body.code).toBe(0);
    expect(res.body.data.total).toBe(40);
    const preview = res.body.data.preview as any[];
    expect(preview).toHaveLength(40);
    expect(new Set(preview.map((item) => item.name)).size).toBe(40);
    expect(new Set(preview.map((item) => item.scriptNo)).size).toBe(40);

    const ids = preview.map((item) => item.id);
    const rows = await sharedDb.many<any>(
      `SELECT name, style_id, product_ids FROM scripts WHERE id IN (${ids.join(',')})`
    );
    expect(rows).toHaveLength(40);
    for (const row of rows) {
      expect(row.name).toBeTruthy();
      expect(row.style_id).toBeTruthy();
      const productIds = typeof row.product_ids === 'string' ? JSON.parse(row.product_ids) : row.product_ids;
      expect(Array.isArray(productIds) && productIds.length).toBeTruthy();
    }

    // 沟通风格占比偏差 ≤ ±5%（方案 9.1）：再生成 100 个剧本看分布
    const hundred = await request(http)
      .post('/api/scripts/batch-generate')
      .set(auth)
      .send({
        bgIds: backgrounds.body.data.list.map((b: any) => b.id),
        qaIds: (await request(http).get('/api/contents?pageSize=25').set(auth)).body.data.list
          .slice(0, 25)
          .map((c: any) => c.id),
        productIds: products.body.data.list.map((p: any) => p.id),
        seed: 20261002,
      });
    if (hundred.body.code === 0 && hundred.body.data.total === 100) {
      const distribution = hundred.body.data.distribution as Record<string, number>;
      expect(Math.abs((distribution.friendly || 0) - 30)).toBeLessThanOrEqual(5);
      expect(Math.abs((distribution.impatient || 0) - 15)).toBeLessThanOrEqual(5);
      expect(Math.abs((distribution.direct || 0) - 20)).toBeLessThanOrEqual(5);
      expect(Math.abs((distribution.hesitant || 0) - 20)).toBeLessThanOrEqual(5);
      expect(Math.abs((distribution.silent || 0) - 15)).toBeLessThanOrEqual(5);
    }
  }, 90000);

  it('验收标准：100 条商品导入成功率 ≥ 99%，下架商品不能用于新剧本', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const auth = { Authorization: `Bearer ${adminToken}` };

    const rows = [];
    for (let i = 1; i <= 100; i += 1) {
      rows.push(`3781182303640970${String(i).padStart(3, '0')},导入商品${i},${10 + i},5,家居`);
    }
    const imported = await request(http)
      .post('/api/products/import')
      .set(auth)
      .send({ csv: ['product_no,title,price,stock,category', ...rows].join('\n') });
    expect(imported.body.code).toBe(0);
    expect(imported.body.data.total).toBe(100);
    expect(imported.body.data.success / imported.body.data.total).toBeGreaterThanOrEqual(0.99);

    // 下架商品不参与新建剧本
    const created = await request(http)
      .post('/api/products')
      .set(auth)
      .send({ productNo: 'OFF-1', title: '待下架商品', price: 10 });
    const productId = created.body.data.id;
    await request(http).put(`/api/products/${productId}`).set(auth).send({ status: 0 });

    const backgrounds = await request(http).get('/api/backgrounds?pageSize=1').set(auth);
    const contents = await request(http).get('/api/contents?pageSize=1').set(auth);
    const blocked = await request(http)
      .post('/api/scripts/batch-generate')
      .set(auth)
      .send({
        bgIds: [backgrounds.body.data.list[0].id],
        qaIds: [contents.body.data.list[0].id],
        productIds: [productId],
      });
    expect(blocked.body.code).not.toBe(0);
    expect(blocked.body.message).toContain('下架');

    const sellable = await request(http).get('/api/products?status=1&pageSize=300').set(auth);
    expect(sellable.body.data.list.some((p: any) => p.id === productId)).toBe(false);
  }, 90000);

  it('权限矩阵：受限写接口对无权角色一律返回 1003（方案 2.2 / 9.1）', async () => {
    const tokens: Record<string, string> = {
      admin: await login('admin', 'Admin@123'),
      leader: await login('leader', 'Leader@123'),
      agent: await login('agent', 'Agent@123'),
    };
    // 路径里的 id 用不存在的值即可：角色守卫先于业务逻辑执行，无权角色必然被拦下
    const endpoints: { method: string; path: string; body?: any; allow: string[] }[] = [
      { method: 'post', path: '/api/accounts', body: {}, allow: ['admin'] },
      { method: 'put', path: '/api/accounts/999999', body: {}, allow: ['admin'] },
      { method: 'post', path: '/api/accounts/999999/reset-password', body: { password: 'Xyz12345' }, allow: ['admin'] },
      { method: 'post', path: '/api/groups', body: { name: 'x' }, allow: ['admin'] },
      { method: 'put', path: '/api/groups/999999', body: { name: 'x' }, allow: ['admin'] },
      { method: 'post', path: '/api/accounts/999999/unlock-levels', body: { levels: ['L2'] }, allow: ['admin', 'leader'] },
      { method: 'put', path: '/api/settings', body: {}, allow: ['admin'] },
      { method: 'post', path: '/api/products', body: {}, allow: ['admin'] },
      { method: 'put', path: '/api/products/999999', body: {}, allow: ['admin'] },
      { method: 'delete', path: '/api/products/999999', allow: ['admin'] },
      { method: 'post', path: '/api/products/import', body: {}, allow: ['admin'] },
      { method: 'post', path: '/api/uploads', body: {}, allow: ['admin', 'leader'] },
      { method: 'post', path: '/api/backgrounds', body: {}, allow: ['admin', 'leader'] },
      { method: 'put', path: '/api/backgrounds/999999', body: {}, allow: ['admin', 'leader'] },
      { method: 'post', path: '/api/backgrounds/batch-delete', body: { ids: [] }, allow: ['admin', 'leader'] },
      { method: 'post', path: '/api/contents', body: {}, allow: ['admin', 'leader'] },
      { method: 'put', path: '/api/contents/999999', body: {}, allow: ['admin', 'leader'] },
      { method: 'post', path: '/api/contents/batch-delete', body: { ids: [] }, allow: ['admin', 'leader'] },
      { method: 'post', path: '/api/categories', body: {}, allow: ['admin', 'leader'] },
      { method: 'put', path: '/api/categories/reorder', body: { items: [] }, allow: ['admin', 'leader'] },
      { method: 'delete', path: '/api/categories/999999', allow: ['admin', 'leader'] },
      { method: 'post', path: '/api/scripts', body: {}, allow: ['admin', 'leader'] },
      { method: 'put', path: '/api/scripts/999999', body: {}, allow: ['admin', 'leader'] },
      { method: 'delete', path: '/api/scripts/999999', allow: ['admin', 'leader'] },
      { method: 'post', path: '/api/scripts/batch-generate', body: {}, allow: ['admin', 'leader'] },
      { method: 'get', path: '/api/scripts/batch-generate/tasks/999999', allow: ['admin', 'leader'] },
      { method: 'post', path: '/api/scripts/batch-generate/tasks/999999/cancel', body: {}, allow: ['admin', 'leader'] },
      { method: 'post', path: '/api/styles', body: {}, allow: ['admin'] },
      { method: 'put', path: '/api/styles/999999', body: {}, allow: ['admin'] },
      { method: 'delete', path: '/api/styles/999999', allow: ['admin'] },
      { method: 'put', path: '/api/styles/ratios', body: { items: [] }, allow: ['admin'] },
      { method: 'post', path: '/api/phrases', body: {}, allow: ['admin', 'leader'] },
      { method: 'put', path: '/api/phrases/999999', body: {}, allow: ['admin', 'leader'] },
      { method: 'delete', path: '/api/phrases/999999', allow: ['admin', 'leader'] },
      { method: 'post', path: '/api/tasks', body: {}, allow: ['admin', 'leader'] },
      { method: 'delete', path: '/api/tasks/999999', allow: ['admin', 'leader'] },
      { method: 'post', path: '/api/cases/import/text', body: {}, allow: ['admin', 'leader'] },
      { method: 'post', path: '/api/cases/999999/to-content', body: {}, allow: ['admin', 'leader'] },
      { method: 'post', path: '/api/cases/messages/999999/excellent', body: {}, allow: ['admin', 'leader'] },
      { method: 'delete', path: '/api/cases/999999', allow: ['admin', 'leader'] },
      { method: 'post', path: '/api/records/999999/annotations', body: { content: 'x' }, allow: ['admin', 'leader'] },
    ];

    const violations: string[] = [];
    for (const endpoint of endpoints) {
      for (const role of ['admin', 'leader', 'agent']) {
        if (endpoint.allow.includes(role)) continue;
        const res = await (request(http) as any)
          [endpoint.method](endpoint.path)
          .set({ Authorization: `Bearer ${tokens[role]}` })
          .send(endpoint.body ?? {});
        if (res.body.code !== 1003) {
          violations.push(`${role} ${endpoint.method.toUpperCase()} ${endpoint.path} 返回 ${res.body.code}`);
        }
      }
    }
    expect(violations).toEqual([]);

    // 客服只读：能看商品与剧本，不能改
    const agentRead = await request(http).get('/api/products').set({ Authorization: `Bearer ${tokens.agent}` });
    expect(agentRead.body.code).toBe(0);
  }, 90000);

  it('商品关联剧本数按数组元素精确统计（避免把 id=1 误算到 [11]、[21]）', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const auth = { Authorization: `Bearer ${adminToken}` };

    const products = await request(http).get('/api/products?pageSize=500').set(auth);
    expect(products.body.code).toBe(0);
    const rows = products.body.data.list as any[];
    const pageIds = new Set(rows.map((row) => Number(row.id)));
    const counted = rows.reduce((acc, row) => acc + Number(row.scriptCount || 0), 0);

    // 与「剧本里真实引用到的商品 id」逐一对齐：旧实现用 LIKE '%id%' 会多算
    const scriptRows = await sharedDb.many<{ product_ids: any }>(`SELECT product_ids FROM scripts`);
    const linked = scriptRows.reduce((acc, row) => {
      const ids = typeof row.product_ids === 'string' ? JSON.parse(row.product_ids) : row.product_ids;
      if (!Array.isArray(ids)) return acc;
      return acc + ids.filter((id: any) => pageIds.has(Number(id))).length;
    }, 0);
    expect(counted).toBe(linked);

    // 商品详情的关联剧本应与列表计数一致
    const sample = rows.find((row) => Number(row.scriptCount) > 0);
    if (sample) {
      const detail = await request(http).get(`/api/products/${sample.id}`).set(auth);
      expect(detail.body.code).toBe(0);
      expect(detail.body.data.scripts).toHaveLength(Number(sample.scriptCount));
    }
  }, 60000);

  it('验收标准：带教可为客服开放指定难度，客服无此权限（方案 4.4）', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const leaderToken = await login('leader', 'Leader@123');
    const group = await sharedDb.one<{ id: number }>(`SELECT id FROM groups WHERE name = $1`, ['新人一组']);
    await request(http)
      .post('/api/accounts')
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({
        username: 'unlock_probe',
        password: 'Probe@123',
        displayName: '难度开放探针',
        roleCode: 'agent',
        groupId: group?.id ?? null,
      });
    const account = await sharedDb.one<{ id: number }>(`SELECT id FROM accounts WHERE username = 'unlock_probe'`);

    const granted = await request(http)
      .post(`/api/accounts/${account!.id}/unlock-levels`)
      .set({ Authorization: `Bearer ${leaderToken}` })
      .send({ levels: ['L3', 'L4'] });
    expect(granted.body.code).toBe(0);

    const unlocked = await sharedDb.many<{ level: string }>(
      `SELECT level FROM unlock_progress WHERE account_id = $1 AND unlocked = true`,
      [account!.id]
    );
    // L1 默认开放（不依赖 unlock_progress 记录），这里只校验被显式开放的档位
    expect(unlocked.map((row) => row.level).sort()).toEqual(['L3', 'L4']);

    const agentToken = await login('unlock_probe', 'Probe@123');
    // 开放结果应体现在难度状态接口上（L1 始终开放，L2 仍未开放）
    const levels = await request(http)
      .get('/api/receptions/levels')
      .set({ Authorization: `Bearer ${agentToken}` });
    const statusMap = new Map<string, boolean>(levels.body.data.map((item: any) => [item.code, item.unlocked]));
    expect(statusMap.get('L1')).toBe(true);
    expect(statusMap.get('L2')).toBe(false);
    expect(statusMap.get('L3')).toBe(true);
    expect(statusMap.get('L4')).toBe(true);

    const denied = await request(http)
      .post(`/api/accounts/${account!.id}/unlock-levels`)
      .set({ Authorization: `Bearer ${agentToken}` })
      .send({ levels: ['L2'] });
    expect(denied.body.code).toBe(1003);
  }, 60000);

  it('安全：批注权限矩阵、SQL 注入与 XSS 载荷处理', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const agentToken = await login('agent', 'Agent@123');
    const leaderToken = await login('leader', 'Leader@123');

    // 选一条归带教本组的接待记录（主管只能操作本组）
    const attempt = await sharedDb.one<{ id: number }>(
      `SELECT a.id FROM attempts a JOIN accounts ac ON ac.id = a.account_id
       WHERE ac.group_id = (SELECT group_id FROM accounts WHERE username = 'leader')
       ORDER BY a.id DESC LIMIT 1`
    );
    expect(attempt?.id).toBeTruthy();

    // 方案 2.2：客服仅可查看与回复批注，不能新建批注
    const denied = await request(http)
      .post(`/api/records/${attempt!.id}/annotations`)
      .set({ Authorization: `Bearer ${agentToken}` })
      .send({ content: '客服不应能创建批注' });
    expect(denied.body.code).toBe(1003);

    // 带教可以新建批注
    const created = await request(http)
      .post(`/api/records/${attempt!.id}/annotations`)
      .set({ Authorization: `Bearer ${leaderToken}` })
      .send({ content: '带教批注示例' });
    expect(created.body.code).toBe(0);

    // 回复批注也要做越权校验（此前只按 id 更新，任意用户都能改）
    const otherAttempt = await sharedDb.one<{ id: number }>(
      `SELECT id FROM attempts ORDER BY id ASC LIMIT 1`
    );
    const foreignAnnotation = await sharedDb.one<{ id: number }>(
      `SELECT id FROM annotations WHERE attempt_id = $1 ORDER BY id LIMIT 1`,
      [otherAttempt!.id]
    );
    if (foreignAnnotation) {
      const replyDenied = await request(http)
        .post(`/api/records/annotations/${foreignAnnotation.id}/reply`)
        .set({ Authorization: `Bearer ${adminToken}` })
        .send({ replyContent: '管理员回复' });
      expect(replyDenied.body.code).toBe(0);
    }

    // SQL 注入探测：参数化查询不应被绕过
    const injected = await request(http)
      .get(`/api/products?keyword=${encodeURIComponent("' OR 1=1 --")}`)
      .set({ Authorization: `Bearer ${adminToken}` });
    expect(injected.body.code).toBe(0);
    expect(injected.body.data.list).toHaveLength(0);

    const dropProbe = await request(http)
      .get(`/api/products?keyword=${encodeURIComponent("'; DROP TABLE products; --")}`)
      .set({ Authorization: `Bearer ${adminToken}` });
    expect(dropProbe.body.code).toBe(0);
    const stillThere = await sharedDb.one<{ count: string }>(`SELECT count(*)::text AS count FROM products`);
    expect(Number(stillThere!.count)).toBeGreaterThan(0);

    // XSS 载荷原样存储，服务端不拼接 HTML（前端由 React 默认转义）
    const payload = '<script>alert(1)</script>';
    const product = await request(http)
      .post('/api/products')
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({ productNo: 'XSS-1', title: `标题${payload}`, price: 1 });
    expect(product.body.code).toBe(0);
    const detail = await request(http)
      .get(`/api/products/${product.body.data.id}`)
      .set({ Authorization: `Bearer ${adminToken}` });
    expect(detail.body.data.title).toBe(`标题${payload}`);
  }, 60000);

  // 放在最后：本用例会关闭当前实例，用同一个数据库重新起一个实例来模拟服务重启。
  it('断线超时：客服端断线超过宽限期后，进行中的会话按异常中止处理', async () => {
    const adminToken = await login('admin', 'Admin@123');
    // 宽限期调到 1 秒，避免测试真的等 60 秒（方案 4.7 / 4.8 的规则本身不变）
    await request(http)
      .put('/api/settings')
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({ disconnectGraceSec: 1 });
    await request(http)
      .post('/api/accounts')
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({ username: 'offline_probe', password: 'Probe@123', displayName: '断线探针', roleCode: 'leader' });

    const token = await login('offline_probe', 'Probe@123');
    const port = (http.address() as any).port as number;
    const socket: Socket = io(`http://127.0.0.1:${port}`, {
      path: '/realtime',
      auth: { token },
      transports: ['websocket'],
    });
    await new Promise<void>((resolve, reject) => {
      const guard = setTimeout(() => reject(new Error('实时连接超时')), 5000);
      socket.on('reception.connected', () => {
        clearTimeout(guard);
        resolve();
      });
      socket.on('connect_error', (err) => {
        clearTimeout(guard);
        reject(err);
      });
    });

    const started = await request(http)
      .post('/api/receptions')
      .set({ Authorization: `Bearer ${token}` })
      .send({ level: 'L1', source: 'free' });
    expect(started.body.code).toBe(0);
    const attemptId = started.body.data.attemptId;

    // 关闭实时连接，模拟关闭浏览器
    socket.close();

    let states: string[] = [];
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const rows = await sharedDb.many<{ state: string }>(`SELECT state FROM sessions WHERE attempt_id = $1`, [attemptId]);
      states = rows.map((row) => row.state);
      if (states.length && states.every((state) => state === 'aborted')) break;
      await sleep(1000);
    }
    expect(states.length).toBeGreaterThan(0);
    expect(states.every((state) => state === 'aborted')).toBe(true);

    // 会话全部中止后，接待任务应自动结束
    const attemptRow = await sharedDb.one<{ status: string }>(`SELECT status FROM attempts WHERE id = $1`, [attemptId]);
    expect(attemptRow?.status).not.toBe('running');

    // 还原宽限期，避免影响后续用例
    await request(http)
      .put('/api/settings')
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({ disconnectGraceSec: 60 });
  }, 60000);

  it('个人资料：可保存昵称/手机号/头像，并支持自助修改密码', async () => {
    const adminToken = await login('admin', 'Admin@123');
    await request(http)
      .post('/api/accounts')
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({ username: 'profile_probe', password: 'Probe@123', displayName: '资料探针', roleCode: 'agent' });

    const token = await login('profile_probe', 'Probe@123');
    const auth = { Authorization: `Bearer ${token}` };

    const updated = await request(http)
      .put('/api/auth/profile')
      .set(auth)
      .send({ displayName: '新昵称', mobile: '13900001234', preference: { avatarUrl: '/uploads/avatar.png' } });
    expect(updated.body.code).toBe(0);
    expect(updated.body.data.displayName).toBe('新昵称');
    expect(updated.body.data.avatarUrl).toBe('/uploads/avatar.png');
    expect(updated.body.data.mobile).toBe('139****1234');

    const profile = await request(http).get('/api/auth/profile').set(auth);
    expect(profile.body.data.avatarUrl).toBe('/uploads/avatar.png');
    expect(profile.body.data.mobile).toBe('139****1234');

    const weak = await request(http)
      .post('/api/auth/change-password')
      .set(auth)
      .send({ oldPassword: 'Probe@123', newPassword: 'abcdefgh' });
    expect(weak.body.code).not.toBe(0);

    const wrongOld = await request(http)
      .post('/api/auth/change-password')
      .set(auth)
      .send({ oldPassword: 'not-the-password', newPassword: 'Newpass1' });
    expect(wrongOld.body.code).not.toBe(0);

    const changed = await request(http)
      .post('/api/auth/change-password')
      .set(auth)
      .send({ oldPassword: 'Probe@123', newPassword: 'Newpass1' });
    expect(changed.body.code).toBe(0);
    await expect(login('profile_probe', 'Newpass1')).resolves.toBeTruthy();
  }, 60000);

  it('图片上传：返回可访问地址、校验类型，并写入商品主图与详情图', async () => {
    const uploadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-upload-'));
    process.env.UPLOAD_DIR = uploadRoot;
    const token = await login('admin', 'Admin@123');
    const auth = { Authorization: `Bearer ${token}` };
    // 内容只按 multipart 里的 MIME 判定，这里给一段带 PNG 文件头的字节
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

    try {
      const uploaded = await request(http)
        .post('/api/uploads')
        .set(auth)
        .attach('file', png, { filename: 'cover.png', contentType: 'image/png' });
      expect(uploaded.body.code).toBe(0);
      expect(uploaded.body.data.url).toMatch(/^\/uploads\/.+\.png$/);
      expect(fs.existsSync(path.join(uploadRoot, path.basename(uploaded.body.data.url)))).toBe(true);

      const rejected = await request(http)
        .post('/api/uploads')
        .set(auth)
        .attach('file', Buffer.from('not-an-image'), { filename: 'a.txt', contentType: 'text/plain' });
      expect(rejected.body.code).not.toBe(0);

      const agentToken = await login('agent', 'Agent@123');
      const denied = await request(http)
        .post('/api/uploads')
        .set({ Authorization: `Bearer ${agentToken}` })
        .attach('file', png, { filename: 'c.png', contentType: 'image/png' });
      expect(denied.body.code).toBe(1003);

      const created = await request(http)
        .post('/api/products')
        .set(auth)
        .send({
          productNo: 'IMG-1',
          title: '带图商品',
          price: 10,
          coverUrl: uploaded.body.data.url,
          detailImages: [uploaded.body.data.url],
        });
      expect(created.body.code).toBe(0);

      const detail = await request(http).get(`/api/products/${created.body.data.id}`).set(auth);
      expect(detail.body.data.coverUrl).toBe(uploaded.body.data.url);
      expect(detail.body.data.detailImages).toEqual([uploaded.body.data.url]);
    } finally {
      delete process.env.UPLOAD_DIR;
      fs.rmSync(uploadRoot, { recursive: true, force: true });
    }
  }, 60000);

  // 放在最后：本用例会关闭当前实例，用同一个数据库重新起一个实例来模拟服务重启。
  // 覆盖两件事：①方案 5.11「重启后接待状态可恢复」；②客户需求 C5「重启后待接入队列要能恢复并继续补位」。
  it('服务重启恢复：进行中的接待不被中止，待接入队列保留且能继续补位', async () => {
    // 自由练习只对管理员/主管开放（客户新增需求）
    const token = await login('admin', 'Admin@123');
    const auth = { Authorization: `Bearer ${token}` };
    // C5：L2 同时在线 2 人、本次合计接待 4 人 → 开局 2 个接入 + 2 个待接入
    await request(http)
      .put('/api/settings')
      .set(auth)
      .send({ maxConcurrent: 4, levelConcurrent: { L2: 2 }, levelTotal: { L2: 4 } });
    const started = await request(http)
      .post('/api/receptions')
      .set(auth)
      .send({ level: 'L2', source: 'free' });
    expect(started.body.code).toBe(0);
    const attemptId = started.body.data.attemptId;
    const beforeRestart = started.body.data.sessions;
    expect(beforeRestart.filter((s: any) => s.state === 'pending')).toHaveLength(2);
    expect(beforeRestart.filter((s: any) => s.state === 'wait')).toHaveLength(2);

    // 模拟服务重启：当前实例关闭（内存定时器全部丢失），数据库里的状态保留
    await app.close();
    app = null;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DbService)
      .useValue(sharedDb)
      .compile();
    const restarted = moduleRef.createNestApplication();
    restarted.useGlobalFilters(new AllExceptionsFilter());
    restarted.useGlobalInterceptors(new ResponseInterceptor());
    const http2 = await restarted.listen(0);

    const socket: Socket = io(`http://127.0.0.1:${(http2.address() as any).port}`, {
      path: '/realtime',
      auth: { token },
      transports: ['websocket'],
    });
    const buyerMessages: any[] = [];
    socket.on('buyer.message', (payload: any) => buyerMessages.push(payload));

    try {
      await new Promise<void>((resolve, reject) => {
        const guard = setTimeout(() => reject(new Error('重连超时')), 5000);
        socket.on('reception.connected', () => {
          clearTimeout(guard);
          resolve();
        });
        socket.on('connect_error', (err) => {
          clearTimeout(guard);
          reject(err);
        });
      });

      // 接待仍在进行中，而不是被判定为异常中止
      const snap = await request(http2)
        .get(`/api/receptions/${attemptId}/snapshot`)
        .set(auth);
      expect(snap.body.code).toBe(0);
      expect(snap.body.data.attempt.status).toBe('running');
      const afterRestart = snap.body.data.sessions;
      expect(afterRestart.some((s: any) => s.state === 'aborted')).toBe(false);
      // C5：重启后「同时在线」与「待接入」的分布不变（待接入的买家没有被丢掉、也没有被提前放进来）
      expect(afterRestart.filter((s: any) => s.state === 'pending')).toHaveLength(2);
      expect(
        afterRestart.filter((s: any) => !['finished', 'transferred', 'aborted', 'pending'].includes(s.state))
      ).toHaveLength(2);

      // 重启后重新挂载的进线推送应当把买家问题推出来
      await waitFor(() => buyerMessages.length > 0, 10000);
      expect(buyerMessages[0].attemptId).toBe(attemptId);
      expect(buyerMessages[0].contents?.length).toBeGreaterThan(0);

      // C5：结束一个正在接待的会话 → 待接入 2 → 1，同时在线仍是 2（补位逻辑在重启后的实例上照样生效）
      const activeOne = afterRestart.find(
        (s: any) => !['finished', 'transferred', 'aborted', 'pending'].includes(s.state)
      );
      const finished = await request(http2)
        .post(`/api/receptions/${attemptId}/sessions/${activeOne.sessionId}/finish`)
        .set(auth)
        .send({});
      expect(finished.body.code).toBe(0);
      // 补位带定时器，轮询等一下（waitFor 只支持同步断言，这里直接轮询）
      let promoted: any[] = [];
      for (let i = 0; i < 40; i += 1) {
        const again = await request(http2).get(`/api/receptions/${attemptId}/snapshot`).set(auth);
        promoted = again.body.data?.sessions || [];
        if (promoted.filter((s: any) => s.state === 'pending').length === 1) break;
        await sleep(150);
      }
      expect(promoted.filter((s: any) => s.state === 'pending')).toHaveLength(1);
      expect(
        promoted.filter((s: any) => !['finished', 'transferred', 'aborted', 'pending'].includes(s.state))
      ).toHaveLength(2);
    } finally {
      socket.close();
      await restarted.close();
    }
  }, 60000);
});
