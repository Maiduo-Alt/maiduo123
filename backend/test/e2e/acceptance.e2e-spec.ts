import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { DbService } from '../../src/db/db.service';
import { AllExceptionsFilter } from '../../src/common/all-exceptions.filter';
import { ResponseInterceptor } from '../../src/common/response.interceptor';
import { ERR } from '../../src/common/errors';
import { createTestDb } from '../util/test-db';

/**
 * 方案 9.1 功能验收标准里，「实现正确」最容易口说无凭的几条，单独用真实 HTTP + 真实 SQL 锁住：
 *  - 客户问题剧本：被引用素材不可删除、停用剧本不再被抽取
 *  - 账号：改权重只影响新接待（参数快照）、停用账号无法登录且历史保留
 */
describe('验收标准：素材保护 / 剧本启停 / 参数快照 / 账号停用', () => {
  let app: INestApplication;
  let http: any;
  let db: DbService;

  beforeAll(async () => {
    db = await createTestDb();
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

  async function startAttempt(token: string, level = 'L1'): Promise<number> {
    const res = await request(http)
      .post('/api/receptions')
      .set('Authorization', `Bearer ${token}`)
      .send({ level, source: 'free' });
    expect(res.body.code).toBe(0);
    return res.body.data.attemptId;
  }

  async function finishAttempt(token: string, attemptId: number): Promise<void> {
    const res = await request(http)
      .post(`/api/receptions/${attemptId}/finish`)
      .set('Authorization', `Bearer ${token}`);
    expect({ code: res.body.code, message: res.body.message }).toEqual({ code: 0, message: 'ok' });
  }

  async function accountId(token: string, username: string): Promise<number> {
    const res = await request(http).get('/api/accounts').set('Authorization', `Bearer ${token}`);
    expect(res.body.code).toBe(0);
    const row = res.body.data.list.find((item: any) => item.username === username);
    expect(row).toBeTruthy();
    return row.id;
  }

  it('断线续接：离开接待页后能用「进行中的接待」找回，结束后不再返回', async () => {
    // 自由练习只对管理员/主管开放（客户新增需求）
    const agent = await login('leader', 'Leader@123');
    const auth = { Authorization: `Bearer ${agent}` };

    const idle = await request(http).get('/api/receptions/current').set(auth);
    expect(idle.body.code).toBe(0);
    expect(idle.body.data).toBeNull();

    const attemptId = await startAttempt(agent, 'L1');
    const found = await request(http).get('/api/receptions/current').set(auth);
    expect(found.body.code).toBe(0);
    expect(found.body.data).toMatchObject({ attemptId, level: 'L1', source: 'free' });

    await finishAttempt(agent, attemptId);
    const afterFinish = await request(http).get('/api/receptions/current').set(auth);
    expect(afterFinish.body.data).toBeNull();
  });

  it('客户问题剧本：被剧本引用的背景与内容不可删除，未被引用的可以删', async () => {
    const admin = await login('admin', 'Admin@123');
    const auth = { Authorization: `Bearer ${admin}` };

    const backgrounds = await request(http).get('/api/backgrounds?pageSize=5').set(auth);
    expect(backgrounds.body.code).toBe(0);
    expect(backgrounds.body.data.list.length).toBeGreaterThan(0);
    const referencedBgId = backgrounds.body.data.list[0].id;

    const blockedBg = await request(http)
      .post('/api/backgrounds/batch-delete')
      .set(auth)
      .send({ ids: [referencedBgId] });
    expect(blockedBg.body.code).toBe(ERR.MATERIAL_REFERENCED);
    expect(blockedBg.body.message).toContain('无法删除');

    const contents = await request(http).get('/api/contents?pageSize=5').set(auth);
    expect(contents.body.code).toBe(0);
    const referencedQaId = contents.body.data.list[0].id;
    const blockedQa = await request(http)
      .post('/api/contents/batch-delete')
      .set(auth)
      .send({ ids: [referencedQaId] });
    expect(blockedQa.body.code).toBe(ERR.MATERIAL_REFERENCED);

    // 反向验证：没有被剧本引用的素材可以正常删除
    const created = await request(http)
      .post('/api/backgrounds')
      .set(auth)
      .send({ name: '验收用临时背景', description: '未被任何剧本引用', category: '通用' });
    expect(created.body.code).toBe(0);
    const removed = await request(http)
      .post('/api/backgrounds/batch-delete')
      .set(auth)
      .send({ ids: [created.body.data.id] });
    expect(removed.body.code).toBe(0);
  });

  it('客户问题剧本：剧本全部停用后无法开局，只启用一本时开局只用它', async () => {
    // 自由练习只对管理员/主管开放（客户新增需求）
    const agent = await login('leader', 'Leader@123');

    await db.query(`UPDATE scripts SET status = 0`);
    const blocked = await request(http)
      .post('/api/receptions')
      .set('Authorization', `Bearer ${agent}`)
      .send({ level: 'L1', source: 'free' });
    expect(blocked.body.code).toBe(ERR.PARAM);
    expect(blocked.body.message).toContain('没有可用剧本');

    const only = await db.one<{ id: number }>(`SELECT id FROM scripts ORDER BY id LIMIT 1`);
    await db.query(`UPDATE scripts SET status = 1 WHERE id = $1`, [only.id]);
    // 方案 9.2 场景六：同一次接待不重复使用同一咨询内容，所以只剩 1 个可用剧本时，
    // L2 只会接入 1 名买家，而不是把同一个剧本派给两个买家。
    const attemptId = await startAttempt(agent, 'L2');
    const sessions = await db.many<{ script_id: number }>(`SELECT script_id FROM sessions WHERE attempt_id = $1`, [
      attemptId,
    ]);
    expect(sessions.length).toBe(1);
    expect(sessions.every((row) => Number(row.script_id) === Number(only.id))).toBe(true);

    await finishAttempt(agent, attemptId);
    await db.query(`UPDATE scripts SET status = 1`);
  });

  it('账号：改考核权重只影响新接待，历史接待保留原参数快照', async () => {
    const admin = await login('admin', 'Admin@123');
    const agent = await login('leader', 'Leader@123');
    const auth = { Authorization: `Bearer ${admin}` };

    const before = await request(http).get('/api/settings').set(auth);
    expect(before.body.code).toBe(0);
    const originalWeights = before.body.data.weights;

    const firstAttempt = await startAttempt(agent, 'L1');
    const snapBefore = await db.one<any>(`SELECT param_snapshot FROM attempts WHERE id = $1`, [firstAttempt]);
    expect(snapBefore.param_snapshot.weights).toEqual(originalWeights);

    const newWeights = { response: 50, solving: 30, wording: 10, emotion: 10 };
    const updated = await request(http).put('/api/settings').set(auth).send({ weights: newWeights });
    expect(updated.body.code).toBe(0);

    // 已经开出去的这一次接待，快照必须原封不动（方案 3.8：参数不追溯历史）
    const snapAfter = await db.one<any>(`SELECT param_snapshot FROM attempts WHERE id = $1`, [firstAttempt]);
    expect(snapAfter.param_snapshot.weights).toEqual(originalWeights);

    await finishAttempt(agent, firstAttempt);
    const secondAttempt = await startAttempt(agent, 'L1');
    const snapSecond = await db.one<any>(`SELECT param_snapshot FROM attempts WHERE id = $1`, [secondAttempt]);
    expect(snapSecond.param_snapshot.weights).toEqual(newWeights);
    await finishAttempt(agent, secondAttempt);

    await request(http).put('/api/settings').set(auth).send({ weights: originalWeights });
  });

  it('账号：停用后无法登录，但历史接待明细仍可被带教查看', async () => {
    const admin = await login('admin', 'Admin@123');
    const auth = { Authorization: `Bearer ${admin}` };
    // 用带教账号做「有历史接待」的被停用对象：客服已不开放自由练习，前面的用例都以带教身份开局
    const agentId = await accountId(admin, 'leader');

    const recordsBefore = await request(http).get(`/api/records?accountId=${agentId}`).set(auth);
    expect(recordsBefore.body.code).toBe(0);
    const totalBefore = recordsBefore.body.data.total;
    expect(totalBefore).toBeGreaterThan(0);

    const disabled = await request(http).put(`/api/accounts/${agentId}`).set(auth).send({ status: 0 });
    expect(disabled.body.code).toBe(0);

    const denied = await request(http).post('/api/auth/login').send({ username: 'leader', password: 'Leader@123' });
    expect(denied.body.code).toBe(ERR.FORBIDDEN);

    const recordsAfter = await request(http).get(`/api/records?accountId=${agentId}`).set(auth);
    expect(recordsAfter.body.code).toBe(0);
    expect(recordsAfter.body.data.total).toBe(totalBefore);

    await request(http).put(`/api/accounts/${agentId}`).set(auth).send({ status: 1 });
    const restored = await request(http).post('/api/auth/login').send({ username: 'leader', password: 'Leader@123' });
    expect(restored.body.code).toBe(0);
  });
});
