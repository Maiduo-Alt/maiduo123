import { Logger, OnModuleDestroy } from '@nestjs/common';
import { SchedulerLike } from './scheduler.types';

/** 只声明用到的 Redis 命令，便于测试注入轻量替身，也避免绑定具体客户端实现。 */
export interface RedisLike {
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zrangebyscore(key: string, min: number | string, max: number | string, ...args: (string | number)[]): Promise<string[]>;
  zrem(key: string, member: string): Promise<number>;
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>;
  quit?(): Promise<unknown>;
}

const DELAYED_KEY = 'reception:sched:delayed';
const POLL_INTERVAL_MS = 200;
const BATCH_SIZE = 50;

/**
 * Redis 有序集合实现的延迟队列（方案 5.5）。
 *
 * - 延迟任务写入 ZSET，score 为触发时间戳；后台轮询扫描到期任务，
 *   用 ZREM 的返回值做「抢占」，多实例部署时同一个任务只会被执行一次；
 * - 周期任务用 SET NX PX 抢租约，保证同一 key 在任一时刻只有一个实例在跑；
 * - 处理器函数仍在进程内注册，因此进程重启后队列里的旧任务若没有对应处理器会被跳过并告警。
 *   （业务侧在接待结束时都会取消对应任务，正常流程不会留下孤儿任务。）
 */
export class RedisSchedulerService implements SchedulerLike, OnModuleDestroy {
  private readonly logger = new Logger(RedisSchedulerService.name);
  private readonly handlers = new Map<string, () => void | Promise<void>>();
  private readonly intervals = new Map<string, NodeJS.Timeout>();
  private poller: NodeJS.Timeout | null = null;

  constructor(private readonly redis: RedisLike) {}

  schedule(key: string, delayMs: number, fn: () => void | Promise<void>): void {
    this.cancel(key);
    this.handlers.set(key, fn);
    const dueAt = Date.now() + Math.max(0, delayMs);
    this.redis
      .zadd(DELAYED_KEY, dueAt, key)
      .catch((err) => this.logger.error(`写入延迟队列失败 ${key}: ${(err as Error).message}`));
    this.startPolling();
  }

  cancel(key: string): void {
    this.handlers.delete(key);
    this.redis.zrem(DELAYED_KEY, key).catch((err) => this.logger.error(`取消延迟任务失败 ${key}: ${(err as Error).message}`));
  }

  every(key: string, intervalMs: number, fn: () => void | Promise<void>): void {
    this.stopInterval(key);
    const timer = setInterval(async () => {
      // 多实例下抢租约：只有拿到锁的实例执行本次周期任务。
      try {
        const lease = await this.redis.set(`reception:sched:every:${key}`, String(Date.now()), 'PX', intervalMs, 'NX');
        if (lease !== 'OK') return;
      } catch (err) {
        this.logger.error(`周期任务抢锁失败 ${key}: ${(err as Error).message}`);
        return;
      }
      try {
        await fn();
      } catch (err) {
        this.logger.error(`周期任务 ${key} 执行失败: ${(err as Error).message}`);
      }
    }, intervalMs);
    this.intervals.set(key, timer);
  }

  stopInterval(key: string): void {
    const timer = this.intervals.get(key);
    if (timer) {
      clearInterval(timer);
      this.intervals.delete(key);
    }
  }

  private startPolling(): void {
    if (this.poller) return;
    this.poller = setInterval(() => {
      void this.drain();
    }, POLL_INTERVAL_MS);
  }

  /** 扫描到期任务并执行；ZREM 成功才说明本次由自己负责执行。 */
  private async drain(): Promise<void> {
    let due: string[];
    try {
      due = await this.redis.zrangebyscore(DELAYED_KEY, '-inf', Date.now(), 'LIMIT', 0, BATCH_SIZE);
    } catch (err) {
      this.logger.error(`扫描延迟队列失败: ${(err as Error).message}`);
      return;
    }

    for (const key of due) {
      let claimed = 0;
      try {
        claimed = await this.redis.zrem(DELAYED_KEY, key);
      } catch (err) {
        this.logger.error(`抢占延迟任务失败 ${key}: ${(err as Error).message}`);
        continue;
      }
      if (claimed !== 1) continue;

      const fn = this.handlers.get(key);
      if (!fn) {
        this.logger.warn(`延迟任务 ${key} 在本进程没有对应处理器，已跳过`);
        continue;
      }
      try {
        await fn();
      } catch (err) {
        this.logger.error(`延迟任务 ${key} 执行失败: ${(err as Error).message}`);
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    this.intervals.forEach((timer) => clearInterval(timer));
    this.intervals.clear();
    this.handlers.clear();
    try {
      await this.redis.quit?.();
    } catch {
      /* 关闭连接失败不影响退出 */
    }
  }
}
