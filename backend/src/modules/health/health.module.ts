import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/** 健康检查模块（方案 5.10）：只暴露 GET /api/health，供监控与容器健康检查使用。 */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
