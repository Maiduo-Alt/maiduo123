import { DbService } from './db.service';
import { SCHEMA_SQL } from './schema';
import { loadEnv } from './env';

/** 独立执行的建表脚本：node dist/db/migrate.js */
export async function runMigrations(db: DbService): Promise<void> {
  await db.query(SCHEMA_SQL);
}

async function main(): Promise<void> {
  loadEnv();
  const db = new DbService();
  try {
    await runMigrations(db);
    // eslint-disable-next-line no-console
    console.log('[migrate] 数据库结构已就绪');
  } finally {
    await db.onModuleDestroy();
  }
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[migrate] 失败:', err.message);
    process.exit(1);
  });
}
