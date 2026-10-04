import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { loadEnv } from './env';

/** 是否使用内存数据库（无 PostgreSQL 环境下的本地开发/演示模式）。 */
export function isMemoryDb(): boolean {
  loadEnv();
  return String(process.env.USE_PG_MEM || '').toLowerCase() === 'true';
}

/**
 * 解析 SSL 开关（环境变量 PG_SSL）。
 * 注意 pg 的优先级是「连接串 > 本处取值」：连接串里带 `sslmode=` 时以连接串为准
 * （见 pg/lib/connection-parameters.js 中 Object.assign 的覆盖顺序）。
 *   PG_SSL=false / disable / off / 0 → 关闭
 *   PG_SSL=verify / verify-full      → 开启并校验证书链与主机名
 *   其它非空取值（如 true）           → 开启但不校验证书链（托管 PostgreSQL 常用）
 * 未设置时关闭，保持本地与内嵌实例的行为不变。
 */
export function resolveSslSetting(raw?: string): false | { rejectUnauthorized: boolean } {
  if (!raw) return false;
  switch (raw.trim().toLowerCase()) {
    case 'false':
    case 'disable':
    case 'off':
    case '0':
      return false;
    case 'verify':
    case 'verify-full':
      return { rejectUnauthorized: true };
    default:
      return { rejectUnauthorized: false };
  }
}

@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly logger = new Logger(DbService.name);
  readonly pool: Pool;

  /** 允许注入外部 Pool（测试环境使用 pg-mem 提供的适配器）。 */
  constructor(@Optional() pool?: Pool) {
    if (pool) {
      this.pool = pool;
      return;
    }
    loadEnv();
    if (isMemoryDb()) {
      // 本地无 PostgreSQL 时使用 pg-mem（惰性加载，生产环境不依赖该包）
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { newDb } = require('pg-mem');
      const mem = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
      const adapter = mem.adapters.createPg();
      this.pool = new adapter.Pool();
      this.logger.warn('已启用内存数据库模式（USE_PG_MEM=true），数据在进程重启后清空');
      return;
    }
    const connectionString =
      process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55432/cs_training';
    this.pool = new Pool({
      connectionString,
      max: Number(process.env.PG_POOL_MAX || 10),
      // 本地/内嵌实例默认不启用 SSL；托管库请在连接串里带 ?sslmode=require，
      // 或用 PG_SSL 显式控制（见 resolveSslSetting）。
      ssl: resolveSslSetting(process.env.PG_SSL),
    });
    this.pool.on('error', (err) => this.logger.error(`数据库连接异常: ${err.message}`));
  }

  async query<T extends QueryResultRow = any>(text: string, params: unknown[] = []): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, params as any[]);
  }

  async many<T extends QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.query<T>(text, params);
    return res.rows;
  }

  async one<T extends QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.many<T>(text, params);
    return rows.length ? rows[0] : null;
  }

  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
