import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { DbService } from '../../src/db/db.service';
import { ReceptionService } from '../../src/modules/reception/reception.service';
import { DEFAULT_PARAMS } from '../../src/domain/types';
import { createTestDb } from '../util/test-db';

describe('不同难度多会话追问计时', () => {
  let app: INestApplication;
  let db: DbService;
  let reception: ReceptionService;

  beforeAll(async () => {
    db = await createTestDb();
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DbService).useValue(db).compile();
    app = module.createNestApplication();
    await app.listen(0);
    reception = app.get(ReceptionService);
  }, 180000);

  afterAll(async () => { await app?.close(); });

  it.each([['L1', 1], ['L2', 2], ['L3', 3], ['L4', 4]])(
    '%s 同时接待 %i 个会话，首答与追问分别计时且互不串数据',
    async (level, concurrentCount) => {
      const attempt = await db.one<{ id: number }>(
        `INSERT INTO attempts (attempt_no, account_id, level, source, param_snapshot)
         VALUES ($1, 1, $2, 'free', $3::jsonb) RETURNING id`,
        [`AT-followup-concurrency-${level}`, level, JSON.stringify({ ...DEFAULT_PARAMS, responseTimingVersion: 2 })],
      );
      const question = { seq: 1, question: '这款是什么面料？', keyPoints: ['面料'], stage: 'presale' };
      const sessionIds: number[] = [];
      for (let i = 0; i < concurrentCount; i++) {
        const session = await db.one<{ id: number }>(
          `INSERT INTO sessions (attempt_id, script_id, buyer_name, state, current_seq, total_questions, questions, last_buyer_at)
           VALUES ($1, 1, $2, 'serving', 1, 1, $3::jsonb, $4) RETURNING id`,
          [attempt.id, `并发买家${i}`, JSON.stringify([question]), new Date().toISOString()],
        );
        sessionIds.push(session.id);
        await db.query(
          `INSERT INTO messages (session_id, sender, content, seq, rule_result) VALUES ($1, 'buyer', $2, 1, $3::jsonb)`,
          [session.id, question.question, JSON.stringify({ responseRoundStart: true, responseRoundType: 'question' })],
        );
      }
      await Promise.all(sessionIds.map((id, i) => db.query(
        `UPDATE sessions SET last_buyer_at = $2 WHERE id = $1`,
        [id, new Date(Date.now() - (3 + i * 4) * 1000).toISOString()],
      )));
      const firstReplies = await Promise.all(sessionIds.map((id) =>
        reception.sendMessage(1, attempt.id, id, '亲，这款面料需要帮您核实一下。'),
      ));
      for (const id of sessionIds) {
        (reception as any).scheduler.cancel(`next:${id}`);
        const session = await (reception as any).loadSession(id);
        await (reception as any).pushFollowUp(id, session, question, 0);
      }
      await Promise.all(sessionIds.map((id, i) => db.query(
        `UPDATE sessions SET last_buyer_at = $2 WHERE id = $1`,
        [id, new Date(Date.now() - (15 + i * 4) * 1000).toISOString()],
      )));
      const followupReplies = await Promise.all(sessionIds.map((id) =>
        reception.sendMessage(1, attempt.id, id, '亲，这款面料是纯棉的。'),
      ));
      for (const id of sessionIds) await reception.finishSession(1, attempt.id, id);
      const result = await reception.attemptResult(attempt.id);
      expect(result.sessions).toHaveLength(concurrentCount);
      for (let i = 0; i < sessionIds.length; i++) {
        expect(firstReplies[i].responseSec).toBeGreaterThanOrEqual(2 + i * 4);
        expect(followupReplies[i].responseSec).toBeGreaterThanOrEqual(14 + i * 4);
        const score = result.sessions.find((session: any) => session.id === sessionIds[i]);
        expect(score.metrics.avgResponseSec).toBe(Math.round((firstReplies[i].responseSec! + followupReplies[i].responseSec!) / 2));
        const messages = await db.many<{ response_sec: number }>(
          `SELECT response_sec FROM messages WHERE session_id = $1 AND sender = 'agent' ORDER BY id`, [sessionIds[i]],
        );
        expect(messages.map((message) => Number(message.response_sec))).toEqual([
          firstReplies[i].responseSec, followupReplies[i].responseSec,
        ]);
      }
    }, 60000,
  );
});
