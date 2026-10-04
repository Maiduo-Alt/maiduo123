import { Controller, Get } from '@nestjs/common';
import { Public } from '../../common/decorators';
import { DbService, isMemoryDb } from '../../db/db.service';

/**
 * 健康检查（方案 5.10 运维要求：「提供健康检查接口 /api/health，便于监控」）。
 *
 * 免登录（用 @Public）：监控系统（docker healthcheck / 探针 / 运维脚本）不会带令牌。
 * 返回 `status=ok|degraded`：数据库探不活时 status=degraded 并带上错误原因，
 * HTTP 仍返回 200（看响应体里的 status），这样监控用状态码或字段判断都可以。
 */
@Controller('api/health')
export class HealthController {
  constructor(private readonly db: DbService) {}

  @Public()
  @Get()
  async check() {
    const startedAt = Date.now();
    let db = 'up';
    let error: string | null = null;
    try {
      await this.db.one<{ ok: number }>('SELECT 1 AS ok');
    } catch (e) {
      db = 'down';
      error = (e as Error).message;
    }
    return {
      status: db === 'up' ? 'ok' : 'degraded',
      db,
      dbLatencyMs: Date.now() - startedAt,
      /** 内存库模式（开发用）在返回里标出来，避免把开发实例当成线上实例 */
      memoryDb: isMemoryDb(),
      version: process.env.APP_VERSION || '1.0.0',
      uptimeSec: Math.round(process.uptime()),
      time: new Date().toISOString(),
      ...(error ? { error } : {}),
    };
  }
}
