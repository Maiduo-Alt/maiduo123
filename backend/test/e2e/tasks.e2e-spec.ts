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
 * 回复模拟任务：下发范围与权限矩阵（方案 2.2 / 6.x）。
 *
 * 回归点：客服角色的任务列表曾用关联子查询过滤 task_assignees，
 * pg-mem 不支持子查询引用外层别名，导致 `column "t.id" does not exist`
 * 抛 500。这里把「客服只看到下发给自己的任务、带教看到全部」锁进用例。
 */
describe('回复模拟任务：下发范围与权限', () => {
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

  async function accountId(token: string, username: string): Promise<number> {
    const res = await request(http).get('/api/accounts').set('Authorization', `Bearer ${token}`);
    expect(res.body.code).toBe(0);
    const row = res.body.data.list.find((item: any) => item.username === username);
    expect(row).toBeTruthy();
    return row.id;
  }

  function taskPayload(name: string, assignees: number[]) {
    return {
      name,
      levels: ['L1', 'L2'],
      deadline: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(),
      targetCount: 2,
      targets: [{ metric: 'total_score', operator: 'gte', threshold: 70 }],
      assignees,
    };
  }

  it('带教下发的任务只对指定客服可见，且列表带上 targets 与 assigneeCount', async () => {
    const leaderToken = await login('leader', 'Leader@123');
    const agentId = await accountId(leaderToken, 'agent');
    const agent2Id = await accountId(leaderToken, 'agent2');

    const created = await request(http)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${leaderToken}`)
      .send(taskPayload('会员咨询专项训练', [agentId]));
    expect(created.body.code).toBe(0);
    const agentTaskId = created.body.data.id;

    const created2 = await request(http)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${leaderToken}`)
      .send(taskPayload('售后场景专项训练', [agent2Id]));
    expect(created2.body.code).toBe(0);

    // 客服 A 只能看到下发给自己的那条，不再是 500
    const agentToken = await login('agent', 'Agent@123');
    const agentList = await request(http).get('/api/tasks').set('Authorization', `Bearer ${agentToken}`);
    expect(agentList.body.code).toBe(0);
    expect(agentList.body.data.map((row: any) => row.id)).toEqual([agentTaskId]);

    // 客服 B 看到的是另一条
    const agent2Token = await login('agent2', 'Agent@123');
    const agent2List = await request(http).get('/api/tasks').set('Authorization', `Bearer ${agent2Token}`);
    expect(agent2List.body.code).toBe(0);
    expect(agent2List.body.data.map((row: any) => row.id)).toEqual([created2.body.data.id]);

    // 带教看到全部，且列表字段足够渲染任务表格
    const leaderList = await request(http).get('/api/tasks').set('Authorization', `Bearer ${leaderToken}`);
    expect(leaderList.body.code).toBe(0);
    expect(leaderList.body.data).toHaveLength(2);
    const row = leaderList.body.data.find((item: any) => item.id === agentTaskId);
    expect(row).toMatchObject({ name: '会员咨询专项训练', targetCount: 2, assigneeCount: 1, doneCount: 0 });
    expect(row.targets).toEqual([{ metric: 'total_score', operator: 'gte', threshold: 70 }]);
  });

  it('任务列表标出「是否下发给当前账号」，避免带教点进别人的任务才发现开不了', async () => {
    const leaderToken = await login('leader', 'Leader@123');
    const leaderAuth = { Authorization: `Bearer ${leaderToken}` };
    const agentId = await accountId(leaderToken, 'agent');

    const created = await request(http)
      .post('/api/tasks')
      .set(leaderAuth)
      .send(taskPayload('定向下发任务', [agentId]));
    expect(created.body.code).toBe(0);
    const taskId = created.body.data.id;

    // 带教能看到这条任务，但不是下发给自己的
    const leaderList = await request(http).get('/api/tasks').set(leaderAuth);
    const leaderRow = leaderList.body.data.find((row: any) => row.id === taskId);
    expect(leaderRow).toMatchObject({ assignedToMe: false, assigneeCount: 1 });

    // 被下发的客服看到的是 assignedToMe: true
    const agentToken = await login('agent', 'Agent@123');
    const agentList = await request(http).get('/api/tasks').set({ Authorization: `Bearer ${agentToken}` });
    const agentRow = agentList.body.data.find((row: any) => row.id === taskId);
    expect(agentRow).toMatchObject({ assignedToMe: true });
    // 客服看的是「我的进度」：接口要给出当前账号自己的完成次数（doneCount 是"完成人数"，口径不同）
    expect(agentRow).toHaveProperty('myDoneCount');
    expect(agentRow.myDoneCount).toBe(0);

    await request(http).delete(`/api/tasks/${taskId}`).set(leaderAuth);
  });

  it('客服无权创建任务，管理员可以查看任务报表', async () => {
    const agentToken = await login('agent', 'Agent@123');
    const denied = await request(http)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${agentToken}`)
      .send(taskPayload('越权创建', [3]));
    expect(denied.body.code).toBe(1003);

    const adminToken = await login('admin', 'Admin@123');
    const list = await request(http).get('/api/tasks').set('Authorization', `Bearer ${adminToken}`);
    expect(list.body.code).toBe(0);
    expect(list.body.data.length).toBeGreaterThan(0);

    const taskId = list.body.data[0].id;
    const report = await request(http)
      .get(`/api/tasks/${taskId}/report`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(report.body.code).toBe(0);
    expect(report.body.data.assignees.length).toBeGreaterThan(0);
    expect(report.body.data.assignees[0]).toHaveProperty('doneCount');
    expect(report.body.data.assignees[0]).toHaveProperty('avgScore');
  });

  it('任务训练：只抽任务范围内的剧本，难度与下发对象都要校验（方案 F6-02 / F6-03 / F6-04）', async () => {
    const leaderToken = await login('leader', 'Leader@123');
    const leaderAuth = { Authorization: `Bearer ${leaderToken}` };
    const agentId = await accountId(leaderToken, 'agent');
    const otherAgentToken = await login('agent2', 'Agent@123');

    // 只圈定 2 个剧本，开局后每个会话都必须落在这两个里
    const picked = await db.many<{ id: number }>(`SELECT id FROM scripts ORDER BY id LIMIT 2`);
    const scriptIds = picked.map((row) => Number(row.id));

    const created = await request(http)
      .post('/api/tasks')
      .set(leaderAuth)
      .send({
        ...taskPayload('范围限定任务', [agentId]),
        levels: ['L2'],
        scopeType: 'scripts',
        scopeValue: { scriptIds },
      });
    expect(created.body.code).toBe(0);
    const taskId = created.body.data.id;

    // 没有被下发的客服开不了这个任务
    const notAssigned = await request(http)
      .post('/api/receptions')
      .set('Authorization', `Bearer ${otherAgentToken}`)
      .send({ level: 'L2', source: 'task', taskId });
    expect(notAssigned.body.code).toBe(ERR.FORBIDDEN);

    // 任务只允许 L2，用 L1 开局要被拦住
    const agentToken = await login('agent', 'Agent@123');
    const agentAuth = { Authorization: `Bearer ${agentToken}` };
    // 方案 4.4：L2 默认未解锁，先由带教开放（否则会被「逐步解锁」拦下，测不到任务本身的校验）
    const agentAccount = await request(http).get('/api/accounts').set(leaderAuth);
    const assignedAgentId = agentAccount.body.data.list.find((row: any) => row.username === 'agent').id;
    const grantRes = await request(http)
      .post(`/api/accounts/${assignedAgentId}/unlock-levels`)
      .set(leaderAuth)
      .send({ levels: ['L2'] });
    expect(grantRes.body.code).toBe(0);
    const wrongLevel = await request(http)
      .post('/api/receptions')
      .set(agentAuth)
      .send({ level: 'L1', source: 'task', taskId });
    expect(wrongLevel.body.code).toBe(ERR.PARAM);

    const started = await request(http)
      .post('/api/receptions')
      .set(agentAuth)
      .send({ level: 'L2', source: 'task', taskId });
    expect(started.body.code).toBe(0);
    const attemptId = started.body.data.attemptId;

    const sessions = await db.many<{ script_id: number }>(`SELECT script_id FROM sessions WHERE attempt_id = $1`, [
      attemptId,
    ]);
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((row) => scriptIds.includes(Number(row.script_id)))).toBe(true);

    // 快照要带出任务信息，接待页据此显示任务名 / 目标 / 进度
    const snapshot = await request(http).get(`/api/receptions/${attemptId}/snapshot`).set(agentAuth);
    expect(snapshot.body.code).toBe(0);
    expect(snapshot.body.data.attempt.task).toMatchObject({ id: taskId, name: '范围限定任务' });
    expect(snapshot.body.data.attempt.task.targets.length).toBeGreaterThan(0);

    await request(http).post(`/api/receptions/${attemptId}/finish`).set(agentAuth).send({});
  });

  it('方案 F6-08 / F6-09：全部达标后任务自动标记完成，报表给出完成率与未通过名单', async () => {
    const leaderToken = await login('leader', 'Leader@123');
    const leaderAuth = { Authorization: `Bearer ${leaderToken}` };
    const accounts = await request(http).get('/api/accounts').set(leaderAuth);
    const agentId = accounts.body.data.list.find((row: any) => row.username === 'agent').id;
    const agent2Id = accounts.body.data.list.find((row: any) => row.username === 'agent2').id;

    // 两个参与者、每人达标 1 次；阈值设 0 保证「必定达标」，用例只验状态流转与报表口径
    const created = await request(http)
      .post('/api/tasks')
      .set(leaderAuth)
      .send({
        name: '完成率与未通过名单用例',
        levels: ['L1'],
        deadline: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        targetCount: 1,
        targets: [{ metric: 'total_score', operator: 'gte', threshold: 0 }],
        assignees: [agentId, agent2Id],
      });
    expect(created.body.code).toBe(0);
    const taskId = created.body.data.id;

    const agentToken = await login('agent', 'Agent@123');
    const agentAuth = { Authorization: `Bearer ${agentToken}` };
    const started = await request(http)
      .post('/api/receptions')
      .set(agentAuth)
      .send({ level: 'L1', source: 'task', taskId });
    expect(started.body.code).toBe(0);
    await request(http).post(`/api/receptions/${started.body.data.attemptId}/finish`).set(agentAuth).send({});

    // 只有 1/2 完成：任务仍是 running，完成率 50%，未通过名单里是另一个客服
    const halfway = await request(http).get(`/api/tasks/${taskId}/report`).set(leaderAuth);
    expect(halfway.body.code).toBe(0);
    expect(halfway.body.data.participantCount).toBe(2);
    expect(halfway.body.data.completionRate).toBe(50);
    expect(halfway.body.data.failedAssignees.map((row: any) => row.accountId)).toEqual([agent2Id]);
    const stillRunning = await request(http).get('/api/tasks').set(leaderAuth);
    expect(stillRunning.body.data.find((row: any) => row.id === taskId).status).toBe('running');

    // 第二个客服也达标 → 任务自动变成「已完成」，未通过名单清空
    const a2 = { Authorization: `Bearer ${await login('agent2', 'Agent@123')}` };
    const second = await request(http)
      .post('/api/receptions')
      .set(a2)
      .send({ level: 'L1', source: 'task', taskId });
    expect(second.body.code).toBe(0);
    await request(http).post(`/api/receptions/${second.body.data.attemptId}/finish`).set(a2).send({});

    const report = await request(http).get(`/api/tasks/${taskId}/report`).set(leaderAuth);
    expect(report.body.data.completionRate).toBe(100);
    expect(report.body.data.failedAssignees).toHaveLength(0);
    expect(report.body.data.task.status).toBe('finished');
  }, 60000);

  it('方案 3.6：截止后任务自动关闭，客服不能再开局', async () => {
    const leaderToken = await login('leader', 'Leader@123');
    const leaderAuth = { Authorization: `Bearer ${leaderToken}` };
    const accounts = await request(http).get('/api/accounts').set(leaderAuth);
    const agentId = accounts.body.data.list.find((row: any) => row.username === 'agent').id;

    // 建一个 1 秒后截止的任务
    const created = await request(http)
      .post('/api/tasks')
      .set(leaderAuth)
      .send({
        name: '截止自动关闭用例',
        levels: ['L1'],
        deadline: new Date(Date.now() + 1000).toISOString(),
        targetCount: 1,
        targets: [{ metric: 'total_score', operator: 'gte', threshold: 0 }],
        assignees: [agentId],
      });
    expect(created.body.code).toBe(0);
    const taskId = created.body.data.id;

    const agentToken = await login('agent', 'Agent@123');
    const agentAuth = { Authorization: `Bearer ${agentToken}` };
    const before = await request(http).get('/api/tasks').set(agentAuth);
    expect(before.body.data.find((row: any) => row.id === taskId).status).toBe('running');

    // 等过期。注意这里**先不读列表**：状态字段还是 running，用来验证「按截止时间直接拦」这条兜底
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const denied = await request(http)
      .post('/api/receptions')
      .set(agentAuth)
      .send({ level: 'L1', source: 'task', taskId });
    expect(denied.body.code).toBe(ERR.PARAM);
    expect(denied.body.message).toContain('截止');

    // 读列表会顺带把到期任务置为 finished（方案 3.6「截止后任务自动关闭」）
    const after = await request(http).get('/api/tasks').set(agentAuth);
    expect(after.body.data.find((row: any) => row.id === taskId).status).toBe('finished');

    // 再开一次：这时状态已被自动关闭，走「已结束」分支
    const deniedAgain = await request(http)
      .post('/api/receptions')
      .set(agentAuth)
      .send({ level: 'L1', source: 'task', taskId });
    expect(deniedAgain.body.code).toBe(ERR.PARAM);
    expect(deniedAgain.body.message).toMatch(/已结束|截止/);
  }, 60000);
});
