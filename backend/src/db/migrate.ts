import { DbService } from './db.service';
import { SCHEMA_SQL } from './schema';
import { loadEnv } from './env';
import { normalizeLegacyQuestionSeq } from '../domain/question-seq';
import { ScriptQuestion } from '../domain/types';
import { KEY_POINT_ALIASES } from '../domain/key-point-aliases';

function repairCraftDetailQuestionSeq(questions: ScriptQuestion[]): ScriptQuestion[] {
  const pointsByQuestion: Record<string, string[]> = {
    '是包边还是锁边？': ['工艺', '锁边'],
    '走线整齐吗？': ['走线', '整齐'],
    '有内衬吗？': ['内衬', '不透'],
  };
  return (questions || []).map((question) => {
    const keyPoints = pointsByQuestion[String(question.question || '').trim()];
    if (!keyPoints) return question;
    const autoGoals = (question.semanticGoals || []).map((goal) => {
      if (!String(goal.id || '').startsWith('auto-goal-')) return goal;
      return {
        ...goal,
        requiredPoints: keyPoints.map((point, index) => ({
          id: `auto-point-${question.seq}-${index + 1}`,
          label: point,
          matchMode: 'flexible' as const,
          ...(question.goalPriority === 'primary' && index === 0 ? { isPrimary: true } : {}),
          matchAny: [...new Set([point, ...(KEY_POINT_ALIASES[point] || [])])],
        })),
      };
    });
    return { ...question, keyPoints, semanticGoals: autoGoals };
  });
}

/** 独立执行的建表脚本：node dist/db/migrate.js */
export async function runMigrations(db: DbService): Promise<void> {
  await db.query(SCHEMA_SQL);

  // 修复内置“咨询工艺细节”早期错位要点：第 2/3 轮曾把包边/锁边、整齐/说明
  // 错配到走线/内衬问题，导致明确回答仍判 0 命中并反复追问。
  await db.query(
    `UPDATE buyer_qa
     SET key_points = $2::jsonb,
         accepted_answer = $3,
         updated_at = now()
     WHERE template_name = $1`,
    [
      '咨询工艺细节',
      JSON.stringify([['工艺', '锁边'], ['走线', '整齐'], ['内衬', '不透']]),
      '说明工艺做法、走线水平和内衬情况，可提供细节实拍',
    ],
  );

  // 手册首选回归场景必须在已有测试库中也可复现：
  // 若“耐穿与打理成本 × 咨询工艺细节”组合缺失，则把该咨询内容的一条现有种子剧本调整到该背景。
  const durabilityBg = await db.one<{ id: number }>(
    `SELECT id FROM buyer_bg WHERE name = $1 LIMIT 1`,
    ['关注点：耐穿与打理成本'],
  );
  const craftQa = await db.one<{ id: number }>(
    `SELECT id FROM buyer_qa WHERE template_name = $1 LIMIT 1`,
    ['咨询工艺细节'],
  );
  if (durabilityBg && craftQa) {
    const exact = await db.one<{ id: number }>(
      `SELECT id FROM scripts WHERE bg_id = $1 AND qa_id = $2 LIMIT 1`,
      [durabilityBg.id, craftQa.id],
    );
    if (!exact) {
      const fallback = await db.one<{ id: number; stage: string }>(
        `SELECT id, stage FROM scripts WHERE qa_id = $1 ORDER BY id LIMIT 1`,
        [craftQa.id],
      );
      if (fallback) {
        const stageName = fallback.stage === 'aftersale' ? '售后' : '售前';
        await db.query(
          `UPDATE scripts
           SET bg_id = $2,
               name = $3,
               updated_at = now()
           WHERE id = $1`,
          [
            fallback.id,
            durabilityBg.id,
            `${stageName}-耐穿与打理成本-咨询工艺细节`,
          ],
        );
      }
    }
  }

  // 数据迁移（幂等）：把旧版“为凑轮数注入的通用补题”直接降级成 optional，
  // 避免测试库里已经生成的旧剧本仍展示错误主目标。运行时还有同一层兼容兜底。
  const scripts = await db.many<{ id: number; question_seq: ScriptQuestion[] }>(
    `SELECT id, question_seq FROM scripts`,
  );
  for (const row of scripts) {
    const before = Array.isArray(row.question_seq) ? row.question_seq : [];
    const after = repairCraftDetailQuestionSeq(normalizeLegacyQuestionSeq(before));
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
    const after = repairCraftDetailQuestionSeq(normalizeLegacyQuestionSeq(before));
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
