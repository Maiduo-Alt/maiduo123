import { DbService } from './db.service';
import { SCHEMA_SQL } from './schema';
import { loadEnv } from './env';
import { normalizeLegacyQuestionSeq } from '../domain/question-seq';
import { ScriptQuestion } from '../domain/types';

/** 独立执行的建表脚本：node dist/db/migrate.js */
export async function runMigrations(db: DbService): Promise<void> {
  await db.query(SCHEMA_SQL);

  // 数据迁移（幂等）：把旧版“为凑轮数注入的通用补题”直接降级成 optional，
  // 避免测试库里已经生成的旧剧本仍展示错误主目标。运行时还有同一层兼容兜底。
  const scripts = await db.many<{ id: number; question_seq: ScriptQuestion[] }>(
    `SELECT id, question_seq FROM scripts`,
  );
  for (const row of scripts) {
    const before = Array.isArray(row.question_seq) ? row.question_seq : [];
    const after = normalizeLegacyQuestionSeq(before);
    if (JSON.stringify(after) === JSON.stringify(before)) continue;
    await db.query(
      `UPDATE scripts SET question_seq = $2::jsonb, updated_at = now() WHERE id = $1`,
      [row.id, JSON.stringify(after)],
    );
  }

  // 只修正仍在进行中的会话快照；已结束记录保持当时训练现场，避免历史评分被重写。
  const sessions = await db.many<{ id: number; questions: ScriptQuestion[] }>(
    `SELECT id, questions FROM sessions WHERE state NOT IN ('finished','transferred','aborted')`,
  );
  for (const row of sessions) {
    const before = Array.isArray(row.questions) ? row.questions : [];
    const after = normalizeLegacyQuestionSeq(before);
    if (JSON.stringify(after) === JSON.stringify(before)) continue;
    await db.query(
      `UPDATE sessions
       SET questions = $2::jsonb,
           total_questions = $3,
           skipped_seqs = '[]'::jsonb,
           conversation_state = '{}'::jsonb
       WHERE id = $1`,
      [row.id, JSON.stringify(after), after.length],
    );
  }
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
