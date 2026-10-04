import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { DbService } from '../../src/db/db.service';
import { AllExceptionsFilter } from '../../src/common/all-exceptions.filter';
import { ResponseInterceptor } from '../../src/common/response.interceptor';
import { ERR } from '../../src/common/errors';
import { createTestDb } from '../util/test-db';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 案例收藏的标签、检索与明细转案例（方案 F5-05 / F5-08 / F5-09）。 */
describe('案例收藏：标签 / 检索 / 明细转案例', () => {
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

  it('导入时可以打标签，列表能按标签 / 关键词 / 店铺 / 阶段检索', async () => {
    const token = await login('admin', 'Admin@123');
    const auth = { Authorization: `Bearer ${token}` };

    const created = await request(http)
      .post('/api/cases/import/text')
      .set(auth)
      .send({
        title: '物流三天未更新',
        text: '买家:快递三天没有更新了！\n客服:亲，我马上帮您核实物流进度～',
        shop: '官方旗舰店',
        stage: 'aftersale',
        tags: ['物流', '情绪-高'],
      });
    expect(created.body.code).toBe(0);
    const caseId = created.body.data.id;

    const all = await request(http).get('/api/cases').set(auth);
    expect(all.body.code).toBe(0);
    expect(all.body.data.tags).toEqual(expect.arrayContaining(['物流', '情绪-高']));
    expect(all.body.data.list.find((row: any) => row.id === caseId).tags).toEqual(['物流', '情绪-高']);

    const byTag = await request(http).get('/api/cases?tag=情绪-高').set(auth);
    expect(byTag.body.data.list.map((row: any) => row.id)).toEqual([caseId]);

    const byKeyword = await request(http).get('/api/cases?keyword=物流三天').set(auth);
    expect(byKeyword.body.data.list.map((row: any) => row.id)).toEqual([caseId]);

    const byShop = await request(http).get('/api/cases?shop=旗舰店').set(auth);
    expect(byShop.body.data.list.map((row: any) => row.id)).toEqual([caseId]);

    const wrongStage = await request(http).get('/api/cases?stage=presale').set(auth);
    expect(wrongStage.body.data.list.some((row: any) => row.id === caseId)).toBe(false);

    const noHit = await request(http).get('/api/cases?keyword=不存在的关键词').set(auth);
    expect(noHit.body.data.total).toBe(0);
  });

  it('可以修改案例的标题与标签', async () => {
    const token = await login('leader', 'Leader@123');
    const auth = { Authorization: `Bearer ${token}` };
    const created = await request(http)
      .post('/api/cases/import/text')
      .set(auth)
      .send({ title: '待打标签案例', text: '买家:什么时候发货\n客服:亲，今天就会发出～', tags: [] });
    const caseId = created.body.data.id;

    const updated = await request(http).put(`/api/cases/${caseId}`).set(auth).send({ tags: ['发货', '情绪-低'] });
    expect(updated.body.code).toBe(0);

    const after = await request(http).get(`/api/cases/${caseId}`).set(auth);
    expect(after.body.data.tags).toEqual(['发货', '情绪-低']);

    const byTag = await request(http).get('/api/cases?tag=发货').set(auth);
    expect(byTag.body.data.list.map((row: any) => row.id)).toEqual([caseId]);
  });

  it('训练明细可以转为案例，同一次接待不会重复转', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const adminAuth = { Authorization: `Bearer ${adminToken}` };

    const started = await request(http).post('/api/receptions').set(adminAuth).send({ level: 'L1', source: 'free' });
    expect(started.body.code).toBe(0);
    const attemptId = started.body.data.attemptId;
    const sessionId = started.body.data.sessions[0].sessionId;

    await sleep(2500);
    const replied = await request(http)
      .post(`/api/receptions/${attemptId}/sessions/${sessionId}/messages`)
      .set(adminAuth)
      .send({ content: '亲，您好，我马上帮您确认一下，稍等一分钟～' });
    expect(replied.body.code).toBe(0);
    const finished = await request(http).post(`/api/receptions/${attemptId}/finish`).set(adminAuth).send({});
    expect(finished.body.code).toBe(0);

    const converted = await request(http).post('/api/cases/from-attempt').set(adminAuth).send({ attemptId });
    expect(converted.body.code).toBe(0);
    expect(converted.body.data.messageCount).toBeGreaterThan(0);

    const detail = await request(http).get(`/api/cases/${converted.body.data.caseId}`).set(adminAuth);
    expect(detail.body.code).toBe(0);
    expect(detail.body.data.sourceType).toBe('attempt');
    expect(detail.body.data.tags).toEqual(expect.arrayContaining(['训练明细', 'L1']));
    expect(detail.body.data.messages.length).toBe(converted.body.data.messageCount);
    expect(detail.body.data.messages.some((m: any) => m.sender === 'buyer')).toBe(true);
    expect(detail.body.data.messages.some((m: any) => m.sender === 'agent')).toBe(true);

    const duplicated = await request(http).post('/api/cases/from-attempt').set(adminAuth).send({ attemptId });
    expect(duplicated.body.code).toBe(ERR.PARAM);

    const running = await request(http).post('/api/receptions').set(adminAuth).send({ level: 'L1', source: 'free' });
    const runningAttempt = running.body.data.attemptId;
    const tooEarly = await request(http).post('/api/cases/from-attempt').set(adminAuth).send({ attemptId: runningAttempt });
    expect(tooEarly.body.code).toBe(ERR.PARAM);
    // 这一局是管理员开的，收尾也要用管理员身份，否则会留下进行中的接待挡住后面的用例
    await request(http).post(`/api/receptions/${runningAttempt}/finish`).set(adminAuth).send({});
  });

  it('客服不能维护案例（权限矩阵）', async () => {
    const agentToken = await login('agent', 'Agent@123');
    const auth = { Authorization: `Bearer ${agentToken}` };
    const deniedImport = await request(http)
      .post('/api/cases/import/text')
      .set(auth)
      .send({ title: '越权导入', text: '买家:在吗\n客服:在的' });
    expect(deniedImport.body.code).toBe(ERR.FORBIDDEN);
    const deniedConvert = await request(http).post('/api/cases/from-attempt').set(auth).send({ attemptId: 1 });
    expect(deniedConvert.body.code).toBe(ERR.FORBIDDEN);
    const deniedUpdate = await request(http).put('/api/cases/1').set(auth).send({ tags: ['x'] });
    expect(deniedUpdate.body.code).toBe(ERR.FORBIDDEN);
  });

  it('文件导入：CSV 走适配器解析，能列出适配器并下载模板（方案 F5-01 / F5-03）', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const auth = { Authorization: `Bearer ${adminToken}` };

    const adapters = await request(http).get('/api/cases/adapters').set(auth);
    expect(adapters.body.code).toBe(0);
    expect(adapters.body.data.map((item: any) => item.code)).toContain('generic');

    const template = await request(http).get('/api/cases/import/template').set(auth).expect(200);
    expect(String(template.headers['content-type'])).toContain('text/csv');
    expect(String(template.text)).toContain('role,content');

    const csv = ['role,content', '买家,快递三天没有更新了！', '客服,亲，我马上帮您核实物流进度～', '乱写,没有角色'].join('\n');
    const imported = await request(http)
      .post('/api/cases/import/file')
      .set(auth)
      .send({ title: '文件导入案例', fileName: 'case.csv', text: csv, stage: 'aftersale', tags: ['物流'] });
    expect(imported.body.code).toBe(0);
    expect(imported.body.data.imported).toBe(2);
    expect(imported.body.data.adapter).toBe('generic');
    expect(imported.body.data.failed).toHaveLength(1);
    expect(imported.body.data.failed[0].line).toBe(4);

    const detail = await request(http).get(`/api/cases/${imported.body.data.id}`).set(auth);
    expect(detail.body.data.sourceType).toBe('file');
    expect(detail.body.data.messages.map((m: any) => m.sender)).toEqual(['buyer', 'agent']);
    expect(detail.body.data.tags).toEqual(['物流']);

    // 文件类型不对 / 内容为空要有明确报错，而不是 500
    const badFormat = await request(http)
      .post('/api/cases/import/file')
      .set(auth)
      .send({ title: '坏文件', fileName: 'case.xlsx', base64: '这不是 xlsx' });
    expect(badFormat.body.code).toBe(ERR.IMPORT_FORMAT);
  });

  it('可以直接把一次接待标记为典型案例（方案 F2-06）', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const adminAuth = { Authorization: `Bearer ${adminToken}` };

    const started = await request(http).post('/api/receptions').set(adminAuth).send({ level: 'L1', source: 'free' });
    const attemptId = started.body.data.attemptId;
    const sessionId = started.body.data.sessions[0].sessionId;
    await sleep(2500);
    await request(http)
      .post(`/api/receptions/${attemptId}/sessions/${sessionId}/messages`)
      .set(adminAuth)
      .send({ content: '亲，我帮您确认好了，这件衣服不起球也不会缩水～' });
    await request(http).post(`/api/receptions/${attemptId}/finish`).set(adminAuth).send({});

    const highlighted = await request(http)
      .post('/api/cases/from-attempt')
      .set(adminAuth)
      .send({ attemptId, highlight: true });
    expect(highlighted.body.code).toBe(0);

    const detail = await request(http).get(`/api/cases/${highlighted.body.data.caseId}`).set(adminAuth);
    expect(detail.body.data.tags).toContain('典型案例');

    // 能按「典型案例」标签筛出来，正是培训素材的用法
    const filtered = await request(http).get('/api/cases?tag=典型案例').set(adminAuth);
    expect(filtered.body.data.list.map((row: any) => row.id)).toContain(highlighted.body.data.caseId);
  });

  it('方案 F5-06 / F5-07：优秀回复会作为「买家接受方案」被提取进咨询内容', async () => {
    const leaderToken = await login('leader', 'Leader@123');
    const leaderAuth = { Authorization: `Bearer ${leaderToken}` };

    const imported = await request(http)
      .post('/api/cases/import/text')
      .set(leaderAuth)
      .send({
        title: '优秀回复提取用例',
        text: '买家:什么时候发货\n客服:亲，今天一定为您发出～\n客服:发出后我会把单号同步给您～',
      });
    expect(imported.body.code).toBe(0);
    const caseId = imported.body.data.id;

    // 先看没有标记时：接受方案退回全部客服话术
    const before = await request(http).post(`/api/cases/${caseId}/to-content`).set(leaderAuth).send({});
    expect(before.body.code).toBe(0);
    expect(before.body.data.excellentUsed).toBe(0);
    expect(before.body.data.acceptedAnswer).toContain('今天一定为您发出');
    expect(before.body.data.acceptedAnswer).not.toContain('请补充买家接受方案');

    // 标记其中一条为优秀回复 → 接受方案只取被标记的那条（方案 F5-07 的「参考答案话术」）
    const detail = await request(http).get(`/api/cases/${caseId}`).set(leaderAuth);
    const agentMessages = detail.body.data.messages.filter((m: any) => m.sender === 'agent');
    expect(agentMessages).toHaveLength(2);
    const marked = await request(http)
      .post(`/api/cases/messages/${agentMessages[1].id}/excellent`)
      .set(leaderAuth)
      .send({ isExcellent: true });
    expect(marked.body.code).toBe(0);

    const after = await request(http).post(`/api/cases/${caseId}/to-content`).set(leaderAuth).send({});
    expect(after.body.code).toBe(0);
    expect(after.body.data.excellentUsed).toBe(1);
    expect(after.body.data.acceptedAnswer).toContain('单号同步给您');
    expect(after.body.data.acceptedAnswer).not.toContain('今天一定为您发出');

    // 详情里能读回标记状态（前端据此显示「优秀回复」标签）
    const again = await request(http).get(`/api/cases/${caseId}`).set(leaderAuth);
    expect(again.body.data.messages.filter((m: any) => m.isExcellent)).toHaveLength(1);
  });
});
