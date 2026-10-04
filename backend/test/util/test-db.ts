import { DbService } from '../../src/db/db.service';
import { runMigrations } from '../../src/db/migrate';
import { runSeed } from '../../src/db/seed';

/**
 * 用 pg-mem 构造一个与 node-postgres 接口兼容的内存数据库，
 * 让端到端测试跑真实 SQL 而不依赖本地安装 PostgreSQL。
 */
export async function createTestDb(): Promise<DbService> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { newDb } = require('pg-mem');
  // noAstCoverageCheck：pg-mem 对部分 DDL 语法（如 jsonb 默认值）会直接报错，
  // 这里关闭 AST 覆盖检查以便在内存库中执行与生产一致的建表语句。
  const mem = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = mem.adapters.createPg();
  const pool = new adapter.Pool();
  const db = new DbService(pool);
  await runMigrations(db);
  await runSeed(db);
  return db;
}
