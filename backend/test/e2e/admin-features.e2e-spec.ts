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

/**
 * 第三批二期收尾项：
 * F1-15 提示模式参数、F3-07 按案例创建剧本、F6-10 任务催办、F7-08 自定义风格、
 * F8-10 登录安全策略、F8-11 数据字典改名级联。
 */
describe('提示模式 / 按案例建剧本 / 催办 / 自定义风格 / 登录安全 / 数据字典', () => {
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

  async function login(username: string, password: string) {
    return request(http).post('/api/auth/login').send({ username, password });
  }

  async function token(username: string, password: string): Promise<string> {
    const res = await login(username, password);
    expect(res.body.code).toBe(0);
    return res.body.data.token;
  }

  it('提示模式参数默认关闭，开启后接待页可读取（方案 F1-15）', async () => {
    const adminToken = await token('admin', 'Admin@123');
    const auth = { Authorization: `Bearer ${adminToken}` };
    const before = await request(http).get('/api/settings').set(auth);
    expect(before.body.data.hintMode).toBe(false);
    expect(before.body.data.hintDelaySec).toBe(60);

    const updated = await request(http)
      .put('/api/settings')
      .set(auth)
      .send({ hintMode: true, hintDelaySec: 30 });
    expect(updated.body.code).toBe(0);

    const agentToken = await token('agent', 'Agent@123');
    const after = await request(http).get('/api/settings').set({ Authorization: `Bearer ${agentToken}` });
    expect(after.body.data.hintMode).toBe(true);
    expect(after.body.data.hintDelaySec).toBe(30);

    await request(http).put('/api/settings').set(auth).send({ hintMode: false, hintDelaySec: 60 });
  });

  it('按案例创建剧本：买家消息沉淀成咨询内容并生成剧本（方案 F3-07）', async () => {
    const leaderToken = await token('leader', 'Leader@123');
    const auth = { Authorization: `Bearer ${leaderToken}` };
    const created = await request(http)
      .post('/api/cases/import/text')
      .set(auth)
      .send({
        title: '案例转剧本用',
        text: '买家:这件衣服起球吗\n客服:亲，这款做过抗起球处理，正常穿着没问题的～\n买家:洗了会缩水吗',
        stage: 'presale',
      });
    const caseId = created.body.data.id;
    /**
     * 客户 2026-10-03 起有「商品与问题必须一致」的生成前校验：
     * 这条案例问的是「起球 / 缩水」（服饰类问题），所以必须配服饰类商品。
     * 商品列表默认按 id 倒序，第一条未必是服饰，这里显式挑一个女装商品。
     */
    const products = await request(http).get('/api/products?pageSize=300').set(auth);
    const productId = products.body.data.list.find((p: any) => p.category === '女装').id;

    const script = await request(http)
      .post('/api/scripts/from-case')
      .set(auth)
      .send({ caseId, productIds: [productId] });
    expect(script.body.code).toBe(0);
    expect(script.body.data.contentId).toBeGreaterThan(0);

    const detail = await request(http).get(`/api/scripts/${script.body.data.id}`).set(auth);
    expect(detail.body.code).toBe(0);
    // 案例的买家消息成为前两轮提问，之后由统一口径补足到 6～10 轮（方案 10.3）
    expect(detail.body.data.questionSeq.length).toBeGreaterThanOrEqual(2);
    expect(detail.body.data.questionSeq[0].question).toContain('起球');
    expect(detail.body.data.questionSeq[1].question).toContain('缩水');
    expect(detail.body.data.category).toBe('案例回流');
    expect(detail.body.data.productIds).toEqual([productId]);

    // 没有买家消息的案例不能生成剧本
    const onlyAgent = await request(http)
      .post('/api/cases/import/text')
      .set(auth)
      .send({ title: '只有客服发言', text: '客服:亲，您好～' });
    // 文本导入要求至少一行能识别角色，这里只有客服消息 → 案例存在但没有买家消息
    if (onlyAgent.body.code === 0) {
      const denied = await request(http)
        .post('/api/scripts/from-case')
        .set(auth)
        .send({ caseId: onlyAgent.body.data.id, productIds: [productId] });
      expect(denied.body.code).toBe(ERR.PARAM);
    }
  });

  it('任务催办：24 小时内到期且未完成的任务会进提醒列表（方案 F6-10）', async () => {
    const leaderToken = await token('leader', 'Leader@123');
    const leaderAuth = { Authorization: `Bearer ${leaderToken}` };
    const accounts = await request(http).get('/api/accounts').set(leaderAuth);
    const agentId = accounts.body.data.list.find((row: any) => row.username === 'agent').id;

    const soon = await request(http)
      .post('/api/tasks')
      .set(leaderAuth)
      .send({
        name: '马上截止的任务',
        levels: ['L1'],
        deadline: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
        targetCount: 2,
        targets: [{ metric: 'total_score', operator: 'gte', threshold: 70 }],
        assignees: [agentId],
      });
    expect(soon.body.code).toBe(0);

    const farAway = await request(http)
      .post('/api/tasks')
      .set(leaderAuth)
      .send({
        name: '还早的任务',
        levels: ['L1'],
        deadline: new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString(),
        targetCount: 2,
        targets: [{ metric: 'total_score', operator: 'gte', threshold: 70 }],
        assignees: [agentId],
      });
    expect(farAway.body.code).toBe(0);

    const agentToken = await token('agent', 'Agent@123');
    const reminders = await request(http).get('/api/tasks/reminders').set({ Authorization: `Bearer ${agentToken}` });
    expect(reminders.body.code).toBe(0);
    const names = reminders.body.data.items.map((item: any) => item.name);
    expect(names).toContain('马上截止的任务');
    expect(names).not.toContain('还早的任务');
    const item = reminders.body.data.items.find((row: any) => row.name === '马上截止的任务');
    expect(item.overdue).toBe(false);
    expect(item.hoursLeft).toBeLessThanOrEqual(24);
    expect(item.doneCount).toBe(0);
  });

  it('自定义风格模板：管理员可新增，非管理员被拒（方案 F7-08）', async () => {
    const adminToken = await token('admin', 'Admin@123');
    const created = await request(http)
      .post('/api/styles')
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({ code: 'humorous', name: '幽默风趣型', description: '喜欢开玩笑', toneSample: '哈哈哈这个包装好可爱～', emotionBase: 30 });
    expect(created.body.code).toBe(0);

    const list = await request(http).get('/api/styles').set({ Authorization: `Bearer ${adminToken}` });
    const custom = list.body.data.find((row: any) => row.code === 'humorous');
    expect(custom).toMatchObject({ name: '幽默风趣型', isBuiltin: false, emotionBase: 30 });

    const leaderToken = await token('leader', 'Leader@123');
    const denied = await request(http)
      .post('/api/styles')
      .set({ Authorization: `Bearer ${leaderToken}` })
      .send({ code: 'nope', name: '越权风格' });
    expect(denied.body.code).toBe(ERR.FORBIDDEN);
  });

  it('数据字典：改名会级联更新已引用它的素材（方案 F8-11）', async () => {
    const adminToken = await token('admin', 'Admin@123');
    const auth = { Authorization: `Bearer ${adminToken}` };

    const created = await request(http).post('/api/categories').set(auth).send({ type: 'product', name: '字典测试分类' });
    expect(created.body.code).toBe(0);
    const categoryId = created.body.data.id;

    const product = await request(http).post('/api/products').set(auth).send({
      productNo: `DICT${Date.now()}`,
      title: '字典级联测试商品',
      price: 12.5,
      category: '字典测试分类',
      scenes: ['字典标签A'],
    });
    expect(product.body.code).toBe(0);

    const renamed = await request(http)
      .put(`/api/categories/${categoryId}`)
      .set(auth)
      .send({ name: '字典测试分类-改名后' });
    expect(renamed.body.code).toBe(0);
    expect(renamed.body.data.renamed).toBeGreaterThan(0);

    const detail = await request(http).get(`/api/products/${product.body.data.id}`).set(auth);
    expect(detail.body.data.category).toBe('字典测试分类-改名后');

    // 同类型重名要被拦住
    const another = await request(http).post('/api/categories').set(auth).send({ type: 'product', name: '另一个分类' });
    const duplicated = await request(http)
      .put(`/api/categories/${another.body.data.id}`)
      .set(auth)
      .send({ name: '字典测试分类-改名后' });
    expect(duplicated.body.code).toBe(ERR.PARAM);

    const list = await request(http).get('/api/categories?type=product').set(auth);
    expect(list.body.code).toBe(0);
    expect(list.body.data.some((row: any) => row.name === '字典测试分类-改名后')).toBe(true);

    // 仍被商品引用 → 删除要被拦住（页面向用户承诺「删除前会检查是否还有引用」）
    const blockedDelete = await request(http).delete(`/api/categories/${categoryId}`).set(auth);
    expect(blockedDelete.body.code).toBe(ERR.MATERIAL_REFERENCED);
    // 把商品换到别的分类后再删就放行
    await request(http).put(`/api/products/${product.body.data.id}`).set(auth).send({ category: '女装' });
    const removed = await request(http).delete(`/api/categories/${categoryId}`).set(auth);
    expect(removed.body.code).toBe(0);
    await request(http).delete(`/api/categories/${another.body.data.id}`).set(auth);
  });

  it('登录安全策略：连续失败锁定、管理员重置后强制改密、密码有效期（方案 F8-10）', async () => {
    const adminToken = await token('admin', 'Admin@123');
    const auth = { Authorization: `Bearer ${adminToken}` };

    // 建一个专门用来测锁定的账号，避免影响其它用例
    const username = `lock_probe_${Date.now()}`;
    await request(http)
      .post('/api/accounts')
      .set(auth)
      .send({ username, password: 'Probe@123', displayName: '锁定探针', roleCode: 'agent' });

    for (let i = 1; i <= 5; i += 1) {
      const res = await login(username, 'Wrong@123');
      expect(res.body.code).toBe(i < 5 ? ERR.UNAUTHORIZED : ERR.FORBIDDEN);
    }
    // 锁定后即使密码正确也进不来
    const locked = await login(username, 'Probe@123');
    expect(locked.body.code).toBe(ERR.FORBIDDEN);
    expect(locked.body.message).toContain('锁定');

    // 管理员重置密码 → 解锁 + 强制首次改密
    const accounts = await request(http).get('/api/accounts').set(auth);
    const accountId = accounts.body.data.list.find((row: any) => row.username === username).id;
    const reset = await request(http)
      .post(`/api/accounts/${accountId}/reset-password`)
      .set(auth)
      .send({ password: 'Reset@123' });
    expect(reset.body.code).toBe(0);

    const afterReset = await login(username, 'Reset@123');
    expect(afterReset.body.code).toBe(0);
    expect(afterReset.body.data.mustChangePassword).toBe(true);
    expect(afterReset.body.data.notice).toContain('重置');

    const newToken = afterReset.body.data.token;
    const changed = await request(http)
      .post('/api/auth/change-password')
      .set({ Authorization: `Bearer ${newToken}` })
      .send({ oldPassword: 'Reset@123', newPassword: 'Fresh@123' });
    expect(changed.body.code).toBe(0);

    const afterChange = await login(username, 'Fresh@123');
    expect(afterChange.body.code).toBe(0);
    expect(afterChange.body.data.mustChangePassword).toBe(false);

    // 密码有效期：把改密时间往前挪，登录时应提示过期并要求改密
    await db.query(`UPDATE accounts SET password_changed_at = $2 WHERE id = $1`, [
      accountId,
      new Date(Date.now() - 200 * 24 * 3600 * 1000).toISOString(),
    ]);
    const expired = await login(username, 'Fresh@123');
    expect(expired.body.code).toBe(0);
    expect(expired.body.data.mustChangePassword).toBe(true);
    expect(expired.body.data.passwordExpired).toBe(true);
  });

  it('数据字典必须覆盖各类数据里实际在用的分类（方案 F8-11）', async () => {
    const adminToken = await token('admin', 'Admin@123');
    const adminAuth = { Authorization: `Bearer ${adminToken}` };
    // 表名 → 字典 type 的对应关系（商品场景标签是 scenes 数组，单独处理）
    const cases: [string, string, string][] = [
      ['buyer_bg', 'bg', 'category'],
      ['buyer_qa', 'qa', 'category'],
      ['scripts', 'script', 'category'],
      ['products', 'product', 'category'],
    ];
    for (const [table, type, column] of cases) {
      const rows = await db.many<{ name: string }>(
        `SELECT DISTINCT ${column} AS name FROM ${table} WHERE ${column} IS NOT NULL`
      );
      const used = rows.map((row) => String(row.name)).filter(Boolean);
      const dict = await request(http).get(`/api/categories?type=${type}`).set(adminAuth);
      if (!dict.body.data) throw new Error(`GET /api/categories?type=${type} 返回异常：${JSON.stringify(dict.body)}`);
      const names = dict.body.data.map((row: any) => row.name);
      const missing = used.filter((name) => !names.includes(name));
      // 字典漏掉实际在用的分类 → 按分类筛选/限定范围会选不到东西（剧本分类就踩过这个坑）
      expect({ table, missing }).toEqual({ table, missing: [] });
    }
  });

  it('商品场景标签：会把商品里在用的标签补登进字典，改名同步回商品（方案 F8-11）', async () => {
    const adminToken = await token('admin', 'Admin@123');
    const auth = { Authorization: `Bearer ${adminToken}` };

    await request(http)
      .post('/api/products')
      .set(auth)
      .send({ productNo: `SCENE${Date.now()}`, title: '场景标签测试商品', price: 20, scenes: ['字典测试标签'] });

    const list = await request(http).get('/api/categories?type=tag').set(auth);
    expect(list.body.code).toBe(0);
    const tag = list.body.data.find((row: any) => row.name === '字典测试标签');
    expect(tag).toBeTruthy();
    expect(tag.count).toBeGreaterThan(0);

    // 改名要同步回商品的 scenes，否则商品上的标签会与字典脱节
    const renamed = await request(http)
      .put(`/api/categories/${tag.id}`)
      .set(auth)
      .send({ name: '字典测试标签-改名后' });
    expect(renamed.body.code).toBe(0);

    const products = await request(http).get('/api/products?keyword=场景标签测试商品').set(auth);
    const product = products.body.data.list[0];
    expect(product.scenes).toContain('字典测试标签-改名后');
    expect(product.scenes).not.toContain('字典测试标签');

    await request(http).delete(`/api/categories/${tag.id}`).set(auth);
    await request(http).delete(`/api/products/${product.id}`).set(auth);
  });
});
