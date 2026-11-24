import { ReceptionService } from '../../src/modules/reception/reception.service';
import { DEFAULT_PARAMS } from '../../src/domain/types';

describe('补位进线时间', () => {
  afterEach(() => jest.restoreAllMocks());

  it('使用本次模拟的配置安排补位并保存计划时间', async () => {
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const db: any = {
      one: jest.fn()
        .mockResolvedValueOnce({ level: 'L2', param_snapshot: { ...DEFAULT_PARAMS, levelJoinDelaySec: [20, 20] } })
        .mockResolvedValueOnce({ count: '1' })
        .mockResolvedValueOnce({ id: 3 }),
      query: jest.fn(),
    };
    const scheduler: any = { schedule: jest.fn() };
    const service: any = new ReceptionService(db, {} as any, {} as any, scheduler, {} as any, {} as any);
    await service.promoteWaiting(1);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("state = 'wait'"), [3, new Date(now + 20000).toISOString()]);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('last_buyer_at = NULL'), [3, new Date(now + 20000).toISOString()]);
    expect(scheduler.schedule).toHaveBeenCalledWith('join:3', 20000, expect.any(Function));
  });

  it('并发补位已被抢占时不再重复调度同一客户进线', async () => {
    const db: any = {
      one: jest.fn()
        .mockResolvedValueOnce({ level: 'L1', param_snapshot: { ...DEFAULT_PARAMS, levelJoinDelaySec: [5, 5] } })
        .mockResolvedValueOnce({ count: '0' })
        .mockResolvedValueOnce({ id: 7 })
        .mockResolvedValueOnce(null),
      query: jest.fn().mockResolvedValueOnce({ rows: [] }),
    };
    const scheduler: any = { schedule: jest.fn() };
    const service: any = new ReceptionService(db, {} as any, {} as any, scheduler, {} as any, {} as any);
    await service.promoteWaiting(1);
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });

  it('服务重启后按计划时间恢复等待', async () => {
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const db: any = {
      many: jest.fn().mockResolvedValueOnce([{ id: 1 }]).mockResolvedValueOnce([
        { id: 3, state: 'wait', join_at: new Date(now + 12000).toISOString(), close_deadline_at: null },
        { id: 4, state: 'wait', join_at: new Date(now - 1000).toISOString(), close_deadline_at: null },
      ]),
      one: jest.fn().mockResolvedValue(null),
    };
    const scheduler: any = { schedule: jest.fn() };
    const service: any = new ReceptionService(db, {} as any, {} as any, scheduler, {} as any, {} as any);
    await service.recoverRunningAttempts();
    expect(scheduler.schedule).toHaveBeenCalledWith('join:3', 12000, expect.any(Function));
    expect(scheduler.schedule).toHaveBeenCalledWith('join:4', 0, expect.any(Function));
  });
});
