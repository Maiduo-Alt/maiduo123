import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { DbService } from '../../src/db/db.service';
import { AllExceptionsFilter } from '../../src/common/all-exceptions.filter';
import { ResponseInterceptor } from '../../src/common/response.interceptor';
import { createTestDb } from '../util/test-db';

/**
 * 快捷短语维护（方案 3.8 F8-08，一期）。
 *
 * 回归点：`variables` 此前从未写入、`used_count` 恒为 0，
 * 维护页拿不到可展示的变量与使用次数；这里把口径锁进用例。
 */
describe('快捷短语维护与使用计数', () => {
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

  it('内置短语带上变量与使用次数，分类统计可用于左侧分类面板', async () => {
    const token = await login('agent', 'Agent@123');
    const res = await request(http).get('/api/phrases').set('Authorization', `Bearer ${token}`);
    expect(res.body.code).toBe(0);
    expect(res.body.data.list.length).toBeGreaterThan(0);
    // 每种分类都有分类统计，够渲染「分类 + 数量」
    expect(res.body.data.categoryStats.length).toBe(res.body.data.categories.length);
    const total = res.body.data.categoryStats.reduce((sum: number, item: any) => sum + item.count, 0);
    expect(total).toBe(res.body.data.list.length);
    // 带 {变量} 的短语已经把变量抽出来
    const withVars: any = res.body.data.list.find((row: any) => row.variables?.length > 0);
    expect(withVars).toBeTruthy();
    expect(withVars.variables.length).toBeGreaterThan(0);
    expect(res.body.data.list.every((row: any) => typeof row.usedCount === 'number')).toBe(true);
  });

  it('维护短语：创建时自动抽取变量，停用后接待页看不到但维护页看得到', async () => {
    const leaderToken = await login('leader', 'Leader@123');
    const created = await request(http)
      .post('/api/phrases')
      .set('Authorization', `Bearer ${leaderToken}`)
      .send({ category: '测试分类', title: '到手价话术', content: '亲，这款到手价 {到手价} 元，{优惠方式} 后实付哦～' });
    expect(created.body.code).toBe(0);
    const id = created.body.data.id;

    const list = await request(http).get('/api/phrases').set('Authorization', `Bearer ${leaderToken}`);
    const row = list.body.data.list.find((item: any) => item.id === id);
    expect(row).toMatchObject({ category: '测试分类', status: 1 });
    expect(row.variables).toEqual(['到手价', '优惠方式']);

    // 改内容后变量跟着更新
    const updated = await request(http)
      .put(`/api/phrases/${id}`)
      .set('Authorization', `Bearer ${leaderToken}`)
      .send({ content: '亲，这款到手价 {到手价} 元，还有 {价保天数} 天价保～' });
    expect(updated.body.code).toBe(0);
    const afterUpdate = await request(http).get('/api/phrases').set('Authorization', `Bearer ${leaderToken}`);
    expect(afterUpdate.body.data.list.find((item: any) => item.id === id).variables).toEqual(['到手价', '价保天数']);

    // 停用：客服端（接待页）看不到，维护页带上 all=1 能看到
    const disabled = await request(http)
      .put(`/api/phrases/${id}`)
      .set('Authorization', `Bearer ${leaderToken}`)
      .send({ status: 0 });
    expect(disabled.body.code).toBe(0);
    const agentToken = await login('agent', 'Agent@123');
    const agentList = await request(http).get('/api/phrases').set('Authorization', `Bearer ${agentToken}`);
    expect(agentList.body.data.list.some((item: any) => item.id === id)).toBe(false);
    const maintainerList = await request(http).get('/api/phrases?all=1').set('Authorization', `Bearer ${leaderToken}`);
    expect(maintainerList.body.data.list.find((item: any) => item.id === id).status).toBe(0);
    // 客服即使传 all=1 也拿不到停用短语
    const agentAll = await request(http).get('/api/phrases?all=1').set('Authorization', `Bearer ${agentToken}`);
    expect(agentAll.body.data.list.some((item: any) => item.id === id)).toBe(false);
  });

  it('插入短语累加使用次数；客服不能维护短语', async () => {
    const leaderToken = await login('leader', 'Leader@123');
    const created = await request(http)
      .post('/api/phrases')
      .set('Authorization', `Bearer ${leaderToken}`)
      .send({ category: '测试分类', title: '计数用话术', content: '亲，稍等一分钟，我帮您核实～' });
    const id = created.body.data.id;

    const agentToken = await login('agent', 'Agent@123');
    const first = await request(http).post(`/api/phrases/${id}/use`).set('Authorization', `Bearer ${agentToken}`);
    expect(first.body.code).toBe(0);
    expect(first.body.data.usedCount).toBe(1);
    const second = await request(http).post(`/api/phrases/${id}/use`).set('Authorization', `Bearer ${agentToken}`);
    expect(second.body.data.usedCount).toBe(2);

    const deniedCreate = await request(http)
      .post('/api/phrases')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ title: '越权', content: '越权' });
    expect(deniedCreate.body.code).toBe(1003);
    const deniedDelete = await request(http).delete(`/api/phrases/${id}`).set('Authorization', `Bearer ${agentToken}`);
    expect(deniedDelete.body.code).toBe(1003);

    const removed = await request(http).delete(`/api/phrases/${id}`).set('Authorization', `Bearer ${leaderToken}`);
    expect(removed.body.code).toBe(0);
  });
});
