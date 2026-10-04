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
 * 客户新增需求（2026-10-02 确认）对应的回归：
 *   需求 2：客服不开放自由练习（界面藏入口 + 后端必须拦住）
 *   需求 3：管理账号可设置各难度的接入买家数（levelConcurrent）
 */
describe('客户新增需求：自由练习权限 / 接入人数可配置', () => {
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

  const startFree = (token: string, level = 'L1') =>
    request(http)
      .post('/api/receptions')
      .set({ Authorization: `Bearer ${token}` })
      .send({ level, source: 'free' });

  /**
   * 开局前先收尾「当前进行中的接待」。
   * 用例之间共享同一个内存库，前一条用例的收尾若有残留会让 start 返回 2001，
   * 这里显式清一次，避免用例互相干扰（表现是偶发失败）。
   */
  async function finishRunningAttempt(token: string): Promise<void> {
    const auth = { Authorization: `Bearer ${token}` };
    const current = await request(http).get('/api/receptions/current').set(auth);
    const attemptId = current.body.data?.attemptId;
    if (attemptId) await request(http).post(`/api/receptions/${attemptId}/finish`).set(auth).send({});
  }

  it('客服调自由练习被拦（1003），管理员与主管可以正常开局', async () => {
    const agentToken = await login('agent', 'Agent@123');
    const denied = await startFree(agentToken, 'L1');
    expect(denied.body.code).toBe(ERR.FORBIDDEN);
    // 客户 2026-10-03：界面术语统一叫「模拟训练」（原「自由练习」）
    expect(denied.body.message).toContain('模拟训练');

    const adminToken = await login('admin', 'Admin@123');
    const adminStart = await startFree(adminToken, 'L1');
    expect(adminStart.body.code).toBe(0);
    // 客户 2026-10-03：合计接待人数默认 10 人 → L1 接入 1 人、其余排队
    expect(adminStart.body.data.sessions).toHaveLength(10);
    expect(adminStart.body.data.sessions.filter((s: any) => s.state === 'wait')).toHaveLength(1);
    await request(http)
      .post(`/api/receptions/${adminStart.body.data.attemptId}/finish`)
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({});

    const leaderToken = await login('leader', 'Leader@123');
    const leaderStart = await startFree(leaderToken, 'L2');
    expect(leaderStart.body.code).toBe(0);
    expect(leaderStart.body.data.sessions).toHaveLength(10);
    expect(leaderStart.body.data.sessions.filter((s: any) => s.state === 'wait')).toHaveLength(2);
    await request(http)
      .post(`/api/receptions/${leaderStart.body.data.attemptId}/finish`)
      .set({ Authorization: `Bearer ${leaderToken}` })
      .send({});
  });

  it('客服走任务训练不被牵连（source=task 正常开局）', async () => {
    const leaderToken = await login('leader', 'Leader@123');
    const leaderAuth = { Authorization: `Bearer ${leaderToken}` };
    const accounts = await request(http).get('/api/accounts').set(leaderAuth);
    const agentId = accounts.body.data.list.find((row: any) => row.username === 'agent').id;
    // 方案 4.4：难度逐步解锁——客服默认只开 L1，要开 L2 得先由带教/管理员开放难度。
    // 这里顺便把「开放难度」这条通道也跑一遍。
    const granted = await request(http)
      .post(`/api/accounts/${agentId}/unlock-levels`)
      .set(leaderAuth)
      .send({ levels: ['L2'] });
    expect(granted.body.code).toBe(0);
    const task = await request(http)
      .post('/api/tasks')
      .set(leaderAuth)
      .send({
        name: '客服任务训练用例',
        levels: ['L1', 'L2'],
        deadline: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(),
        targetCount: 1,
        targets: [{ metric: 'total_score', operator: 'gte', threshold: 0 }],
        assignees: [agentId],
      });
    expect(task.body.code).toBe(0);

    const agentToken = await login('agent', 'Agent@123');
    const agentAuth = { Authorization: `Bearer ${agentToken}` };
    const started = await request(http)
      .post('/api/receptions')
      .set(agentAuth)
      .send({ level: 'L2', source: 'task', taskId: task.body.data.id });
    expect(started.body.code).toBe(0);
    // 默认合计 10 人：L2 接入 2 人、其余排队（这条用例只验任务训练不被误拦）
    expect(started.body.data.sessions).toHaveLength(10);
    expect(started.body.data.sessions.filter((s: any) => s.state === 'wait')).toHaveLength(2);

    await request(http)
      .post(`/api/receptions/${started.body.data.attemptId}/finish`)
      .set(agentAuth)
      .send({});
  });

  it('接入人数可按档位配置：越界被拒，与全局上限按 min() 生效', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const adminAuth = { Authorization: `Bearer ${adminToken}` };

    const bad = await request(http)
      .put('/api/settings')
      .set(adminAuth)
      .send({ levelConcurrent: { L1: 5 } });
    expect(bad.body.code).toBe(ERR.PARAM);
    expect(bad.body.message).toContain('1～4');

    // 全局上限与每档人数是 min() 的关系：上限压到 2 后，L1 配 4 也只接 2 人
    const capped = await request(http)
      .put('/api/settings')
      .set(adminAuth)
      .send({ maxConcurrent: 2, levelConcurrent: { L1: 4, L2: 2, L3: 3, L4: 4 } });
    expect(capped.body.code).toBe(0);
    const cappedLevels = await request(http).get('/api/receptions/levels').set(adminAuth);
    expect(cappedLevels.body.data.find((row: any) => row.code === 'L1').concurrent).toBe(2);

    // 恢复上限并合法配置：L1 接 3 人、L4 只接 1 人
    const applied = await request(http)
      .put('/api/settings')
      .set(adminAuth)
      .send({ maxConcurrent: 4, levelConcurrent: { L1: 3, L2: 2, L3: 3, L4: 1 } });
    expect(applied.body.code).toBe(0);
    expect(applied.body.data.levelConcurrent).toEqual({ L1: 3, L2: 2, L3: 3, L4: 1 });

    // 难度接口回传的是「实际生效」的人数
    const levels = await request(http).get('/api/receptions/levels').set(adminAuth);
    const l1 = levels.body.data.find((row: any) => row.code === 'L1');
    const l4 = levels.body.data.find((row: any) => row.code === 'L4');
    expect(l1.concurrent).toBe(3);
    expect(l1.defaultConcurrent).toBe(1);
    expect(l4.concurrent).toBe(1);

    // 开局人数按配置走（自由练习与任务训练都取这个值）
    const started = await startFree(adminToken, 'L1');
    expect(started.body.code).toBe(0);
    // 接入人数按档位配置生效：L1 配 3 → 3 人接入，其余按默认合计 10 人排队
    expect(started.body.data.sessions).toHaveLength(10);
    expect(started.body.data.sessions.filter((s: any) => s.state === 'wait')).toHaveLength(3);
    await request(http)
      .post(`/api/receptions/${started.body.data.attemptId}/finish`)
      .set(adminAuth)
      .send({});

    const l4Start = await startFree(adminToken, 'L4');
    expect(l4Start.body.code).toBe(0);
    expect(l4Start.body.data.sessions).toHaveLength(10);
    expect(l4Start.body.data.sessions.filter((s: any) => s.state === 'wait')).toHaveLength(1);
    await request(http)
      .post(`/api/receptions/${l4Start.body.data.attemptId}/finish`)
      .set(adminAuth)
      .send({});
  });

  it('C5：合计接待人数默认 10 人（管理员可提前设置）', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const adminAuth = { Authorization: `Bearer ${adminToken}` };
    await finishRunningAttempt(adminToken);
    // 显式置空 = 恢复默认：客户 2026-10-03 口径默认 10 人
    await request(http)
      .put('/api/settings')
      .set(adminAuth)
      .send({ maxConcurrent: 4, levelConcurrent: { L2: 2 }, levelTotal: {} });

    const started = await startFree(adminToken, 'L2');
    expect(started.body.code).toBe(0);
    const sessions = started.body.data.sessions;
    expect(sessions).toHaveLength(10);
    expect(sessions.filter((s: any) => s.state === 'wait')).toHaveLength(2);
    expect(sessions.filter((s: any) => s.state === 'pending')).toHaveLength(8);
    await request(http).post(`/api/receptions/${started.body.data.attemptId}/finish`).set(adminAuth).send({});
  });

  it('C5：总接待人数大于同时在线时，多出的买家排队，空位即补（对齐赤兔火眼）', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const adminAuth = { Authorization: `Bearer ${adminToken}` };
    await finishRunningAttempt(adminToken);

    // 越界校验：总接待人数 1～20
    const bad = await request(http).put('/api/settings').set(adminAuth).send({ levelTotal: { L2: 21 } });
    expect(bad.body.code).toBe(ERR.PARAM);
    expect(bad.body.message).toContain('1～20');

    // L2：同时在线 2 人，本次合计接待 5 人
    const saved = await request(http)
      .put('/api/settings')
      .set(adminAuth)
      .send({ maxConcurrent: 4, levelConcurrent: { L2: 2 }, levelTotal: { L2: 5 } });
    expect(saved.body.code).toBe(0);

    const started = await startFree(adminToken, 'L2');
    expect(started.body.code).toBe(0);
    const attemptId = started.body.data.attemptId;
    const sessions = started.body.data.sessions;
    // 剧本按「总量」抽 5 个，但只有 2 个接入，其余 3 个待接入
    expect(sessions).toHaveLength(5);
    expect(sessions.filter((s: any) => s.state === 'pending')).toHaveLength(3);
    expect(sessions.filter((s: any) => s.state === 'wait')).toHaveLength(2);

    const snapshot = async () => {
      const res = await request(http).get(`/api/receptions/${attemptId}/snapshot`).set(adminAuth);
      if (!res.body.data) throw new Error(`snapshot 失败：${JSON.stringify(res.body)}`);
      return res.body.data.sessions;
    };
    const activeCount = async () =>
      (await snapshot()).filter((s: any) => !['finished', 'transferred', 'aborted', 'pending'].includes(s.state)).length;
    expect(await activeCount()).toBeLessThanOrEqual(2);

    /**
     * 客户 2026-10-03（看过赤兔火眼实测后拍板）：**空位即补**——
     * 每结束一个正在接待的会话，就补进一个「待接入」买家，同时在线始终顶到上限。
     */
    const activeOne = sessions.find((s: any) => s.state === 'wait');
    const finishedRes = await request(http)
      .post(`/api/receptions/${attemptId}/sessions/${activeOne.sessionId}/finish`)
      .set(adminAuth)
      .send({});
    expect(finishedRes.body.code).toBe(0);
    let afterFirst: any[] = [];
    for (let i = 0; i < 40; i += 1) {
      afterFirst = await snapshot();
      if (afterFirst.filter((s: any) => s.state === 'pending').length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    // 结束 1 个 → 待接入 3→2、正在接待仍是 2（补位顶满，不等整批结束）
    expect(afterFirst.filter((s: any) => s.state === 'pending')).toHaveLength(2);
    expect(await activeCount()).toBe(2);

    // 再结束一个 → 再补一个，正在接待继续顶满 2
    const activeTwo = afterFirst.find(
      (s: any) => !['finished', 'transferred', 'aborted', 'pending'].includes(s.state)
    );
    await request(http)
      .post(`/api/receptions/${attemptId}/sessions/${activeTwo.sessionId}/finish`)
      .set(adminAuth)
      .send({});
    let afterSecond: any[] = [];
    for (let i = 0; i < 40; i += 1) {
      afterSecond = await snapshot();
      if (afterSecond.filter((s: any) => s.state === 'pending').length === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    expect(afterSecond.filter((s: any) => s.state === 'pending')).toHaveLength(1);
    expect(await activeCount()).toBe(2);

    // 待接入的会话不能提前回复
    const stillPending = (await snapshot()).find((s: any) => s.state === 'pending');
    const early = await request(http)
      .post(`/api/receptions/${attemptId}/sessions/${stillPending.sessionId}/messages`)
      .set(adminAuth)
      .send({ content: '还没接入就回复' });
    expect(early.body.code).toBe(ERR.SESSION_STATE);
    expect(early.body.message).toContain('待接入');

    // 结束整局：5 个会话全部进入终态（累计接待 5 个）。
    // 注意这时候接待已经结束，snapshot 会返回 2002，所以从结束接口的返回里取会话列表。
    const finishAllRes = await request(http).post(`/api/receptions/${attemptId}/finish`).set(adminAuth).send({});
    expect(finishAllRes.body.code).toBe(0);
    const finalSessions = finishAllRes.body.data.sessions;
    expect(finalSessions).toHaveLength(5);
    expect(finalSessions.every((s: any) => ['finished', 'transferred', 'aborted'].includes(s.state))).toBe(true);
  }, 60000);

  it('方案 4.4：难度逐步解锁——客服不能跳过未解锁的档位开局', async () => {
    const leaderToken = await login('leader', 'Leader@123');
    const leaderAuth = { Authorization: `Bearer ${leaderToken}` };
    const accounts = await request(http).get('/api/accounts').set(leaderAuth);
    // 用另一个客服账号（agent2）验证，避免前面的用例已经把它解锁过了
    const agent2Id = accounts.body.data.list.find((row: any) => row.username === 'agent2').id;
    const task = await request(http)
      .post('/api/tasks')
      .set(leaderAuth)
      .send({
        name: '难度解锁门禁用例',
        levels: ['L1', 'L3'],
        deadline: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(),
        targetCount: 1,
        targets: [{ metric: 'total_score', operator: 'gte', threshold: 0 }],
        assignees: [agent2Id],
      });
    expect(task.body.code).toBe(0);

    const a2 = { Authorization: `Bearer ${await login('agent2', 'Agent@123')}` };
    const levels = await request(http).get('/api/receptions/levels').set(a2);
    expect(levels.body.data.find((l: any) => l.code === 'L1').unlocked).toBe(true);
    expect(levels.body.data.find((l: any) => l.code === 'L3').unlocked).toBe(false);

    // 任务允许 L3，但客服还没解锁 L3 → 开局必须被拦（用户反馈的「没达标也能选高档位」）
    const denied = await request(http)
      .post('/api/receptions')
      .set(a2)
      .send({ level: 'L3', source: 'task', taskId: task.body.data.id });
    expect(denied.body.code).toBe(ERR.FORBIDDEN);
    expect(denied.body.message).toContain('还没解锁');

    // 带教开放 L3 之后可以正常开局
    const granted = await request(http)
      .post(`/api/accounts/${agent2Id}/unlock-levels`)
      .set(leaderAuth)
      .send({ levels: ['L3'] });
    expect(granted.body.code).toBe(0);
    const started = await request(http)
      .post('/api/receptions')
      .set(a2)
      .send({ level: 'L3', source: 'task', taskId: task.body.data.id });
    expect(started.body.code).toBe(0);
    await request(http)
      .post(`/api/receptions/${started.body.data.attemptId}/finish`)
      .set(a2)
      .send({});
  }, 60000);

  it('C5：管理员开局时可当场指定本局人数（只影响这一局，不动全局参数）', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const adminAuth = { Authorization: `Bearer ${adminToken}` };
    await finishRunningAttempt(adminToken);

    // 越界校验
    const badConcurrent = await request(http)
      .post('/api/receptions')
      .set(adminAuth)
      .send({ level: 'L2', source: 'free', concurrentCount: 9 });
    expect(badConcurrent.body.code).toBe(ERR.PARAM);
    expect(badConcurrent.body.message).toContain('1～4');
    const badTotal = await request(http)
      .post('/api/receptions')
      .set(adminAuth)
      .send({ level: 'L2', source: 'free', totalCount: 99 });
    expect(badTotal.body.code).toBe(ERR.PARAM);
    expect(badTotal.body.message).toContain('1～20');

    // 全局参数保持默认（L2 接入 2、总量未配置）；本局改成「接入 1 / 合计 3」
    await request(http)
      .put('/api/settings')
      .set(adminAuth)
      .send({ maxConcurrent: 4, levelConcurrent: { L2: 2 }, levelTotal: {} });
    const started = await request(http)
      .post('/api/receptions')
      .set(adminAuth)
      .send({ level: 'L2', source: 'free', concurrentCount: 1, totalCount: 3 });
    expect(started.body.code).toBe(0);
    const attemptId = started.body.data.attemptId;
    const sessions = started.body.data.sessions;
    expect(sessions).toHaveLength(3);
    expect(sessions.filter((s: any) => s.state === 'wait')).toHaveLength(1);
    expect(sessions.filter((s: any) => s.state === 'pending')).toHaveLength(2);

    // 结束接入中的那个 → 补位用的仍应是「本局覆盖」的同时在线 1
    // （能补位说明覆盖确实写进了这次接待的参数快照，而不是只临时算了一下）
    const active = sessions.find((s: any) => s.state === 'wait');
    await request(http)
      .post(`/api/receptions/${attemptId}/sessions/${active.sessionId}/finish`)
      .set(adminAuth)
      .send({});
    let snapshot: any[] = [];
    for (let i = 0; i < 40; i += 1) {
      const res = await request(http).get(`/api/receptions/${attemptId}/snapshot`).set(adminAuth);
      snapshot = res.body.data?.sessions || [];
      if (snapshot.filter((s: any) => s.state === 'pending').length === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    expect(snapshot.filter((s: any) => s.state === 'pending')).toHaveLength(1);
    expect(
      snapshot.filter((s: any) => !['finished', 'transferred', 'aborted', 'pending'].includes(s.state))
    ).toHaveLength(1);

    await request(http).post(`/api/receptions/${attemptId}/finish`).set(adminAuth).send({});

    // 全局参数没有被这次覆盖改动
    const settings = await request(http).get('/api/settings').set(adminAuth);
    expect(settings.body.data.levelConcurrent.L2).toBe(2);
    // 本局覆盖只影响这一局：全局的合计接待人数仍是默认 10
    expect(settings.body.data.levelTotal.L2).toBe(10);

    // 客服（新人）不能自己指定：用一条下发给他的任务训练来验证（绕开「客服不开放自由练习」那条校验）
    const leaderToken = await login('leader', 'Leader@123');
    const leaderAuth = { Authorization: `Bearer ${leaderToken}` };
    const accounts = await request(http).get('/api/accounts').set(leaderAuth);
    const agentId = accounts.body.data.list.find((row: any) => row.username === 'agent').id;
    const task = await request(http)
      .post('/api/tasks')
      .set(leaderAuth)
      .send({
        name: '本局人数覆盖权限用例',
        levels: ['L1'],
        deadline: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(),
        targetCount: 1,
        targets: [{ metric: 'total_score', operator: 'gte', threshold: 0 }],
        assignees: [agentId],
      });
    expect(task.body.code).toBe(0);

    const agentToken = await login('agent', 'Agent@123');
    const agentAuth = { Authorization: `Bearer ${agentToken}` };
    await finishRunningAttempt(agentToken);
    const denied = await request(http)
      .post('/api/receptions')
      .set(agentAuth)
      .send({ level: 'L1', source: 'task', taskId: task.body.data.id, totalCount: 3 });
    expect(denied.body.code).toBe(ERR.FORBIDDEN);
    expect(denied.body.message).toContain('管理员');
  }, 60000);

  it('C6：重复回复被判无效（不计响应时长、明细可筛选）', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const adminAuth = { Authorization: `Bearer ${adminToken}` };
    await finishRunningAttempt(adminToken);

    // 越界校验：连续次数 2～10
    const bad = await request(http)
      .put('/api/settings')
      .set(adminAuth)
      .send({ invalidReplyDuplicateStreak: 11 });
    expect(bad.body.code).toBe(ERR.PARAM);
    expect(bad.body.message).toContain('2～10');

    // 开启判定：与上一条完全相同即判无效
    const saved = await request(http)
      .put('/api/settings')
      .set(adminAuth)
      .send({
        invalidReplyEnabled: true,
        invalidReplyDuplicateMode: 'identical',
        invalidReplyDuplicateStreak: 3,
        banalWords: ['随便看看'],
        levelTotal: { L1: 1 },
      });
    expect(saved.body.code).toBe(0);
    expect(saved.body.data.invalidReplyEnabled).toBe(true);

    const started = await startFree(adminToken, 'L1');
    expect(started.body.code).toBe(0);
    const attemptId = started.body.data.attemptId;
    const sessionId = started.body.data.sessions[0].sessionId;
    await new Promise((resolve) => setTimeout(resolve, 2500));

    const snapshot = await request(http).get(`/api/receptions/${attemptId}/snapshot`).set(adminAuth);
    const session = snapshot.body.data.sessions[0];
    const question = session.questions.find((q: any) => q.seq === session.seq) || session.questions[0];
    const content = `亲，您好，${(question.keyPoints || []).join('，')}，还有其他可以帮您的吗？`;

    const first = await request(http)
      .post(`/api/receptions/${attemptId}/sessions/${sessionId}/messages`)
      .set(adminAuth)
      .send({ content });
    expect(first.body.code).toBe(0);
    expect(first.body.data.responseSec).not.toBeNull();
    expect(first.body.data.ruleResult.invalid).toBeUndefined();

    // 同一轮再发一条一模一样的话 → 判无效：不计时长，并给出依据
    const second = await request(http)
      .post(`/api/receptions/${attemptId}/sessions/${sessionId}/messages`)
      .set(adminAuth)
      .send({ content });
    expect(second.body.code).toBe(0);
    expect(second.body.data.responseSec).toBeNull();
    expect(second.body.data.ruleResult.invalid).toBe(true);
    expect(second.body.data.ruleResult.invalidReason).toContain('完全相同');

    await request(http).post(`/api/receptions/${attemptId}/finish`).set(adminAuth).send({});

    // 明细列表：默认能看到无效条数，按「判定标签=含无效回复」能筛出这一局
    const list = await request(http).get('/api/records?pageSize=50').set(adminAuth);
    const row = list.body.data.list.find((item: any) => item.id === attemptId);
    expect(row.invalidCount).toBeGreaterThanOrEqual(1);
    const filtered = await request(http).get('/api/records?invalid=1&pageSize=50').set(adminAuth);
    expect(filtered.body.data.list.some((item: any) => item.id === attemptId)).toBe(true);

    // 关闭开关，避免影响后续用例
    await request(http).put('/api/settings').set(adminAuth).send({ invalidReplyEnabled: false, banalWords: [] });
  }, 60000);

  it('C6：判定规则跟随开局快照，中途改参数不影响进行中的这一局', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const adminAuth = { Authorization: `Bearer ${adminToken}` };
    await finishRunningAttempt(adminToken);

    // 开局时判定是关的
    await request(http)
      .put('/api/settings')
      .set(adminAuth)
      .send({ invalidReplyEnabled: false, maxConcurrent: 4, levelConcurrent: { L1: 1 }, levelTotal: {} });
    const started = await startFree(adminToken, 'L1');
    expect(started.body.code).toBe(0);
    const attemptId = started.body.data.attemptId;
    const sessionId = started.body.data.sessions[0].sessionId;
    await new Promise((resolve) => setTimeout(resolve, 2500));

    // 接待进行中才把判定打开（客户要求：改完参数只对新接待生效）
    await request(http)
      .put('/api/settings')
      .set(adminAuth)
      .send({ invalidReplyEnabled: true, invalidReplyDuplicateMode: 'identical' });

    const snapshot = await request(http).get(`/api/receptions/${attemptId}/snapshot`).set(adminAuth);
    const session = snapshot.body.data.sessions[0];
    const question = session.questions.find((q: any) => q.seq === session.seq) || session.questions[0];
    const content = `亲，您好，${(question.keyPoints || []).join('，')}，还有其他可以帮您的吗？`;
    const send = (text: string) =>
      request(http)
        .post(`/api/receptions/${attemptId}/sessions/${sessionId}/messages`)
        .set(adminAuth)
        .send({ content: text });

    expect((await send(content)).body.code).toBe(0);
    const second = await send(content);
    expect(second.body.code).toBe(0);
    // 这一局的快照里判定是关的 → 即使现在全局开关是开的，同轮重复也不该被判无效
    expect(second.body.data.ruleResult.invalid).toBeUndefined();

    await request(http).post(`/api/receptions/${attemptId}/finish`).set(adminAuth).send({});
    // 收尾：关掉开关
    await request(http)
      .put('/api/settings')
      .set(adminAuth)
      .send({ invalidReplyEnabled: false });
  }, 60000);

  it('达标 1 次即解锁下一档（客户确认口径）', async () => {
    const agentToken = await login('agent', 'Agent@123');
    const agentAuth = { Authorization: `Bearer ${agentToken}` };
    const leaderToken = await login('leader', 'Leader@123');
    const leaderAuth = { Authorization: `Bearer ${leaderToken}` };
    const adminToken = await login('admin', 'Admin@123');
    const adminAuth = { Authorization: `Bearer ${adminToken}` };

    const before = await request(http).get('/api/receptions/levels').set(agentAuth);
    expect(before.body.data[0].requiredStreak).toBe(1);
    const streakBefore = before.body.data.find((row: any) => row.code === 'L1').streak;

    // 把达标线压到 0：这条用例验的是「达标 1 次就解锁」的机制，不是具体分数口径
    await request(http).put('/api/settings').set(adminAuth).send({ passLine: 0 });

    // 带教下发一个 L1 任务，客服做完并达标
    const accounts = await request(http).get('/api/accounts').set(leaderAuth);
    const agentId = accounts.body.data.list.find((row: any) => row.username === 'agent').id;
    const task = await request(http)
      .post('/api/tasks')
      .set(leaderAuth)
      .send({
        name: '解锁用例任务',
        levels: ['L1'],
        deadline: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(),
        targetCount: 1,
        targets: [{ metric: 'total_score', operator: 'gte', threshold: 0 }],
        assignees: [agentId],
      });

    const started = await request(http)
      .post('/api/receptions')
      .set(agentAuth)
      .send({ level: 'L1', source: 'task', taskId: task.body.data.id });
    expect(started.body.code).toBe(0);
    const attemptId = started.body.data.attemptId;
    const sessionId = started.body.data.sessions[0].sessionId;
    await new Promise((resolve) => setTimeout(resolve, 2500));

    // 按要点回复，尽量拿高分（阈值 0 的任务必定达标）
    const snapshot = await request(http).get(`/api/receptions/${attemptId}/snapshot`).set(agentAuth);
    const session = snapshot.body.data.sessions[0];
    const question = session.questions.find((q: any) => q.seq === session.seq) || session.questions[0];
    await request(http)
      .post(`/api/receptions/${attemptId}/sessions/${sessionId}/messages`)
      .set(agentAuth)
      .send({ content: `亲，您好，${(question.keyPoints || []).join('，')}，还有其他可以帮您的吗？` });
    const finished = await request(http).post(`/api/receptions/${attemptId}/finish`).set(agentAuth).send({});
    expect(finished.body.code).toBe(0);
    expect(finished.body.data.conclusion).toBe('pass');

    const after = await request(http).get('/api/receptions/levels').set(agentAuth);
    expect(after.body.data.find((row: any) => row.code === 'L2').unlocked).toBe(true);
    expect(after.body.data.find((row: any) => row.code === 'L1').streak).toBe(streakBefore + 1);
  }, 60000);

  /**
   * 客户 2026-10-03：订单卡片上的平台侧操作（催付 / 改价 / 去发货…）点击后要
   * 「记为一次业务动作」——落一条动作记录 + 给买家发一句标准话术，且复盘里能对上。
   */
  /**
   * 客户 2026-10-03：一次接待的问题要按比例混合售前 / 售后——
   * 大部分是「还没有订单、只咨询商品信息」的售前问题，小部分是「买完商品后」的订单类问题
   * （改地址 / 改快递 / 催发货）。比例由系统参数 aftersaleQuestionRatio 控制（默认 20）。
   */
  /**
   * 客户 2026-10-03：下发培训任务时按**商品种类**（男装 / 女装 …）圈定内容，
   * 推送的问题就围绕这些品类的商品；不允许出现「问题与实际商品不一致」。
   */
  it('C15：任务按商品种类限定，抽到的剧本都挂该品类商品；没有该品类的剧本时给明确提示', async () => {
    const leaderToken = await login('leader', 'Leader@123');
    const leaderAuth = { Authorization: `Bearer ${leaderToken}` };
    const agentToken = await login('agent', 'Agent@123');
    const agentAuth = { Authorization: `Bearer ${agentToken}` };
    const accounts = await request(http).get('/api/accounts').set(leaderAuth);
    const agentId = accounts.body.data.list.find((row: any) => row.username === 'agent')?.id;
    expect(agentId).toBeTruthy();

    // 商品 id → 分类，用来校验抽到的剧本确实挂在这一品类上
    const products = await request(http).get('/api/products?pageSize=200').set(leaderAuth);
    const categoryOf = new Map<number, string>(
      products.body.data.list.map((row: any) => [Number(row.id), String(row.category || '')])
    );

    const createTask = async (name: string, categories: string[]) =>
      request(http)
        .post('/api/tasks')
        .set(leaderAuth)
        .send({
          name,
          levels: ['L1'],
          targetCount: 1,
          startAt: new Date().toISOString(),
          deadline: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
          assignees: [agentId],
          scopeType: 'product_category',
          scopeValue: { categories },
          targets: [{ metric: 'total_score', operator: 'gte', threshold: 0 }],
        });

    // 1）按「女装」圈定：抽到的每个会话，其商品分类都必须是女装
    const apparelTask = await createTask('C15 女装专项', ['女装']);
    expect(apparelTask.body.code).toBe(0);
    const started = await request(http)
      .post('/api/receptions')
      .set(agentAuth)
      .send({ level: 'L1', source: 'task', taskId: apparelTask.body.data.id });
    expect(started.body.code).toBe(0);
    const categories = started.body.data.sessions.map((s: any) =>
      String(categoryOf.get(Number(s.product?.id)) || '')
    );
    expect(categories.length).toBeGreaterThan(0);
    expect(categories.every((name: string) => name === '女装')).toBe(true);
    // 顺带校验：问题里不会出现与女装无关的品类专属词（例如鞋码）
    const questions = started.body.data.sessions.flatMap((s: any) => s.questions.map((q: any) => q.question)).join(' ');
    expect(questions).not.toMatch(/鞋码|鞋垫|磨脚|保质期|口味|保修|续航/);
    await request(http).post(`/api/receptions/${started.body.data.attemptId}/finish`).set(agentAuth).send({});

    // 2）按「数码」圈定：能抽到数码商品（剧本库已覆盖 13 个品类）
    const digitalTask = await createTask('C15 数码专项', ['数码']);
    expect(digitalTask.body.code).toBe(0);
    const digitalStarted = await request(http)
      .post('/api/receptions')
      .set(agentAuth)
      .send({ level: 'L1', source: 'task', taskId: digitalTask.body.data.id });
    expect(digitalStarted.body.code).toBe(0);
    const digitalCategories = digitalStarted.body.data.sessions.map((s: any) =>
      String(categoryOf.get(Number(s.product?.id)) || '')
    );
    expect(digitalCategories.every((name: string) => name === '数码')).toBe(true);
    await request(http).post(`/api/receptions/${digitalStarted.body.data.attemptId}/finish`).set(agentAuth).send({});

    // 3）圈到一个没有任何剧本的品类：要给明确提示，而不是随便抽一个别的品类
    const emptyTask = await createTask('C15 空品类', ['不存在的品类']);
    expect(emptyTask.body.code).toBe(0);
    const failed = await request(http)
      .post('/api/receptions')
      .set(agentAuth)
      .send({ level: 'L1', source: 'task', taskId: emptyTask.body.data.id });
    expect(failed.body.code).toBe(ERR.PARAM);
    expect(failed.body.message).toContain('商品种类');
  }, 60000);

  /**
   * 客户 2026-10-03：下发回复模拟任务时，**剧本和商品都要能多选**——
   * 两个条件同时生效：只抽「所选剧本里、关联了所选商品」的剧本。
   */
  it('C16：下发任务时「剧本 + 商品」可同时多选，两个条件同时生效', async () => {
    const leaderToken = await login('leader', 'Leader@123');
    const leaderAuth = { Authorization: `Bearer ${leaderToken}` };
    const agentToken = await login('agent', 'Agent@123');
    const agentAuth = { Authorization: `Bearer ${agentToken}` };
    const accounts = await request(http).get('/api/accounts').set(leaderAuth);
    const agentId = accounts.body.data.list.find((row: any) => row.username === 'agent')?.id;

    // 找两个「关联商品不同」的剧本，用来验证两个条件都得命中
    const scriptsRes = await request(http).get('/api/scripts?pageSize=200').set(leaderAuth);
    const list = scriptsRes.body.data.list as any[];
    const first = list.find((row) => (row.productIds || []).length === 1);
    const firstProduct = Number(first.productIds[0]);
    const other = list.find((row) => !(row.productIds || []).map(Number).includes(firstProduct));
    const otherProduct = Number(other.productIds[0]);
    expect(firstProduct).toBeTruthy();
    expect(otherProduct).toBeTruthy();
    expect(otherProduct).not.toBe(firstProduct);

    const createTask = async (name: string, scriptIds: number[], productIds: number[]) =>
      request(http)
        .post('/api/tasks')
        .set(leaderAuth)
        .send({
          name,
          levels: ['L1'],
          targetCount: 1,
          startAt: new Date().toISOString(),
          deadline: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
          assignees: [agentId],
          scopeType: 'scripts_products',
          scopeValue: { scriptIds, productIds },
          targets: [{ metric: 'total_score', operator: 'gte', threshold: 0 }],
        });

    // 1）剧本 + 它自己关联的商品：能开局，且抽到的商品就是所选那个
    const okTask = await createTask('C16 剧本+商品（匹配）', [first.id], [firstProduct]);
    expect(okTask.body.code).toBe(0);
    const started = await request(http)
      .post('/api/receptions')
      .set(agentAuth)
      .send({ level: 'L1', source: 'task', taskId: okTask.body.data.id });
    expect(started.body.code).toBe(0);
    const productIds = started.body.data.sessions.map((s: any) => Number(s.product?.id));
    expect(productIds.length).toBeGreaterThan(0);
    expect(productIds.every((id: number) => id === firstProduct)).toBe(true);
    await request(http).post(`/api/receptions/${started.body.data.attemptId}/finish`).set(agentAuth).send({});

    // 2）剧本 + 别的商品：两个条件不可能同时满足 → 明确提示，而不是随便抽
    const badTask = await createTask('C16 剧本+商品（不匹配）', [first.id], [otherProduct]);
    expect(badTask.body.code).toBe(0);
    const failed = await request(http)
      .post('/api/receptions')
      .set(agentAuth)
      .send({ level: 'L1', source: 'task', taskId: badTask.body.data.id });
    expect(failed.body.code).toBe(ERR.PARAM);
    expect(failed.body.message).toContain('剧本 + 商品');
  }, 60000);

  it('C14：售前 / 售后问题按比例混合，比例可配（默认两成售后）', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const adminAuth = { Authorization: `Bearer ${adminToken}` };
    await finishRunningAttempt(adminToken);

    // 越界被拦
    const bad = await request(http).put('/api/settings').set(adminAuth).send({ aftersaleQuestionRatio: 90 });
    expect(bad.body.code).toBe(ERR.PARAM);
    expect(bad.body.message).toContain('0～80');

    const sessionsOf = async (ratio: number) => {
      await request(http).put('/api/settings').set(adminAuth).send({ aftersaleQuestionRatio: ratio, levelTotal: { L1: 1 } });
      const started = await startFree(adminToken, 'L1');
      expect(started.body.code).toBe(0);
      const sessions = started.body.data.sessions as any[];
      await request(http).post(`/api/receptions/${started.body.data.attemptId}/finish`).set(adminAuth).send({});
      return sessions[0].questions as any[];
    };

    // 比例 = 0：整场都是剧本本身的话题，一个问题都不换
    const none = await sessionsOf(0);
    expect(none.every((q) => q.stage === 'presale' || q.stage === 'aftersale')).toBe(true);
    expect(none.filter((q) => q.stage !== none[0].stage)).toHaveLength(0);

    // 比例 = 50：换掉一半（不超过一半），且换进来的是「买完商品后」的订单类问题
    const half = await sessionsOf(50);
    const other = half.filter((q) => q.stage !== half[0].stage);
    expect(other.length).toBe(Math.floor(half.length / 2));
    expect(other.every((q) => /地址|快递|催|订单|电话|备注/.test(q.question))).toBe(true);
    // 订单状态跟着问题走：还没发货的订单类问题给「待发货」
    expect(other.every((q) => q.orderStage === 'unshipped' || q.orderStage === 'shipped')).toBe(true);
    // 开场仍是剧本自己的话题
    expect(half[0].question).not.toMatch(/改地址|催发货/);

    // 默认值是 20%
    await request(http).put('/api/settings').set(adminAuth).send({ aftersaleQuestionRatio: 20, levelTotal: {} });
  }, 60000);

  it('C8：订单卡片的平台侧操作点击后记为一次业务动作', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const adminAuth = { Authorization: `Bearer ${adminToken}` };
    await finishRunningAttempt(adminToken);
    // 压到 1 人，断言只盯第一个会话
    await request(http)
      .put('/api/settings')
      .set(adminAuth)
      .send({ levelConcurrent: { L1: 1 }, levelTotal: { L1: 1 } });

    const started = await startFree(adminToken, 'L1');
    expect(started.body.code).toBe(0);
    const attemptId = started.body.data.attemptId;
    const sessionId = started.body.data.sessions[0].sessionId;

    const snapshot = await request(http).get(`/api/receptions/${attemptId}/snapshot`).set(adminAuth);
    const session = snapshot.body.data.sessions[0];
    const stage = session.order.stage;
    // 按当前订单状态挑一个合法动作与一个不合法动作（用例不依赖随机抽到哪条剧本）
    const legal =
      stage === 'unpaid'
        ? { code: 'urge_pay', name: '催付', phrase: '您的订单还没有付款' }
        : stage === 'unshipped'
          ? { code: 'ship_goods', name: '去发货', phrase: '安排进发货流程' }
          : { code: 'logistics_card', name: '发物流卡', phrase: '配送' };
    const illegal = stage === 'unpaid' ? { code: 'ship_goods', name: '去发货' } : { code: 'urge_pay', name: '催付' };

    // 不支持的编码直接拒绝
    const unknown = await request(http)
      .post(`/api/receptions/${attemptId}/sessions/${sessionId}/actions`)
      .set(adminAuth)
      .send({ action: 'not-an-action' });
    expect(unknown.body.code).toBe(ERR.PARAM);

    // 状态不符的动作被拒（例如待支付的订单不能点「去发货」）
    const wrongStage = await request(http)
      .post(`/api/receptions/${attemptId}/sessions/${sessionId}/actions`)
      .set(adminAuth)
      .send({ action: illegal.code });
    expect(wrongStage.body.code).toBe(ERR.PARAM);
    expect(wrongStage.body.message).toContain(illegal.name);

    // 合法动作：记一次业务动作 + 发标准话术
    const done = await request(http)
      .post(`/api/receptions/${attemptId}/sessions/${sessionId}/actions`)
      .set(adminAuth)
      .send({ action: legal.code });
    expect(done.body.code).toBe(0);
    expect(done.body.data.action.name).toBe(legal.name);
    expect(done.body.data.action.content).toContain(legal.phrase);
    // 动作消息在时间线里留痕（前端据此显示「业务动作 · 催付」）
    expect(done.body.data.ruleResult.businessAction).toEqual({ code: legal.code, name: legal.name });
    // 业务动作话术不算敷衍：即便与上一条完全相同也不会被判无效
    const again = await request(http)
      .post(`/api/receptions/${attemptId}/sessions/${sessionId}/actions`)
      .set(adminAuth)
      .send({ action: legal.code });
    expect(again.body.code).toBe(0);
    expect(again.body.data.ruleResult.invalid).toBeUndefined();

    // 话术真的进了对话（详情快照里能查到）
    const after = await request(http).get(`/api/receptions/${attemptId}/snapshot`).set(adminAuth);
    expect(JSON.stringify(after.body.data)).toContain(done.body.data.action.content);

    await request(http).post(`/api/receptions/${attemptId}/finish`).set(adminAuth).send({});
    // 复盘：这次接待点过两次催付（/去发货…）
    const detail = await request(http).get(`/api/records/${attemptId}`).set(adminAuth);
    expect(detail.body.code).toBe(0);
    expect(detail.body.data.businessActions).toHaveLength(2);
    expect(detail.body.data.businessActions[0].actionName).toBe(legal.name);
    expect(detail.body.data.businessActions[0].sessionId).toBe(sessionId);

    // 还原设置，避免影响后续用例
    await request(http).put('/api/settings').set(adminAuth).send({ levelTotal: {} });
  }, 60000);
});
