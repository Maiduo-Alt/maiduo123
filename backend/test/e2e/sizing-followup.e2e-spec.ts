import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { DbService } from '../../src/db/db.service';
import { DEFAULT_PARAMS } from '../../src/domain/types';
import { ReceptionService } from '../../src/modules/reception/reception.service';
import { createTestDb } from '../util/test-db';

describe('尺码场景追问', () => {
  let app: INestApplication;
  let db: DbService;

  beforeAll(async () => {
    db = await createTestDb();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DbService).useValue(db).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 180000);

  afterAll(async () => { await app.close(); });

  it('客服索要腰臀围后买家先回应缺少信息，不反复要求客服推荐', async () => {
    const attempt = await db.one<{ id: number }>(
      `INSERT INTO attempts (attempt_no, account_id, level, source, param_snapshot)
       VALUES ('AT-sizing-followup', 1, 'L1', 'free', $1::jsonb) RETURNING id`,
      [JSON.stringify(DEFAULT_PARAMS)],
    );
    const goal = { id: 'size', name: '选码', requiredPoints: [
      { id: 'size', label: '尺码', matchAny: ['尺码'] },
      { id: 'recommend', label: '推荐', matchAny: ['推荐'] },
    ] };
    const questions = [{ seq: 1, question: '我158/92穿什么码', keyPoints: ['尺码', '推荐'], stage: 'presale', semanticGoals: [goal] }];
    const session = await db.one<{ id: number }>(
      `INSERT INTO sessions (attempt_id, script_id, buyer_name, state, current_seq, total_questions, questions)
       VALUES ($1, 1, '测试买家', 'serving', 1, 1, $2::jsonb) RETURNING id`,
      [attempt.id, JSON.stringify(questions)],
    );
    const rule = { judge: { pass: true, signal: 'key-point' }, goalProgress: [
      { goal, status: 'partial', coveredPointIds: ['size'], missingPointIds: ['recommend'] },
    ] };
    const reply = '亲，麻烦再提供一下腰臀围，我帮您对照尺码表推荐。';
    await db.query(`INSERT INTO messages (session_id, sender, content, seq) VALUES ($1, 'buyer', $2, 1)`, [session.id, questions[0].question]);
    await db.query(`INSERT INTO messages (session_id, sender, content, seq, rule_result) VALUES ($1, 'agent', $2, 1, $3::jsonb)`, [session.id, reply, JSON.stringify(rule)]);
    const reception = app.get(ReceptionService);
    await reception.advanceAfterReply(session.id);
    const first = await db.many<{ content: string }>(`SELECT content FROM messages WHERE session_id = $1 AND sender = 'buyer' ORDER BY id`, [session.id]);
    expect(first[first.length - 1].content).toContain('腰臀围暂时不清楚');
    await db.query(`INSERT INTO messages (session_id, sender, content, seq, rule_result) VALUES ($1, 'agent', $2, 1, $3::jsonb)`, [session.id, reply, JSON.stringify(rule)]);
    await reception.advanceAfterReply(session.id);
    const second = await db.many<{ content: string }>(`SELECT content FROM messages WHERE session_id = $1 AND sender = 'buyer' ORDER BY id`, [session.id]);
    expect(second.filter((message) => message.content.includes('腰臀围暂时不清楚'))).toHaveLength(1);
  }, 60000);

  it('客服索要身材资料时，即使回复判定通过，买家也先说明没有资料', async () => {
    const attempt = await db.one<{ id: number }>(
      `INSERT INTO attempts (attempt_no, account_id, level, source, param_snapshot)
       VALUES ('AT-sizing-fallback', 1, 'L1', 'free', $1::jsonb) RETURNING id`,
      [JSON.stringify(DEFAULT_PARAMS)],
    );
    const question = { seq: 1, question: '那我这个身材应该怎么选尺码呢？', keyPoints: ['有效回应'], stage: 'presale' };
    const session = await db.one<{ id: number }>(
      `INSERT INTO sessions (attempt_id, script_id, buyer_name, state, current_seq, total_questions, questions)
       VALUES ($1, 1, '测试买家', 'serving', 1, 1, $2::jsonb) RETURNING id`,
      [attempt.id, JSON.stringify([question])],
    );
    await db.query(`INSERT INTO messages (session_id, sender, content, seq) VALUES ($1, 'buyer', $2, 1)`, [session.id, question.question]);
    await db.query(`INSERT INTO messages (session_id, sender, content, seq, rule_result) VALUES ($1, 'agent', $2, 1, $3::jsonb)`,
      [session.id, '亲，麻烦提供身高体重和腰臀围，我帮您结合尺码表推荐。', JSON.stringify({ judge: { pass: true, signal: 'fallback' } })]);
    await app.get(ReceptionService).advanceAfterReply(session.id);
    const messages = await db.many<{ content: string }>(
      `SELECT content FROM messages WHERE session_id = $1 AND sender = 'buyer' ORDER BY id`, [session.id],
    );
    expect(messages[messages.length - 1].content).toBe('我的身高体重和腰臀围暂时都不清楚，可以先告诉我怎么看尺码表吗？');
  }, 60000);
  it('新版索要数据时买家提供稳定的身高体重，客服回复后同一目标可解决并计分', async () => {
    const attempt = await db.one<{ id: number }>(
      `INSERT INTO attempts (attempt_no, account_id, level, source, param_snapshot)
       VALUES ('AT-sizing-synthetic-data', 1, 'L1', 'free', $1::jsonb) RETURNING id`,
      [JSON.stringify({ ...DEFAULT_PARAMS, replyJudgmentVersion: 2, responseTimingVersion: 2 })],
    );
    const question = { seq: 1, question: '那我这个身材应该怎么选尺码呢？', keyPoints: [], automaticEvaluation: true, stage: 'presale' };
    const session = await db.one<{ id: number }>(
      `INSERT INTO sessions (attempt_id, script_id, buyer_name, state, current_seq, total_questions, questions, last_buyer_at)
       VALUES ($1, 1, '测试买家', 'serving', 1, 1, $2::jsonb, now()) RETURNING id`, [attempt.id, JSON.stringify([question])],
    );
    const reception = app.get(ReceptionService);
    try {
      await db.query(`INSERT INTO messages (session_id, sender, content, seq, rule_result) VALUES ($1,'buyer',$2,1,$3::jsonb)`,
        [session.id, question.question, JSON.stringify({ responseRoundStart: true })]);
      const first = await reception.sendMessage(1, attempt.id, session.id, '亲，请告诉我身高体重，我再帮您推荐尺码。');
      expect(first.ruleResult.replyAssessment.status).toBe('partial');
      expect(first.ruleResult.judge.pass).toBe(false);
      await reception.advanceAfterReply(session.id);
      const buyer = await db.one<{ content: string }>(`SELECT content FROM messages WHERE session_id = $1 AND sender = 'buyer' ORDER BY id DESC LIMIT 1`, [session.id]);
      const measurement = buyer!.content.match(/身高(\d+)厘米，体重(\d+)斤/u);
      expect(measurement).not.toBeNull();
      const reply = await reception.sendMessage(1, attempt.id, session.id, `亲，您身高${measurement![1]}厘米，体重${measurement![2]}斤，可以先参考M码，再对照尺码表。`);
      expect(reply.ruleResult.judge.pass).toBe(true);
      expect(reply.ruleResult.conversationState.resolvedGoalIds).toContain('keyword-seq-1');
      await reception.finishSession(1, attempt.id, session.id);
      const score = await db.one<{ solving_score: string }>(`SELECT solving_score FROM scores WHERE session_id = $1`, [session.id]);
      expect(Number(score!.solving_score)).toBe(35);
    } finally {
      (reception as any).scheduler.cancel(`next:${session.id}`);
      (reception as any).scheduler.cancel(`close:${session.id}`);
      await db.query(`UPDATE attempts SET status = 'finished' WHERE id = $1`, [attempt.id]);
    }
  }, 60000);

  it('新版买家已给出身高体重时复用原数据，不生成不同数值', async () => {
    const attempt = await db.one<{ id: number }>(
      `INSERT INTO attempts (attempt_no, account_id, level, source, param_snapshot)
       VALUES ('AT-sizing-existing-data', 1, 'L1', 'free', $1::jsonb) RETURNING id`,
      [JSON.stringify({ ...DEFAULT_PARAMS, replyJudgmentVersion: 2 })],
    );
    const question = { seq: 1, question: '我158/92穿什么码', keyPoints: [], automaticEvaluation: true, stage: 'presale' };
    const session = await db.one<{ id: number }>(
      `INSERT INTO sessions (attempt_id, script_id, buyer_name, state, current_seq, total_questions, questions, last_buyer_at)
       VALUES ($1, 1, '测试买家', 'serving', 1, 1, $2::jsonb, now()) RETURNING id`, [attempt.id, JSON.stringify([question])],
    );
    const reception = app.get(ReceptionService);
    try {
      await db.query(`INSERT INTO messages (session_id, sender, content, seq, rule_result) VALUES ($1,'buyer',$2,1,$3::jsonb)`,
        [session.id, question.question, JSON.stringify({ responseRoundStart: true })]);
      await reception.sendMessage(1, attempt.id, session.id, '亲，请告诉我身高体重，我再帮您参考尺码。');
      await reception.advanceAfterReply(session.id);
      const buyer = await db.one<{ content: string }>(`SELECT content FROM messages WHERE session_id = $1 AND sender = 'buyer' ORDER BY id DESC LIMIT 1`, [session.id]);
      expect(buyer!.content).toContain('身高158厘米，体重92斤');
    } finally {
      (reception as any).scheduler.cancel(`next:${session.id}`);
      (reception as any).scheduler.cancel(`close:${session.id}`);
      await db.query(`UPDATE attempts SET status = 'finished' WHERE id = $1`, [attempt.id]);
    }
  }, 60000);

  it('买家已有数据且客服已推荐尺码时不再重复要求提供身高体重', async () => {
    const attempt = await db.one<{ id: number }>(
      `INSERT INTO attempts (attempt_no, account_id, level, source, param_snapshot)
       VALUES ('AT-sizing-already-resolved', 1, 'L1', 'free', $1::jsonb) RETURNING id`,
      [JSON.stringify({ ...DEFAULT_PARAMS, replyJudgmentVersion: 2 })],
    );
    const question = { seq: 1, question: '我158/92穿什么码', keyPoints: [], automaticEvaluation: true, stage: 'presale' };
    const session = await db.one<{ id: number }>(
      `INSERT INTO sessions (attempt_id, script_id, buyer_name, state, current_seq, total_questions, questions, last_buyer_at)
       VALUES ($1, 1, '测试买家', 'serving', 1, 1, $2::jsonb, now()) RETURNING id`, [attempt.id, JSON.stringify([question])],
    );
    const reception = app.get(ReceptionService);
    try {
      await db.query(`INSERT INTO messages (session_id, sender, content, seq, rule_result) VALUES ($1,'buyer',$2,1,$3::jsonb)`,
        [session.id, question.question, JSON.stringify({ responseRoundStart: true })]);
      const reply = await reception.sendMessage(1, attempt.id, session.id, '亲，按您提供的身高体重可以先参考M码，建议对照尺码表，结合腰臀围。');
      expect(reply.ruleResult.judge.pass).toBe(true);
      await reception.advanceAfterReply(session.id);
      const messages = await db.many<{ content: string }>(`SELECT content FROM messages WHERE session_id = $1 AND sender = 'buyer' ORDER BY id`, [session.id]);
      expect(messages.map((message) => message.content).join(' ')).not.toContain('我的腰臀围暂时不清楚');
      expect(messages.map((message) => message.content).join(' ')).not.toContain('我身高158厘米，体重92斤');
    } finally {
      (reception as any).scheduler.cancel(`next:${session.id}`);
      (reception as any).scheduler.cancel(`close:${session.id}`);
      await db.query(`UPDATE attempts SET status = 'finished' WHERE id = $1`, [attempt.id]);
    }
  }, 60000);

  it('具体尺码仍是部分推进时结束语明确未确认，计分不算完全解决', async () => {
    const attempt = await db.one<{ id: number }>(
      `INSERT INTO attempts (attempt_no, account_id, level, source, param_snapshot)
       VALUES ('AT-sizing-close-unresolved', 1, 'L1', 'free', $1::jsonb) RETURNING id`,
      [JSON.stringify({ ...DEFAULT_PARAMS, replyJudgmentVersion: 2, responseTimingVersion: 2 })],
    );
    const questions = [
      { seq: 1, question: '可以换货吗？', keyPoints: [], automaticEvaluation: true },
      { seq: 2, question: '可以机洗吗？', keyPoints: [], automaticEvaluation: true },
      { seq: 3, question: '那我这个身材应该怎么选尺码呢？', keyPoints: [], automaticEvaluation: true },
    ];
    const session = await db.one<{ id: number }>(
      `INSERT INTO sessions (attempt_id, script_id, buyer_name, state, current_seq, total_questions, questions, last_buyer_at)
       VALUES ($1, 1, '测试买家', 'serving', 3, 3, $2::jsonb, now()) RETURNING id`, [attempt.id, JSON.stringify(questions)],
    );
    const reception = app.get(ReceptionService);
    try {
      for (const seq of [1, 2]) {
        await db.query(`INSERT INTO messages (session_id, sender, content, seq, rule_result) VALUES ($1,'agent',$2,$3,$4::jsonb)`,
          [session.id, '已解决', seq, JSON.stringify({ questionSeq: seq, judgmentVersion: 2, judge: { pass: true, signal: 'key-point' }, hitPoints: [] })]);
      }
      await db.query(`INSERT INTO messages (session_id, sender, content, seq, rule_result) VALUES ($1,'buyer',$2,3,$3::jsonb)`,
        [session.id, questions[2].question, JSON.stringify({ responseRoundStart: true })]);
      const partial = await reception.sendMessage(1, attempt.id, session.id, '亲，请告诉我身高体重，我再帮您推荐尺码。');
      expect(partial.ruleResult.replyAssessment.status).toBe('partial');
      await db.query(`UPDATE sessions SET follow_ups = 2 WHERE id = $1`, [session.id]);
      await reception.advanceAfterReply(session.id);
      const buyer = await db.one<{ content: string }>(`SELECT content FROM messages WHERE session_id = $1 AND sender = 'buyer' ORDER BY id DESC LIMIT 1`, [session.id]);
      expect(buyer!.content).toContain('还没有确认具体结果');
      const state = await db.one<any>(`SELECT state, conversation_state FROM sessions WHERE id = $1`, [session.id]);
      expect(state!.state).toBe('awaiting_agent_close');
      expect(state!.conversation_state.unresolvedGoalIds).toContain('keyword-seq-3');
      await reception.finishSession(1, attempt.id, session.id);
      const score = await db.one<{ solving_score: string }>(`SELECT solving_score FROM scores WHERE session_id = $1`, [session.id]);
      expect(Number(score!.solving_score)).toBe(29.2);
    } finally {
      (reception as any).scheduler.cancel(`next:${session.id}`);
      (reception as any).scheduler.cancel(`close:${session.id}`);
      await db.query(`UPDATE attempts SET status = 'finished' WHERE id = $1`, [attempt.id]);
    }
  }, 60000);

});
