import { Logger, Module } from '@nestjs/common';
import IORedis from 'ioredis';
import { ReceptionController } from './reception.controller';
import { ReceptionService } from './reception.service';
import { ReceptionGateway } from './reception.gateway';
import { SchedulerService } from './scheduler.service';
import { RedisLike, RedisSchedulerService } from './redis-scheduler.service';
import { SCHEDULER, SchedulerLike } from './scheduler.types';
import { ScriptsModule } from '../scripts/scripts.module';
import { TasksModule } from '../tasks/tasks.module';

@Module({
  imports: [ScriptsModule, TasksModule],
  controllers: [ReceptionController],
  providers: [
    ReceptionService,
    ReceptionGateway,
    {
      // 方案 5.5：配置 REDIS_URL 时改用 Redis 延迟队列（多实例下周期任务只跑一次），
      // 未配置时保持进程内定时器，单机部署零外部依赖。
      provide: SCHEDULER,
      useFactory: (): SchedulerLike => {
        const url = process.env.REDIS_URL;
        if (!url) return new SchedulerService();
        const logger = new Logger('Scheduler');
        logger.log(`使用 Redis 延迟队列：${url.replace(/\/\/.*@/, '//***@')}`);
        const client = new IORedis(url, { maxRetriesPerRequest: null });
        // ioredis 的同名命令带有更严格的回调重载，这里按本模块用到的最小命令集收窄类型。
        return new RedisSchedulerService(client as unknown as RedisLike);
      },
    },
  ],
  exports: [ReceptionService],
})
export class ReceptionModule {}
