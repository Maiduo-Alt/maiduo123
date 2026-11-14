import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { DbService } from '../../src/db/db.service';
import { DEFAULT_PARAMS } from '../../src/domain/types';
import { ReceptionService } from '../../src/modules/reception/reception.service';
import { createTestDb } from '../util/test-db';

describe('洗护场景追问', () => {
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

  it.each(['hedge', 'partial'])('旧洗护剧本的 %s 追问围绕洗涤，不转问面料', async (kind) => {
    const attempt = await db.one<{ id: number }>(
      `INSERT INTO attempts (attempt_no, account_id, level, source, param_snapshot)
       VALUES ($1, 1, 'L1', 'free', $2::jsonb) RETURNING id`,
      [`AT-wash-${kind}`, JSON.stringify(DEFAULT_PARAMS)],
    );
    const goal = { id: 'wash', name: '洗护', requiredPoints: [
      { id: 'wash', label: '机洗', matchAny: ['机洗'] },
      { id: 'material', label: '面料成分', matchAny: ['面料'] },
    ] };
    const question = { seq: 1, question: '这款连衣裙可以机洗吗？', keyPoints: ['机洗'], stage: 'presale',
      semanticGoals: [goal], conversationPlan: { followUpTemplates: ['我想确认面料成分和穿着感受，可以具体说一下吗？'] } };
    const session = await db.one<{ id: number }>(
      `INSERT INTO sessions (attempt_id, script_id, buyer_name, state, current_seq, total_questions, questions)
       VALUES ($1, 1, '测试买家', 'serving', 1, 1, $2::jsonb) RETURNING id`,
      [attempt.id, JSON.stringify([question])],
    );
    const rule = { judge: { pass: false, signal: 'hedge' }, goalProgress: kind === 'partial'
      ? [{ goal, status: 'partial', coveredPointIds: ['wash'], missingPointIds: ['material'] }]
      : [{ goal, status: 'untriggered', missingPointIds: ['wash', 'material'] }] };
    await db.query(`INSERT INTO messages (session_id, sender, content, seq) VALUES ($1, 'buyer', $2, 1)`, [session.id, question.question]);
    await db.query(`INSERT INTO messages (session_id, sender, content, seq, rule_result) VALUES ($1, 'agent', $2, 1, $3::jsonb)`,
      [session.id, '我帮您核实一下。', JSON.stringify(rule)]);
    await app.get(ReceptionService).advanceAfterReply(session.id);
    const messages = await db.many<{ content: string }>(
      `SELECT content FROM messages WHERE session_id = $1 AND sender = 'buyer' ORDER BY id`, [session.id],
    );
    expect(messages[messages.length - 1].content).toContain('机洗');
    expect(messages[messages.length - 1].content).not.toContain('面料成分');
  }, 60000);
});
