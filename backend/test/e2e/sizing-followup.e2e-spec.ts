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
});
