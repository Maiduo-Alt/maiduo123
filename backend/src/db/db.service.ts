import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { loadEnv } from './env';

/** 是否使用内存数据库（无 PostgreSQL 环境下的本地开发/演示模式）。 */
export function isMemoryDb(): boolean {
  loadEnv();
  return String(process.env.USE_PG_MEM || '').toLowerCase() === 'true';
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
      // pg-mem / 嵌入式实例对 SSL 无要求
      ssl: false,
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
