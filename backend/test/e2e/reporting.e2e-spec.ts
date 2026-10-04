import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { DbService } from '../../src/db/db.service';
import { AllExceptionsFilter } from '../../src/common/all-exceptions.filter';
import { ResponseInterceptor } from '../../src/common/response.interceptor';
import { parseXlsx } from '../../src/common/xlsx';
import { createTestDb } from '../util/test-db';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 收二进制响应（导出接口返回的是 xlsx 流，不是 JSON）。 */
const binaryParser = (res: any, callback: (error: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};

/**
 * 导出与统计（方案 F2-08 明细导出 / F4-07 商品导出 / F3-12 剧本统计 / F7-07 风格效果统计）。
 */
describe('导出与统计', () => {
  let app: INestApplication;
  let http: any;

  beforeAll(async () => {
    const db = await createTestDb();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DbService)
      .useValue(db)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
    http = app.getHttpServer();
  }, 180000);

  afterAll(async () => {
    await app?.close();
  });

  async function login(username: string, password: string): Promise<string> {
    const res = await request(http).post('/api/auth/login').send({ username, password });
    expect(res.body.code).toBe(0);
    return res.body.data.token;
  }

  /** 任务训练用：给客服下发一个涵盖 L1～L3 的任务，客服只能走任务训练（客户新增需求）。 */
  async function ensureAgentTask(): Promise<number> {
    const leaderToken = await login('leader', 'Leader@123');
    const auth = { Authorization: `Bearer ${leaderToken}` };
    const tasks = await request(http).get('/api/tasks').set(auth);
    const existing = tasks.body.data.find((row: any) => row.name === '报表用例任务');
    if (existing) return existing.id;
    const accounts = await request(http).get('/api/accounts').set(auth);
    const agentId = accounts.body.data.list.find((row: any) => row.username === 'agent').id;
    const created = await request(http)
      .post('/api/tasks')
      .set(auth)
      .send({
        name: '报表用例任务',
        levels: ['L1', 'L2', 'L3'],
        deadline: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
        targetCount: 1,
        targets: [{ metric: 'total_score', operator: 'gte', threshold: 0 }],
        assignees: [agentId],
      });
    expect(created.body.code).toBe(0);
    return created.body.data.id;
  }

  /** 造一次已结束的接待（客服走任务训练），让统计与导出都有真实数据。 */
  async function runOnce(level = 'L1', reply = '亲，您好，我马上帮您确认一下，稍等一分钟～') {
    const token = await login('agent', 'Agent@123');
    const auth = { Authorization: `Bearer ${token}` };
    const taskId = await ensureAgentTask();
    const started = await request(http).post('/api/receptions').set(auth).send({ level, source: 'task', taskId });
    expect(started.body.code).toBe(0);
    const attemptId = started.body.data.attemptId;
    const sessionId = started.body.data.sessions[0].sessionId;
    await sleep(2500);
    await request(http)
      .post(`/api/receptions/${attemptId}/sessions/${sessionId}/messages`)
      .set(auth)
      .send({ content: reply });
    await request(http).post(`/api/receptions/${attemptId}/finish`).set(auth).send({});
    return attemptId;
  }

  it('明细导出为 Excel：两张表（接待明细 + 对话全文），过滤条件与列表一致', async () => {
    const attemptId = await runOnce('L1');
    const adminToken = await login('admin', 'Admin@123');
    const auth = { Authorization: `Bearer ${adminToken}` };

    const res = await request(http)
      .get('/api/records/export')
      .set(auth)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(String(res.headers['content-disposition'])).toContain('attachment');

    const rows = parseXlsx(res.body as Buffer);
    expect(rows[0]).toEqual([
      '接待编号',
      '客服',
      '小组',
      '难度',
      '来源',
      '接待时长',
      '会话数',
      '总分',
      '结论',
      '开始时间',
      '结束时间',
    ]);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.some((row) => row[3] === 'L1')).toBe(true);
    // 第二张表（对话全文）也在包里
    expect((res.body as Buffer).includes(Buffer.from('xl/worksheets/sheet2.xml'))).toBe(true);

    // 用不存在的关键词过滤时，导出里只剩表头
    const filtered = await request(http)
      .get('/api/records/export?keyword=不存在的接待')
      .set(auth)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);
    expect(parseXlsx(filtered.body as Buffer)).toHaveLength(1);
    expect(attemptId).toBeGreaterThan(0);
  });

  it('商品导出为 Excel，列头与导入模板一致', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const res = await request(http)
      .get('/api/products/export')
      .set({ Authorization: `Bearer ${adminToken}` })
      .buffer(true)
      .parse(binaryParser)
      .expect(200);
    const rows = parseXlsx(res.body as Buffer);
    expect(rows[0]).toEqual([
      'product_no',
      'title',
      'price',
      'origin_price',
      'stock',
      'category',
      'services',
      'scenes',
      'status',
    ]);
    expect(rows.length).toBeGreaterThan(1);
  });

  it('剧本统计：被练次数、平均分、超时率与难点排行', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const auth = { Authorization: `Bearer ${adminToken}` };

    const before = await request(http).get('/api/scripts/stats').set(auth);
    expect(before.body.code).toBe(0);
    expect(before.body.data.totals.scripts).toBeGreaterThan(0);
    expect(before.body.data.totals.practicedScripts).toBeGreaterThan(0);
    expect(before.body.data.totals.sessions).toBeGreaterThan(0);
    expect(typeof before.body.data.totals.timeoutRate).toBe('number');
    expect(before.body.data.hardest.length).toBeGreaterThan(0);

    const practiced = before.body.data.rows.find((row: any) => row.sessionCount > 0);
    expect(practiced).toBeTruthy();
    expect(practiced).toHaveProperty('avgScore');
    expect(practiced).toHaveProperty('timeoutRate');
    // 超时率 = 超时会话 / 会话数
    expect(practiced.timeoutRate).toBe(
      Math.round((practiced.timeoutSessions / practiced.sessionCount) * 1000) / 10
    );
  });

  it('风格效果统计：每种风格的被练次数与达标率', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const res = await request(http).get('/api/styles/stats').set({ Authorization: `Bearer ${adminToken}` });
    expect(res.body.code).toBe(0);
    expect(res.body.data.items.length).toBeGreaterThanOrEqual(5);
    const practiced = res.body.data.items.filter((item: any) => item.attemptCount > 0);
    expect(practiced.length).toBeGreaterThan(0);
    practiced.forEach((item: any) => {
      expect(item.passRate).toBe(Math.round((item.passCount / item.attemptCount) * 1000) / 10);
    });
    // 没练过的风格不显示成 0%，避免误导
    const untouched = res.body.data.items.find((item: any) => item.attemptCount === 0);
    if (untouched) expect(untouched.passRate).toBeNull();
  });

  it('个人成长曲线：按天汇总总分、首响与超时次数（方案 F2-09）', async () => {
    const agentToken = await login('agent', 'Agent@123');
    const auth = { Authorization: `Bearer ${agentToken}` };
    // 按天口径要显式指定 granularity（默认已改成「当天每次模拟」，见下一条用例）
    const res = await request(http).get('/api/records/trend?days=30&granularity=day').set(auth);
    expect(res.body.code).toBe(0);
    expect(res.body.data.days).toBe(30);
    expect(res.body.data.granularity).toBe('day');
    expect(res.body.data.points.every((p: any) => /^\d{4}-\d{2}-\d{2}$/.test(p.date))).toBe(true);
    expect(res.body.data.points.length).toBeGreaterThan(0);
    const point = res.body.data.points[res.body.data.points.length - 1];
    expect(point).toHaveProperty('date');
    expect(point).toHaveProperty('avgScore');
    expect(point).toHaveProperty('avgFirstResponse');
    expect(point).toHaveProperty('timeoutCount');
    expect(res.body.data.summary.attempts).toBeGreaterThan(0);
    // 天数参数有上下限，避免拉出超长序列
    const capped = await request(http).get('/api/records/trend?days=999&granularity=day').set(auth);
    expect(capped.body.data.days).toBe(90);

    // 客服只能看自己：即使指定别人的 accountId 也只会返回自己的数据
    const leaderView = await request(http).get('/api/records/trend?days=30&granularity=day&accountId=4').set(auth);
    expect(leaderView.body.data.accountId).toBe(res.body.data.accountId);
  });

  it('个人成长曲线：默认按「当天每次模拟」给出每局一个点', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const adminAuth = { Authorization: `Bearer ${adminToken}` };

    // 当天做两局（管理员自由练习，不受难度解锁限制）
    for (let i = 0; i < 2; i += 1) {
      const current = await request(http).get('/api/receptions/current').set(adminAuth);
      if (current.body.data?.attemptId) {
        await request(http).post(`/api/receptions/${current.body.data.attemptId}/finish`).set(adminAuth).send({});
      }
      const started = await request(http).post('/api/receptions').set(adminAuth).send({ level: 'L1' });
      expect(started.body.code).toBe(0);
      await sleep(1500);
      await request(http).post(`/api/receptions/${started.body.data.attemptId}/finish`).set(adminAuth).send({});
    }

    const trend = await request(http).get('/api/records/trend').set(adminAuth);
    expect(trend.body.code).toBe(0);
    expect(trend.body.data.granularity).toBe('session');
    expect(trend.body.data.points.length).toBeGreaterThanOrEqual(2);
    // 每个点就是一局：标签是 HH:mm、带 attemptId、单局分数不是按天平均
    expect(
      trend.body.data.points.every((p: any) => /^\d{2}:\d{2}$/.test(p.date) && Number(p.attemptId) > 0)
    ).toBe(true);
    expect(trend.body.data.summary.attempts).toBeGreaterThanOrEqual(2);
  }, 90000);

  it('明细详情带出会话级四维得分，供对比视图使用', async () => {
    const agentToken = await login('agent', 'Agent@123');
    const auth = { Authorization: `Bearer ${agentToken}` };
    const list = await request(http).get('/api/records?pageSize=1').set(auth);
    const detail = await request(http).get(`/api/records/${list.body.data.list[0].id}`).set(auth);
    expect(detail.body.code).toBe(0);
    expect(detail.body.data.attempt).toHaveProperty('attempt_no');
    expect(detail.body.data.attempt).toHaveProperty('total_score');
    const session = detail.body.data.sessions[0];
    // 对比视图（F2-07）直接读这些字段做并排比较，缺一个就会显示成空
    ['responseScore', 'solvingScore', 'wordingScore', 'emotionScore', 'maxResponseSec', 'timeoutCount'].forEach((key) => {
      expect(session).toHaveProperty(key);
    });
  });
});
