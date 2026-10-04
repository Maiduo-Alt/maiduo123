/**
 * 定时调度抽象（方案 5.5）。
 *
 * 业务代码只依赖本接口，因此底层实现可替换：
 * - 未配置 REDIS_URL：进程内定时器（默认，单机足够，零外部依赖）；
 * - 配置 REDIS_URL：Redis 有序集合延迟队列，多实例部署时周期任务只由一个实例执行。
 */
export const SCHEDULER = 'RECEPTION_SCHEDULER';

export interface SchedulerLike {
  /** 延迟执行一次；相同 key 会覆盖上一次未执行的任务。 */
  schedule(key: string, delayMs: number, fn: () => void | Promise<void>): void;
  /** 取消尚未执行的延迟任务。 */
  cancel(key: string): void;
  /** 周期执行；多实例下同一 key 在任一时刻只由一个实例执行。 */
  every(key: string, intervalMs: number, fn: () => void | Promise<void>): void;
  /** 停止周期任务。 */
  stopInterval(key: string): void;
}
