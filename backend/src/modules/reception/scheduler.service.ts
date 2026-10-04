import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { SchedulerLike } from './scheduler.types';

/** 轻量定时器管理：买家消息推送、超时检测、会话收尾。 */
@Injectable()
export class SchedulerService implements SchedulerLike, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly intervals = new Map<string, NodeJS.Timeout>();

  schedule(key: string, delayMs: number, fn: () => void | Promise<void>): void {
    this.cancel(key);
    const timer = setTimeout(async () => {
      this.timers.delete(key);
      try {
        await fn();
      } catch (err) {
        this.logger.error(`定时任务 ${key} 执行失败: ${(err as Error).message}`);
      }
    }, Math.max(0, delayMs));
    this.timers.set(key, timer);
  }

  cancel(key: string): void {
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }

  every(key: string, intervalMs: number, fn: () => void | Promise<void>): void {
    this.stopInterval(key);
    const timer = setInterval(async () => {
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

  onModuleDestroy(): void {
    this.timers.forEach((t) => clearTimeout(t));
    this.intervals.forEach((t) => clearInterval(t));
    this.timers.clear();
    this.intervals.clear();
  }
}
