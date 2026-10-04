import { RedisLike, RedisSchedulerService } from '../../src/modules/reception/redis-scheduler.service';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 只实现调度器用到的命令的 Redis 替身，用于在无 Redis 服务的环境下验证多实例语义。 */
class FakeRedis implements RedisLike {
  private readonly zsets = new Map<string, Map<string, number>>();
  private readonly strings = new Map<string, { value: string; expireAt: number | null }>();
  readonly zremCalls: string[] = [];

  private setOf(key: string): Map<string, number> {
    let set = this.zsets.get(key);
    if (!set) {
      set = new Map();
      this.zsets.set(key, set);
    }
    return set;
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    const isNew = !this.setOf(key).has(member);
    this.setOf(key).set(member, score);
    return isNew ? 1 : 0;
  }

  async zrangebyscore(key: string, min: number | string, max: number | string, ...args: (string | number)[]): Promise<string[]> {
    const lower = min === '-inf' ? -Infinity : Number(min);
    const upper = Number(max);
    const sorted = [...this.setOf(key).entries()]
      .filter(([, score]) => score >= lower && score <= upper)
      .sort((a, b) => a[1] - b[1]);
    const limitIndex = args.findIndex((a) => String(a).toUpperCase() === 'LIMIT');
    const offset = limitIndex >= 0 ? Number(args[limitIndex + 1]) : 0;
    const count = limitIndex >= 0 ? Number(args[limitIndex + 2]) : sorted.length;
    return sorted.slice(offset, offset + count).map(([member]) => member);
  }

  async zrem(key: string, member: string): Promise<number> {
    this.zremCalls.push(member);
    return this.setOf(key).delete(member) ? 1 : 0;
  }

  async set(key: string, value: string, ...args: (string | number)[]): Promise<unknown> {
    const now = Date.now();
    const current = this.strings.get(key);
    if (current && current.expireAt !== null && current.expireAt <= now) this.strings.delete(key);

    const pxIndex = args.findIndex((a) => String(a).toUpperCase() === 'PX');
    const nx = args.some((a) => String(a).toUpperCase() === 'NX');
    const ttl = pxIndex >= 0 ? Number(args[pxIndex + 1]) : null;

    if (nx && this.strings.has(key)) return null;
    this.strings.set(key, { value, expireAt: ttl === null ? null : now + ttl });
    return 'OK';
  }

  async quit(): Promise<unknown> {
    return 'OK';
  }
}

describe('Redis 延迟队列调度器（方案 5.5）', () => {
  it('延迟任务到期后只执行一次，未到期不执行', async () => {
    const redis = new FakeRedis();
    const scheduler = new RedisSchedulerService(redis);
    const calls: string[] = [];
    scheduler.schedule('join:1', 60, () => {
      calls.push('join:1');
    });

    await sleep(40);
    expect(calls).toHaveLength(0);

    await sleep(400);
    expect(calls).toEqual(['join:1']);
    await scheduler.onModuleDestroy();
  });

  it('cancel 之后不再执行', async () => {
    const redis = new FakeRedis();
    const scheduler = new RedisSchedulerService(redis);
    let calls = 0;
    scheduler.schedule('next:9', 50, () => {
      calls += 1;
    });
    scheduler.cancel('next:9');

    await sleep(420);
    expect(calls).toBe(0);
    await scheduler.onModuleDestroy();
  });

  it('多实例共享队列时，同一个任务只被一个实例领走执行', async () => {
    const redis = new FakeRedis();
    const a = new RedisSchedulerService(redis);
    const b = new RedisSchedulerService(redis);
    let ranA = 0;
    let ranB = 0;

    a.schedule('join:2', 50, () => {
      ranA += 1;
    });
    b.schedule('join:2', 50, () => {
      ranB += 1;
    });

    await sleep(500);
    expect(ranA + ranB).toBe(1);
    // 两个实例都尝试过抢占，但只有一个 ZREM 成功
    expect(redis.zremCalls.filter((k) => k === 'join:2').length).toBeGreaterThanOrEqual(2);
    await a.onModuleDestroy();
    await b.onModuleDestroy();
  });

  it('周期任务用租约保证同一时刻只有一个实例在执行', async () => {
    const redis = new FakeRedis();
    const a = new RedisSchedulerService(redis);
    const b = new RedisSchedulerService(redis);
    let total = 0;
    a.every('timeout-scan', 100, () => {
      total += 1;
    });
    b.every('timeout-scan', 100, () => {
      total += 1;
    });

    await sleep(330);
    expect(total).toBeGreaterThanOrEqual(1);
    // 两个实例各跑一份的话约 6 次；有租约时应接近 3 次
    expect(total).toBeLessThanOrEqual(5);
    await a.onModuleDestroy();
    await b.onModuleDestroy();
  });

  it('销毁后不再有任务执行（定时器已清理）', async () => {
    const redis = new FakeRedis();
    const scheduler = new RedisSchedulerService(redis);
    let calls = 0;
    scheduler.every('timer-tick', 40, () => {
      calls += 1;
    });
    await sleep(120);
    const before = calls;
    await scheduler.onModuleDestroy();
    await sleep(150);
    expect(calls).toBe(before);
  });
});
