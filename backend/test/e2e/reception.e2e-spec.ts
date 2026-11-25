import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { DbService } from '../../src/db/db.service';
import { ReceptionService } from '../../src/modules/reception/reception.service';
import { ReceptionGateway } from '../../src/modules/reception/reception.gateway';
import { AuthService } from '../../src/modules/auth/auth.service';
import { ModelCredentialsService } from '../../src/modules/settings/model-credentials.service';
import { DEFAULT_PARAMS } from '../../src/domain/types';
import { AllExceptionsFilter } from '../../src/common/all-exceptions.filter';
import { ResponseInterceptor } from '../../src/common/response.interceptor';
import { createTestDb } from '../util/test-db';
import { buildXlsxBuffer, sharedStringsXml } from '../util/xlsx-fixture';
import { io, Socket } from 'socket.io-client';
import fs from 'fs';
import os from 'os';
import path from 'path';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('在线模拟接待端到端链路', () => {
  let app: INestApplication;
  let http: any;
  let sharedDb: DbService;

  beforeAll(async () => {
    const db = await createTestDb();
    sharedDb = db;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DbService)
      .useValue(db)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    // 用 listen 而不是 init：实时用例需要一个常驻的 HTTP 服务来挂载 Socket.IO。
    http = await app.listen(0);
  }, 180000);

  afterAll(async () => {
    await app?.close();
  });

  async function login(username: string, password: string): Promise<string> {
    const res = await request(http).post('/api/auth/login').send({ username, password });
    expect(res.body.code).toBe(0);
    return res.body.data.token;
  }

  async function waitFor(assertion: () => boolean, timeoutMs = 5000): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (assertion()) return;
      await sleep(100);
    }
    throw new Error('等待条件超时');
  }

  it('仅管理员可保存模型密钥，密钥加密存储且不会返回或写入审计日志', async () => {
    const admin = await login('admin', 'Admin@123');
    const agent = await login('agent', 'Agent@123');
    const secret = 'mock-provider-key-8391';
    try {
      const denied = await request(http).put('/api/settings/model-key').set('Authorization', `Bearer ${agent}`).send({ provider: 'glm', secret });
      expect(denied.body.code).toBe(1003);
      const saved = await request(http).put('/api/settings/model-key').set('Authorization', `Bearer ${admin}`).send({ provider: 'glm', secret });
      expect(saved.body.code).toBe(0);
      expect(saved.body.data.glmConfigured).toBe(true);
      expect(JSON.stringify(saved.body)).not.toContain(secret);
      const row = await sharedDb.one<{ encrypted_key: string }>(`SELECT encrypted_key FROM model_credentials WHERE provider = $1`, ['glm']);
      expect(row.encrypted_key).not.toContain(secret);
      expect((await app.get(ModelCredentialsService).getKeys()).glmKey).toBe(secret);
      await sleep(100);
      const logs = await sharedDb.many<{ detail: any }>(`SELECT detail FROM action_logs WHERE action = $1`, ['PUT /api/settings/model-key']);
      expect(JSON.stringify(logs)).not.toContain(secret);
    } finally {
      await sharedDb.query(`DELETE FROM model_credentials WHERE provider = $1`, ['glm']);
    }
  });

  it('生产环境拒绝通过 HTTP 提交模型密钥', async () => {
    const admin = await login('admin', 'Admin@123');
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const response = await request(http).put('/api/settings/model-key').set('Authorization', `Bearer ${admin}`)
        .send({ provider: 'glm', secret: 'mock-http-key' });
      expect(response.body.code).toBe(1003);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it('仅管理员可查看模型配置状态且接口不返回密钥', async () => {
    const admin = await login('admin', 'Admin@123');
    const agent = await login('agent', 'Agent@123');
    const oldGlm = process.env.GLM_API_KEY;
    process.env.GLM_API_KEY = 'test-only-secret';
    try {
      const response = await request(http).get('/api/settings/model-status').set('Authorization', `Bearer ${admin}`);
      expect(response.body.data.glmConfigured).toBe(true);
      expect(JSON.stringify(response.body)).not.toContain('test-only-secret');
      expect((await request(http).get('/api/settings/model-status').set('Authorization', `Bearer ${agent}`)).body.code).toBe(1003);
    } finally {
      if (oldGlm === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = oldGlm;
    }
  });

  it('服务重启后恢复中断的模型处理并排除暂停时间', async () => {
    const attempt = await sharedDb.one<{ id: number }>(
      `INSERT INTO attempts (attempt_no, account_id, level, source, param_snapshot) VALUES ($1, 1, 'L1', 'free', $2::jsonb) RETURNING id`,
      ['AT-model-restart-test', JSON.stringify(DEFAULT_PARAMS)],
    );
    const now = Date.now();
    const session = await sharedDb.one<{ id: number }>(
      `INSERT INTO sessions (attempt_id, script_id, buyer_name, state, current_seq, total_questions, questions, last_buyer_at, model_started_at)
       VALUES ($1, 1, '重启买家', 'serving', 1, 1, $2::jsonb, $3, $4) RETURNING id`,
      [attempt.id, JSON.stringify([{ seq: 1, question: '可以机洗吗？', keyPoints: ['洗标'], stage: 'presale' }]), new Date(now - 8000).toISOString(), new Date(now - 5000).toISOString()],
    );
    await sharedDb.query(`INSERT INTO messages (session_id, sender, content, seq, rule_result) VALUES ($1,'agent',$2,1,$3::jsonb)`,
      [session.id, '请以洗标为准。', JSON.stringify({ judgmentState: 'pending' })]);
    try {
      const reception = app.get(ReceptionService);
      await (reception as any).recoverRunningAttempts();
      const row = await sharedDb.one<{ model_started_at: string | null }>(`SELECT model_started_at FROM sessions WHERE id = $1`, [session.id]);
      expect(row.model_started_at).toBeNull();
      const snapshot = await reception.snapshot(1, attempt.id);
      expect(snapshot.sessions[0].waitedSec).toBeGreaterThanOrEqual(3);
      expect(snapshot.sessions[0].waitedSec).toBeLessThanOrEqual(4);
      expect(snapshot.messages[0]).toMatchObject({ content: '请以洗标为准。', ruleResult: { judgmentState: 'unavailable' } });
    } finally {
      await sharedDb.query(`UPDATE attempts SET status = 'finished' WHERE id = $1`, [attempt.id]);
    }
  });

  it('模型处理期间暂停计时，失败后恢复计时并可重试', async () => {
    const attempt = await sharedDb.one<{ id: number }>(
      `INSERT INTO attempts (attempt_no, account_id, level, source, param_snapshot) VALUES ($1, 1, 'L1', 'free', $2::jsonb) RETURNING id`,
      ['AT-model-pause-test', JSON.stringify(DEFAULT_PARAMS)],
    );
    const session = await sharedDb.one<{ id: number }>(
      `INSERT INTO sessions (attempt_id, script_id, buyer_name, state, current_seq, total_questions, questions, last_buyer_at)
       VALUES ($1, 1, '计时买家', 'serving', 1, 1, $2::jsonb, $3) RETURNING id`,
      [attempt.id, JSON.stringify([{ seq: 1, question: '可以机洗吗？', keyPoints: ['洗标'], stage: 'presale' }]), new Date(Date.now() - 2000).toISOString()],
    );
    const reception = app.get(ReceptionService);
    const oldGlm = process.env.GLM_API_KEY;
    const oldDeepseek = process.env.DEEPSEEK_API_KEY;
    process.env.GLM_API_KEY = 'test';
    delete process.env.DEEPSEEK_API_KEY;
    let rejectRequest: (response: Response) => void = () => {};
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(() => new Promise((resolve) => { rejectRequest = resolve; }));
    try {
      const sending = reception.sendMessage(1, attempt.id, session.id, '请以洗标为准。');
      await waitFor(() => fetchMock.mock.calls.length > 0);
      const before = (await reception.snapshot(1, attempt.id)).sessions[0];
      await sleep(1200);
      const during = (await reception.snapshot(1, attempt.id)).sessions[0];
      expect(during.timerPausedAt).toBeTruthy();
      expect(during.waitedSec).toBe(before.waitedSec);
      rejectRequest({ ok: false } as Response);
      await expect(sending).rejects.toThrow('模型服务不可用');
      const after = (await reception.snapshot(1, attempt.id)).sessions[0];
      expect(after.timerPausedAt).toBeNull();
      expect(after.waitedSec).toBeLessThanOrEqual(before.waitedSec + 1);
    } finally {
      fetchMock.mockRestore();
      if (oldGlm === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = oldGlm;
      if (oldDeepseek === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = oldDeepseek;
      await sharedDb.query(`UPDATE attempts SET status = 'finished' WHERE id = $1`, [attempt.id]);
    }
  });

  it('本地混合模式先落库，开放题串行判定且模型故障后解除暂停', async () => {
    const auth = { Authorization: `Bearer ${await login('admin', 'Admin@123')}` };
    const attempt = await sharedDb.one<{ id: number }>(
      `INSERT INTO attempts (attempt_no, account_id, level, source, param_snapshot) VALUES ($1, 1, 'L1', 'free', $2::jsonb) RETURNING id`,
      ['AT-background-judge-test', JSON.stringify({ ...DEFAULT_PARAMS, questionPushDelaySec: [600, 600] })],
    );
    const addSession = async (question: string) => {
      const session = await sharedDb.one<{ id: number }>(
        `INSERT INTO sessions (attempt_id, script_id, buyer_name, state, current_seq, total_questions, questions, last_buyer_at)
         VALUES ($1, 1, '测试买家', 'serving', 1, 1, $2::jsonb, now()) RETURNING id`,
        [attempt.id, JSON.stringify([{ seq: 1, question, keyPoints: [] }])],
      );
      await sharedDb.query(
        `INSERT INTO messages (session_id, sender, content, seq, rule_result) VALUES ($1,'buyer',$2,1,$3::jsonb)`,
        [session.id, question, JSON.stringify({ responseRoundStart: true, responseRoundType: 'question' })],
      );
      return session.id;
    };
    const first = await addSession('走线整齐吗？');
    const second = await addSession('内衬用了什么材料？');
    const color = await addSession('实物和详情页图片色差大吗？');
    const send = (id: number, content: string) => request(http)
      .post(`/api/receptions/${attempt.id}/sessions/${id}/messages`).set(auth)
      .send({ content, backgroundJudgment: true });
    const snapshot = () => app.get(ReceptionService).snapshot(1, attempt.id);
    const oldMode = process.env.REPLY_JUDGMENT_MODE;
    const oldModel = process.env.LOCAL_SEMANTIC_JUDGE_MODEL;
    process.env.REPLY_JUDGMENT_MODE = 'local';
    process.env.LOCAL_SEMANTIC_JUDGE_MODEL = 'qwen3:0.6b';
    const releases: ((response: Response) => void)[] = [];
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(
      () => new Promise((resolve) => releases.push(resolve)),
    );
    const accepted = { ok: true, json: async () => ({ choices: [{ message: {
      content: JSON.stringify({ resolved: true, reason: '直接回答', evidence: ['整齐的哦'] }),
    } }] }) } as Response;
    try {
      const firstReply = (await send(first, '整齐的哦')).body.data;
      const secondReply = (await send(second, '棉质内衬')).body.data;
      expect([firstReply.ruleResult.judgmentState, secondReply.ruleResult.judgmentState]).toEqual(['pending', 'pending']);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const pending = await snapshot();
      expect(pending.sessions.filter((session) => [first, second].includes(session.sessionId)).map((session) => session.state))
        .toEqual(['waiting_buyer', 'waiting_buyer']);
      expect(pending.messages.find((msg) => msg.id === firstReply.messageId)).toMatchObject({ content: '整齐的哦', ruleResult: { judgmentState: 'pending' } });
      const followUpRes = await send(first, '为您服务，请问有什么可以帮您？');
      expect(followUpRes.body.code).toBe(0);
      const followUpReply = followUpRes.body.data;
      expect(followUpReply.ruleResult).toMatchObject({ judge: { pass: false, signal: 'hedge' }, replyAssessment: { source: 'rule' } });
      const fast = (await send(color, '光线可能带来细微色差')).body.data;
      expect(fast.ruleResult).toMatchObject({ judge: { pass: true }, replyAssessment: { source: 'rule' } });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      releases[0](accepted);
      await waitFor(() => releases.length === 2);
      releases[1]({ ok: false } as Response);
      let completed = await snapshot();
      for (let i = 0; i < 30 && completed.messages.some((msg) => msg.ruleResult?.judgmentState === 'pending'); i++) {
        await sleep(50);
        completed = await snapshot();
      }
      expect(completed.sessions.every((session) => !session.timerPausedAt)).toBe(true);
      expect(completed.messages.filter((msg) => msg.sessionId === first && msg.sender === 'agent')).toEqual([
        expect.objectContaining({ id: firstReply.messageId, ruleResult: expect.objectContaining({ judge: { pass: true, signal: 'key-point' } }) }),
        expect.objectContaining({ id: followUpReply.messageId, ruleResult: expect.objectContaining({ judge: { pass: false, signal: 'hedge' }, replyAssessment: expect.objectContaining({ source: 'rule' }) }) }),
      ]);
      expect(completed.messages.find((msg) => msg.id === secondReply.messageId)).toMatchObject({
        content: '棉质内衬', ruleResult: { judgmentState: 'unavailable' }, isTimeout: false,
      });
    } finally {
      releases.forEach((resolve) => resolve({ ok: false } as Response));
      fetchMock.mockRestore();
      if (oldMode === undefined) delete process.env.REPLY_JUDGMENT_MODE; else process.env.REPLY_JUDGMENT_MODE = oldMode;
      if (oldModel === undefined) delete process.env.LOCAL_SEMANTIC_JUDGE_MODEL; else process.env.LOCAL_SEMANTIC_JUDGE_MODEL = oldModel;
      await sharedDb.query(`UPDATE attempts SET status = 'finished' WHERE id = $1`, [attempt.id]);
    }
  });

  it('本地语义模式只用模型判定，关键词命中无法覆盖模型结论', async () => {
    const attempt = await sharedDb.one<{ id: number }>(
      `INSERT INTO attempts (attempt_no, account_id, level, source, param_snapshot) VALUES ($1, 1, 'L1', 'free', $2::jsonb) RETURNING id`,
      ['AT-local-judge-test', JSON.stringify({ ...DEFAULT_PARAMS, questionPushDelaySec: [600, 600] })],
    );
    const session = await sharedDb.one<{ id: number }>(
      `INSERT INTO sessions (attempt_id, script_id, buyer_name, state, current_seq, total_questions, questions, last_buyer_at)
        VALUES ($1, 1, '语义买家', 'serving', 1, 1, $2::jsonb, now()) RETURNING id`,
      [attempt.id, JSON.stringify([{ seq: 1, question: '走线整齐吗？', keyPoints: ['走线'] }])],
    );
    const addBuyer = (content: string, seq: number, rule = {}) => sharedDb.query(
      "INSERT INTO messages (session_id, sender, content, seq, rule_result) VALUES ($1, 'buyer', $2, $3, $4::jsonb)",
      [session.id, content, seq, JSON.stringify(rule)]);
    await addBuyer('上一题：多久发货？', 0);
    await addBuyer('在吗？', 1, { responseRoundType: 'opener' });
    await addBuyer('你好，我来看商品。', 1);
    await addBuyer('走线整齐吗？', 1, { responseRoundStart: true, responseRoundType: 'question' });
    const reception = app.get(ReceptionService);
    const oldMode = process.env.REPLY_JUDGMENT_MODE;
    process.env.REPLY_JUDGMENT_MODE = 'local';
    const fetchMock = jest.spyOn(global, 'fetch');
    const inputFrom = (request: RequestInit | undefined) => {
      const body = JSON.parse(String(request?.body));
      return JSON.parse(body.messages.at(-1).content);
    };
    const response = (resolved: boolean, evidence: string[]) => ({
      ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
        resolved, evidence, reason: '测试判定', matchedPoints: [],
      }) } }] }),
    } as Response);
    try {
      fetchMock.mockResolvedValueOnce({ ok: false } as Response);
      await expect(reception.sendMessage(1, attempt.id, session.id, '走线')).rejects.toThrow('模型服务不可用');
      fetchMock.mockResolvedValueOnce(response(false, []));
      const rejected = await reception.sendMessage(1, attempt.id, session.id, '走线可以帮您核实一下。');
      expect(rejected.ruleResult).toMatchObject({ semanticOnly: true, hitPoints: [], judge: { pass: false }, replyAssessment: { source: 'local' } });
      const inputAt = (index: number) => inputFrom(fetchMock.mock.calls[index][1]);
      expect(inputAt(1)).toMatchObject({ question: '走线整齐吗？' });
      expect(inputAt(1).history).toBeUndefined();
      await addBuyer('那实物和详情页比呢？', 1, { responseRoundStart: true });
      await addBuyer('颜色差得多吗？', 1);
      const currentQuestion = '那实物和详情页比呢？\n颜色差得多吗？';
      const answer = '灯光和屏幕会有些微色差，收到不满意也可以联系客服。';
      fetchMock.mockImplementationOnce(async (_url, request) =>
        inputFrom(request).question === currentQuestion ? response(true, ['有些微色差']) : response(false, []));
      const accepted = await reception.sendMessage(1, attempt.id, session.id, answer);
      expect(accepted.ruleResult).toMatchObject({ hitPoints: [], judge: { pass: true }, replyAssessment: { source: 'local' } });
      expect(inputAt(2).question).toBe(currentQuestion);
      expect(inputAt(2).history).toEqual([
        { role: 'buyer', content: '走线整齐吗？' },
        { role: 'agent', content: '走线可以帮您核实一下。' },
        { role: 'buyer', content: '那实物和详情页比呢？' },
        { role: 'buyer', content: '颜色差得多吗？' },
      ]);
      expect(accepted.ruleResult.modelEvaluation?.buyerReply).toBe('');
      expect(fetchMock.mock.calls.every(([url]) => String(url).includes('/v1/chat/completions'))).toBe(true);
      await reception.finishSession(1, attempt.id, session.id);
      const score = await sharedDb.one<{ solving_score: string }>('SELECT solving_score FROM scores WHERE session_id = $1', [session.id]);
      expect(Number(score?.solving_score)).toBe(35);
    } finally {
      fetchMock.mockRestore();
      if (oldMode === undefined) delete process.env.REPLY_JUDGMENT_MODE; else process.env.REPLY_JUDGMENT_MODE = oldMode;
      await sharedDb.query("UPDATE attempts SET status = 'finished' WHERE id = $1", [attempt.id]);
    }
  });

  it.each([
    [false, '这款该怎么手洗？', 2, []],
    [true, '对了，我还想顺便问一下：请问能机洗吗!', 3, [2]],
  ])('本地判定推进按已回答状态处理后续重复题：%s', async (passed, secondQuestion, expectedSeq, skipped) => {
    const attempt = await sharedDb.one<{ id: number }>(
      `INSERT INTO attempts (attempt_no, account_id, level, source, param_snapshot) VALUES ($1, 1, 'L1', 'free', $2::jsonb) RETURNING id`,
      [`AT-local-no-repeat-${passed}`, JSON.stringify({ ...DEFAULT_PARAMS, questionPushDelaySec: [600, 600] })],
    );
    const session = await sharedDb.one<{ id: number }>(
      `INSERT INTO sessions (attempt_id, script_id, buyer_name, state, current_seq, total_questions, questions, last_buyer_at)
        VALUES ($1, 1, '语义买家', 'waiting_buyer', 1, 3, $2::jsonb, now()) RETURNING id`,
      [attempt.id, JSON.stringify([{ seq: 1, question: '能机洗吗？', keyPoints: [] },
        { seq: 2, question: secondQuestion, keyPoints: [] }, { seq: 3, question: '面料厚吗？', keyPoints: [] }])],
    );
    const reception = app.get(ReceptionService);
    try {
      await sharedDb.query(
        `INSERT INTO messages (session_id, sender, content, seq, rule_result) VALUES ($1, 'agent', $3, 1, $2::jsonb)`,
        [session.id, JSON.stringify({ judgmentVersion: 2, semanticOnly: true,
          judge: { pass: passed, signal: passed ? 'key-point' : 'hedge' }, replyAssessment: { status: passed ? 'resolved' : 'unanswered' },
          modelEvaluation: { provider: 'local', resolved: passed, matchedPoints: [] } }), passed ? '可以机洗' : '我核实一下'],
      );
      await reception.advanceAfterReply(session.id);
      const state = await sharedDb.one<{ current_seq: number; follow_ups: number }>(
        'SELECT current_seq, follow_ups, skipped_seqs FROM sessions WHERE id = $1', [session.id]);
      expect(state).toMatchObject({ current_seq: expectedSeq, follow_ups: 0, skipped_seqs: skipped });
      const replies = await sharedDb.many<{ seq: number }>(
        "SELECT seq FROM messages WHERE session_id = $1 AND sender = 'buyer'", [session.id]);
      expect(replies.every((reply) => reply.seq !== 1)).toBe(true);
    } finally {
      await sharedDb.query("UPDATE attempts SET status = 'finished' WHERE id = $1", [attempt.id]);
    }
  });

  it('模型备用接口参与回复判定，生成的买家消息按会话推送；失败可重试', async () => {
    const attempt = await sharedDb.one<{ id: number }>(
      `INSERT INTO attempts (attempt_no, account_id, level, source, param_snapshot) VALUES ($1, 1, 'L1', 'free', $2::jsonb) RETURNING id`,
      ['AT-model-reception-test', JSON.stringify({ ...DEFAULT_PARAMS, questionPushDelaySec: [600, 600] })],
    );
    const question = { seq: 1, question: '可以机洗吗？', keyPoints: ['洗标'], stage: 'presale' };
    const session = await sharedDb.one<{ id: number }>(
      `INSERT INTO sessions (attempt_id, script_id, buyer_name, state, current_seq, total_questions, questions, last_buyer_at)
       VALUES ($1, 1, '模型买家', 'serving', 1, 1, $2::jsonb, now()) RETURNING id`,
      [attempt.id, JSON.stringify([question])],
    );
    await sharedDb.query(`INSERT INTO messages (session_id, sender, content, seq, rule_result) VALUES ($1,'buyer',$2,1,$3::jsonb)`,
      [session.id, question.question, JSON.stringify({ responseRoundStart: true })]);
    const reception = app.get(ReceptionService);
    const oldGlm = process.env.GLM_API_KEY;
    const oldDeepseek = process.env.DEEPSEEK_API_KEY;
    process.env.GLM_API_KEY = 'test-glm';
    process.env.DEEPSEEK_API_KEY = 'test-deepseek';
    const fetchMock = jest.spyOn(global, 'fetch');
    try {
      fetchMock.mockResolvedValueOnce({ ok: false } as Response).mockResolvedValueOnce({ ok: false } as Response);
      await expect(reception.sendMessage(1, attempt.id, session.id, '我帮您核实一下。')).rejects.toThrow('模型服务不可用');
      const failed = await sharedDb.one<{ count: string }>(`SELECT count(*)::text AS count FROM messages WHERE session_id = $1 AND sender = 'agent'`, [session.id]);
      expect(Number(failed.count)).toBe(0);
      fetchMock.mockResolvedValueOnce({ ok: false } as Response).mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ resolved: false, reason: '还需确认洗涤方式', matchedPoints: [], buyerReply: '那洗标上怎么写呢？' }) } }] }) } as Response);
      const reply = await reception.sendMessage(1, attempt.id, session.id, '我帮您核实一下。');
      expect(reply.ruleResult.modelEvaluation).toMatchObject({ provider: 'deepseek', resolved: false });
      await reception.advanceAfterReply(session.id);
      const buyer = await sharedDb.one<{ content: string }>(`SELECT content FROM messages WHERE session_id = $1 AND sender = 'buyer' ORDER BY id DESC LIMIT 1`, [session.id]);
      expect(buyer.content).toBe('那洗标上怎么写呢？');
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ resolved: true, reason: '已明确说明洗涤依据', matchedPoints: [], buyerReply: '好的，明白了。' }) } }] }) } as Response);
      const resolved = await reception.sendMessage(1, attempt.id, session.id, '以衣服洗标为准。');
      expect(resolved.ruleResult.modelEvaluation).toMatchObject({ provider: 'glm', resolved: true });
      expect(resolved.ruleResult.hitPoints).toContain('洗标');
      await reception.advanceAfterReply(session.id);
      const followup = await sharedDb.many<{ content: string; seq: number }>(`SELECT content, seq FROM messages WHERE session_id = $1 AND sender = 'buyer' ORDER BY id`, [session.id]);
      expect(followup.some((m) => m.seq > 1 && m.content === '好的，明白了。')).toBe(true);
    } finally {
      (reception as any).scheduler.cancel(`next:${session.id}`);
      fetchMock.mockRestore();
      if (oldGlm === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = oldGlm;
      if (oldDeepseek === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = oldDeepseek;
      await sharedDb.query(`UPDATE attempts SET status = 'finished' WHERE id = $1`, [attempt.id]);
    }
  });

  it('账号停用及管理员重置密码后旧令牌不能访问业务接口', async () => {
    const token = await login('agent2', 'Agent@123');
    const auth = `Bearer ${token}`;
    try {
      await sharedDb.query(`UPDATE accounts SET status = 0 WHERE username = $1`, ['agent2']);
      const disabled = await request(http).get('/api/records').set('Authorization', auth);
      expect(disabled.body.code).not.toBe(0);
      await sharedDb.query(`UPDATE accounts SET status = 1, must_change_password = true WHERE username = $1`, ['agent2']);
      const restricted = await request(http).get('/api/records').set('Authorization', auth);
      expect(restricted.body.code).not.toBe(0);
      const profile = await request(http).get('/api/auth/profile').set('Authorization', auth);
      expect(profile.body.code).toBe(0);
    } finally {
      await sharedDb.query(`UPDATE accounts SET status = 1, must_change_password = false WHERE username = $1`, ['agent2']);
    }
  });

  it('退出后旧令牌失效，新登录令牌仍可使用', async () => {
    const oldToken = await login('agent2', 'Agent@123');
    const port = (http.address() as any).port as number;
    const socket = io(`http://127.0.0.1:${port}`, { path: '/realtime', auth: { token: oldToken }, transports: ['websocket'], reconnection: false });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('实时连接超时')), 5000);
      socket.on('reception.connected', () => { clearTimeout(timer); resolve(); });
    });
    const disconnected = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('实时连接未断开')), 5000);
      socket.on('disconnect', () => { clearTimeout(timer); resolve(); });
    });
    const response = await request(http).post('/api/auth/logout').set('Authorization', `Bearer ${oldToken}`);
    expect(response.body.code).toBe(0);
    await disconnected;
    socket.close();
    const stale = await request(http).get('/api/records').set('Authorization', `Bearer ${oldToken}`);
    expect(stale.body.code).not.toBe(0);
    const newToken = await login('agent2', 'Agent@123');
    const fresh = await request(http).get('/api/records').set('Authorization', `Bearer ${newToken}`);
    expect(fresh.body.code).toBe(0);
  });

  it('客服回复后的问题推送使用接待参数快照，并拒绝无效的推送间隔', async () => {
    const token = await login('admin', 'Admin@123');
    const auth = `Bearer ${token}`;
    const invalid = await request(http).put('/api/settings').set('Authorization', auth).send({ questionPushDelaySec: [8, 2] });
    expect(invalid.body.code).not.toBe(0);
    const saved = await request(http).put('/api/settings').set('Authorization', auth).send({ questionPushDelaySec: [12, 12] });
    expect(saved.body.data.questionPushDelaySec).toEqual([12, 12]);
    const attempt = await sharedDb.one<{ id: number }>(
      `INSERT INTO attempts (attempt_no, account_id, level, source, param_snapshot) VALUES ($1, 1, 'L1', 'free', $2::jsonb) RETURNING id`,
      ['AT-push-delay', JSON.stringify({ ...DEFAULT_PARAMS, questionPushDelaySec: [2, 2] })],
    );
    const session = await sharedDb.one<{ id: number }>(
      `INSERT INTO sessions (attempt_id, script_id, buyer_name, state, current_seq, total_questions, questions, last_buyer_at)
       VALUES ($1, 1, '测试买家', 'serving', 1, 1, $2::jsonb, now()) RETURNING id`,
      [attempt.id, JSON.stringify([{ seq: 1, question: '是什么面料？', keyPoints: ['纯棉'], stage: 'presale' }])],
    );
    const reception = app.get(ReceptionService);
    const schedule = jest.spyOn((reception as any).scheduler, 'schedule');
    try {
      await reception.sendMessage(1, attempt.id, session.id, '亲，这款是纯棉的。');
      expect(schedule).toHaveBeenCalledWith(`next:${session.id}`, 2000, expect.any(Function));
    } finally {
      (reception as any).scheduler.cancel(`next:${session.id}`);
      schedule.mockRestore();
      await sharedDb.query(`UPDATE attempts SET status = 'finished' WHERE id = $1`, [attempt.id]);
      await request(http).put('/api/settings').set('Authorization', auth).send({ questionPushDelaySec: [3, 7] });
    }
  });

  it('旧单题剧本至少推送三轮，再进入客服整理阶段', async () => {
    const attempt = await sharedDb.one<{ id: number }>(
      `INSERT INTO attempts (attempt_no, account_id, level, source, param_snapshot) VALUES ($1, $2, 'L1', 'free', $3::jsonb) RETURNING id`,
      ['AT-min-round-regression', 1, JSON.stringify(DEFAULT_PARAMS)],
    );
    const questions = [{ seq: 1, question: '这件衣服是什么面料？', keyPoints: ['面料'], stage: 'presale' }];
    const session = await sharedDb.one<{ id: number }>(
      `INSERT INTO sessions (attempt_id, script_id, buyer_name, state, current_seq, total_questions, questions)
       VALUES ($1, $2, $3, 'serving', 1, 1, $4::jsonb) RETURNING id`,
      [attempt.id, 1, '测试买家', JSON.stringify(questions)],
    );
    const reception = app.get(ReceptionService);
    await reception.pushNextQuestion(session.id);
    let row = await sharedDb.one<any>(`SELECT current_seq, total_questions, state, questions FROM sessions WHERE id = $1`, [session.id]);
    expect(row.current_seq).toBe(2);
    expect(row.state).toBe('serving');
    await reception.pushNextQuestion(session.id);
    row = await sharedDb.one<any>(`SELECT current_seq, total_questions, state, questions FROM sessions WHERE id = $1`, [session.id]);
    expect(row.current_seq).toBe(3);
    expect(row.questions).toHaveLength(3);
    expect(row.questions[1].question).not.toBe(row.questions[2].question);
    await reception.pushNextQuestion(session.id);
    row = await sharedDb.one<any>(`SELECT current_seq, state FROM sessions WHERE id = $1`, [session.id]);
    expect(row.state).toBe('awaiting_agent_close');
    await reception.pushNextQuestion(session.id);
    expect((await sharedDb.one<any>(`SELECT state FROM sessions WHERE id = $1`, [session.id])).state).toBe('awaiting_agent_close');
    await sharedDb.query(`UPDATE attempts SET status = 'finished' WHERE id = $1`, [attempt.id]);
  }, 60000);

  it('开场问候计首响，正式首题单独计入平均响应', async () => {
    const attempt = await sharedDb.one<{ id: number }>(
      `INSERT INTO attempts (attempt_no, account_id, level, source, param_snapshot)
       VALUES ($1, 1, 'L1', 'free', $2::jsonb) RETURNING id`,
      ['AT-opener-timing', JSON.stringify(DEFAULT_PARAMS)],
    );
    const questions = [{ seq: 1, question: '这款是什么面料？', keyPoints: ['面料'], stage: 'presale' }];
    const session = await sharedDb.one<{ id: number }>(
      `INSERT INTO sessions (attempt_id, script_id, buyer_name, state, current_seq, total_questions, questions, opener_pending, last_buyer_at)
       VALUES ($1, 1, '测试买家', 'serving', 0, 1, $2::jsonb, true, $3) RETURNING id`,
      [attempt.id, JSON.stringify(questions), new Date(Date.now() - 4000).toISOString()],
    );
    const reception = app.get(ReceptionService);
    const opening = await reception.sendMessage(1, attempt.id, session.id, '亲您好，我在的，请问有什么可以帮您？');
    expect(opening.responseSec).toBeGreaterThanOrEqual(3);
    await sharedDb.query(`UPDATE sessions SET state = 'serving', opener_pending = false, current_seq = 1, last_buyer_at = $2 WHERE id = $1`,
      [session.id, new Date(Date.now() - 12000).toISOString()]);
    const reply = await reception.sendMessage(1, attempt.id, session.id, '亲，这款面料是纯棉的。');
    expect(reply.responseSec).toBeGreaterThanOrEqual(11);
    await reception.finishSession(1, attempt.id, session.id);
    const result = await reception.attemptResult(attempt.id);
    expect(result.sessions[0].metrics.firstResponseSec).toBe(opening.responseSec);
    expect(result.sessions[0].metrics.avgResponseSec).toBe(reply.responseSec);
  }, 60000);

  it('并发买家显示在当前会话时分别计时，首条消息前回复也记录首次响应', async () => {
    const token = await login('admin', 'Admin@123');
    const start = await request(http).post('/api/receptions').set({ Authorization: `Bearer ${token}` })
      .send({ level: 'L2', source: 'free', totalCount: 2, concurrentCount: 2 });
    expect(start.body.code).toBe(0);
    const attemptId = start.body.data.attemptId;
    const reception = app.get(ReceptionService);
    try {
      await sleep(1500);
      const snapshot = await reception.snapshot(1, attemptId);
      expect(snapshot.sessions).toHaveLength(2);
      expect(snapshot.sessions.every((session: any) => session.waitedSec >= 1)).toBe(true);
      const waiting = snapshot.sessions.find((session: any) => session.state === 'wait');
      expect(waiting).toBeDefined();
      expect(snapshot.messages.some((message: any) => message.sessionId === waiting.sessionId && message.sender === 'buyer')).toBe(false);
      const reply = await reception.sendMessage(1, attemptId, waiting.sessionId, '亲您好，我在的，请问有什么可以帮您？');
      expect(reply.responseSec).toBeGreaterThanOrEqual(1);
      expect(reply.ruleResult.judge.signal).toBe('opener');
      await reception.advanceAfterReply(waiting.sessionId);
      const after = await reception.snapshot(1, attemptId);
      expect(after.sessions.find((session: any) => session.sessionId === waiting.sessionId).seq).toBe(1);
    } finally {
      await reception.finishAttempt(1, attemptId);
    }
  }, 60000);

  it('首条买家消息不会重置已进线等待时间，也不会重复记录超时', async () => {
    const attempt = await sharedDb.one<{ id: number }>(
      `INSERT INTO attempts (attempt_no, account_id, level, source, param_snapshot)
       VALUES ($1, 1, 'L1', 'free', $2::jsonb) RETURNING id`,
      ['AT-join-timeout', JSON.stringify({ ...DEFAULT_PARAMS, timeoutSec: 1, responseTimingVersion: 2 })],
    );
    const questions = [{ seq: 1, question: '这款是什么面料？', keyPoints: ['面料'], stage: 'presale' }];
    const session = await sharedDb.one<{ id: number }>(
      `INSERT INTO sessions (attempt_id, script_id, buyer_name, state, current_seq, total_questions, questions, last_buyer_at)
       VALUES ($1, 1, '计时买家', 'wait', 0, 1, $2::jsonb, $3) RETURNING id`,
      [attempt.id, JSON.stringify(questions), new Date(Date.now() - 5000).toISOString()],
    );
    const reception = app.get(ReceptionService);
    try {
      await (reception as any).scanTimeout();
      await reception.pushNextQuestion(session.id);
      await (reception as any).scanTimeout();
      const snapshot = await reception.snapshot(1, attempt.id);
      const buyer = snapshot.sessions.find((item: any) => item.sessionId === session.id);
      expect(buyer.waitedSec).toBeGreaterThanOrEqual(5);
      expect(buyer.timeoutCount).toBe(1);
      const reply = await reception.sendMessage(1, attempt.id, session.id, '亲您好，我在的，请问有什么可以帮您？');
      expect(reply.responseSec).toBeGreaterThanOrEqual(5);
      await reception.finishSession(1, attempt.id, session.id);
      const result = await reception.attemptResult(attempt.id);
      expect(result.sessions[0].metrics.timeoutCount).toBe(1);
    } finally {
      await sharedDb.query(`UPDATE attempts SET status = 'finished' WHERE id = $1`, [attempt.id]);
    }
  }, 60000);

  it('新接待将同一问题的买家追问单独计时，客服连发不重复计时', async () => {
    const attempt = await sharedDb.one<{ id: number }>(
      `INSERT INTO attempts (attempt_no, account_id, level, source, param_snapshot)
       VALUES ($1, 1, 'L1', 'free', $2::jsonb) RETURNING id`,
      ['AT-followup-timing', JSON.stringify({ ...DEFAULT_PARAMS, timeoutSec: 2, responseTimingVersion: 2 })],
    );
    const question = { seq: 1, question: '这款是什么面料？', keyPoints: ['面料'], stage: 'presale' };
    const session = await sharedDb.one<{ id: number }>(
      `INSERT INTO sessions (attempt_id, script_id, buyer_name, state, current_seq, total_questions, questions, last_buyer_at)
       VALUES ($1, 1, '测试买家', 'serving', 1, 1, $2::jsonb, $3) RETURNING id`,
      [attempt.id, JSON.stringify([question]), new Date(Date.now() - 8000).toISOString()],
    );
    await sharedDb.query(
      `INSERT INTO messages (session_id, sender, content, seq, rule_result) VALUES ($1, 'buyer', $2, 1, $3::jsonb)`,
      [session.id, question.question, JSON.stringify({ responseRoundStart: true, responseRoundType: 'question' })],
    );
    const reception = app.get(ReceptionService);
    await (reception as any).scanTimeout();
    const first = await reception.sendMessage(1, attempt.id, session.id, '亲，这款面料需要帮您核实一下。');
    await (reception as any).pushFollowUp(session.id, await (reception as any).loadSession(session.id), question, 0);
    await sharedDb.query(`UPDATE sessions SET last_buyer_at = $2 WHERE id = $1`,
      [session.id, new Date(Date.now() - 12000).toISOString()]);
    await (reception as any).scanTimeout();
    const followup = await reception.sendMessage(1, attempt.id, session.id, '亲，这款面料是纯棉的。');
    const extra = await reception.sendMessage(1, attempt.id, session.id, '感谢您的咨询。');
    expect(first.responseSec).toBeGreaterThanOrEqual(7);
    expect(followup.responseSec).toBeGreaterThanOrEqual(11);
    expect(extra.responseSec).toBeNull();
    await reception.finishSession(1, attempt.id, session.id);
    const result = await reception.attemptResult(attempt.id);
    expect(result.sessions[0].metrics.avgResponseSec).toBe(Math.round((first.responseSec + followup.responseSec) / 2));
    expect(result.sessions[0].metrics.timeoutCount).toBe(2);
    expect(result.sessions[0].timeoutCount).toBe(2);
  }, 60000);

  it('新接待的情绪升级消息等待客服回复并单独计时', async () => {
    const attempt = await sharedDb.one<{ id: number }>(
      `INSERT INTO attempts (attempt_no, account_id, level, source, param_snapshot)
       VALUES ($1, 1, 'L1', 'free', $2::jsonb) RETURNING id`,
      ['AT-escalation-timing', JSON.stringify({ ...DEFAULT_PARAMS, responseTimingVersion: 2 })],
    );
    const question = { seq: 1, question: '这款是什么面料？', keyPoints: ['面料'], stage: 'presale' };
    const session = await sharedDb.one<{ id: number }>(
      `INSERT INTO sessions (attempt_id, script_id, buyer_name, state, current_seq, total_questions, questions, last_buyer_at, emotion_value)
       VALUES ($1, 1, '测试买家', 'serving', 1, 1, $2::jsonb, $3, 79) RETURNING id`,
      [attempt.id, JSON.stringify([question]), new Date(Date.now() - 3000).toISOString()],
    );
    await sharedDb.query(
      `INSERT INTO messages (session_id, sender, content, seq, rule_result) VALUES ($1, 'buyer', $2, 1, $3::jsonb)`,
      [session.id, question.question, JSON.stringify({ responseRoundStart: true, responseRoundType: 'question' })],
    );
    const reception = app.get(ReceptionService);
    await reception.sendMessage(1, attempt.id, session.id, '不知道，你自己看吧');
    const afterEscalation = await sharedDb.one<{ state: string }>(`SELECT state FROM sessions WHERE id = $1`, [session.id]);
    expect(afterEscalation.state).toBe('serving');
    await sharedDb.query(`UPDATE sessions SET last_buyer_at = $2 WHERE id = $1`,
      [session.id, new Date(Date.now() - 7000).toISOString()]);
    const reply = await reception.sendMessage(1, attempt.id, session.id, '很抱歉给您带来不便，我帮您处理。');
    expect(reply.responseSec).toBeGreaterThanOrEqual(6);
    await reception.finishSession(1, attempt.id, session.id);
    const result = await reception.attemptResult(attempt.id);
    expect(result.sessions[0].metrics.avgResponseSec).toBeGreaterThanOrEqual(4);
  }, 60000);

  it('洗标待核实回复不判敷衍，也不提前完成语义目标', async () => {
    const attempt = await sharedDb.one<{ id: number }>(
      `INSERT INTO attempts (attempt_no, account_id, level, source, param_snapshot)
       VALUES ($1, 1, 'L1', 'free', $2::jsonb) RETURNING id`,
      ['AT-pending-verification', JSON.stringify(DEFAULT_PARAMS)],
    );
    const questions = [{ seq: 1, question: '能机洗吗？', keyPoints: ['机洗'], stage: 'presale',
      semanticGoals: [{ id: 'wash', name: '说明是否机洗', requiredPoints: [{ id: 'machine', label: '机洗', matchAny: ['机洗'] }] }] }];
    const session = await sharedDb.one<{ id: number }>(
      `INSERT INTO sessions (attempt_id, script_id, buyer_name, state, current_seq, total_questions, questions, last_buyer_at)
       VALUES ($1, 1, '测试买家', 'serving', 1, 1, $2::jsonb, $3) RETURNING id`,
      [attempt.id, JSON.stringify(questions), new Date().toISOString()],
    );
    const reception = app.get(ReceptionService);
    const reply = await reception.sendMessage(1, attempt.id, session.id, '亲您好，是否可以机洗请以衣服洗标为准，我可以帮您核实水洗方式。');
    expect(reply.ruleResult.judge.signal).toBe('hedge');
    expect(reply.ruleResult.hitPoints).toEqual([]);
    expect(reply.ruleResult.goalProgress[0].status).toBe('untriggered');
    await reception.finishSession(1, attempt.id, session.id);
    const score = await sharedDb.one<{ solving_score: string }>(`SELECT solving_score FROM scores WHERE session_id = $1`, [session.id]);
    expect(Number(score.solving_score)).toBe(17.5);
  }, 60000);

  it('明确支持机洗后不把水洗列为缺失或再次追问', async () => {
    const attempt = await sharedDb.one<{ id: number }>(
      `INSERT INTO attempts (attempt_no, account_id, level, source, param_snapshot) VALUES ($1, 1, 'L1', 'free', $2::jsonb) RETURNING id`,
      ['AT-wash-meaning', JSON.stringify(DEFAULT_PARAMS)],
    );
    const questions = [{ seq: 1, question: '能机洗吗？', keyPoints: ['洗涤', '机洗', '水洗'], stage: 'presale' }];
    const session = await sharedDb.one<{ id: number }>(
      `INSERT INTO sessions (attempt_id, script_id, buyer_name, state, current_seq, total_questions, questions, last_buyer_at)
       VALUES ($1, 1, '测试买家', 'serving', 1, 1, $2::jsonb, now()) RETURNING id`,
      [attempt.id, JSON.stringify(questions)],
    );
    const reception = app.get(ReceptionService);
    try {
      const reply = await reception.sendMessage(1, attempt.id, session.id, '亲亲，这款是支持机洗的哦，建议您在清洗的时候，将衣服翻面进行清洗');
      expect(reply.ruleResult.missingPoints).not.toContain('水洗');
      expect(reply.ruleResult.hitPoints).toContain('水洗');
      await reception.advanceAfterReply(session.id);
      const pushed = await sharedDb.many<{ content: string }>(`SELECT content FROM messages WHERE session_id = $1 AND sender = 'buyer'`, [session.id]);
      expect(pushed.some((row) => /确认一下水洗/u.test(row.content))).toBe(false);
    } finally {
      (reception as any).scheduler.cancel(`next:${session.id}`);
      await sharedDb.query(`UPDATE attempts SET status = 'finished' WHERE id = $1`, [attempt.id]);
    }
  });

  it('自动判断不把无关表态当成解答，机洗已答复后跳过简单水洗重复问题', async () => {
    const attempt = await sharedDb.one<{ id: number }>(
      `INSERT INTO attempts (attempt_no, account_id, level, source, param_snapshot) VALUES ($1, 1, 'L1', 'free', $2::jsonb) RETURNING id`,
      ['AT-auto-wash', JSON.stringify(DEFAULT_PARAMS)],
    );
    const questions = [
      { seq: 1, question: '能机洗吗？', keyPoints: [], automaticEvaluation: true },
      { seq: 2, question: '能水洗吗？', keyPoints: [], automaticEvaluation: true },
      { seq: 3, question: '有现货吗？', keyPoints: [], automaticEvaluation: true },
    ];
    const session = await sharedDb.one<{ id: number }>(
      `INSERT INTO sessions (attempt_id, script_id, buyer_name, state, current_seq, total_questions, questions, last_buyer_at)
       VALUES ($1, 1, '测试买家', 'serving', 1, 3, $2::jsonb, now()) RETURNING id`,
      [attempt.id, JSON.stringify(questions)],
    );
    const reception = app.get(ReceptionService);
    try {
      const unrelated = await reception.sendMessage(1, attempt.id, session.id, '亲，这款支持退货');
      expect(unrelated.ruleResult.judge.pass).toBe(false);
      const answer = await reception.sendMessage(1, attempt.id, session.id, '亲亲，这款是支持机洗的哦，建议您在清洗的时候，将衣服翻面进行清洗');
      expect(answer.ruleResult.judge.pass).toBe(true);
      await reception.advanceAfterReply(session.id);
      const state = await sharedDb.one<{ current_seq: number; skipped_seqs: number[] }>(`SELECT current_seq, skipped_seqs FROM sessions WHERE id = $1`, [session.id]);
      expect(state.current_seq).toBe(3);
      expect(state.skipped_seqs).toContain(2);
    } finally {
      (reception as any).scheduler.cancel(`next:${session.id}`);
      await sharedDb.query(`UPDATE attempts SET status = 'finished' WHERE id = $1`, [attempt.id]);
    }
  }, 60000);

  it('已明确说明发货时间时跳过等价追问', async () => {
    const attempt = await sharedDb.one<{ id: number }>(
      `INSERT INTO attempts (attempt_no, account_id, level, source, param_snapshot) VALUES ($1, 1, 'L1', 'free', $2::jsonb) RETURNING id`,
      ['AT-auto-shipping', JSON.stringify({ ...DEFAULT_PARAMS, replyJudgmentVersion: 1 })],
    );
    const questions = [
      { seq: 1, question: '这条裙子是现货吗，拍下后多久能发货', keyPoints: [], automaticEvaluation: true },
      { seq: 2, question: '那一般什么时候可以发出呢？', keyPoints: [], automaticEvaluation: true },
      { seq: 3, question: '发出后多久可以送达？', keyPoints: [], automaticEvaluation: true },
    ];
    const session = await sharedDb.one<{ id: number }>(
      `INSERT INTO sessions (attempt_id, script_id, buyer_name, state, current_seq, total_questions, questions, last_buyer_at)
       VALUES ($1, 1, '测试买家', 'serving', 1, 3, $2::jsonb, now()) RETURNING id`,
      [attempt.id, JSON.stringify(questions)],
    );
    const reception = app.get(ReceptionService);
    try {
      const reply = await reception.sendMessage(1, attempt.id, session.id, '亲，有现货，48小时内发货，具体以订单为准。');
      expect(reply.ruleResult.judge.pass).toBe(true);
      await reception.advanceAfterReply(session.id);
      const state = await sharedDb.one<{ current_seq: number; skipped_seqs: number[] }>(`SELECT current_seq, skipped_seqs FROM sessions WHERE id = $1`, [session.id]);
      expect(state.current_seq).toBe(3);
      expect(state.skipped_seqs).toContain(2);
    } finally {
      (reception as any).scheduler.cancel(`next:${session.id}`);
      await sharedDb.query(`UPDATE attempts SET status = 'finished' WHERE id = $1`, [attempt.id]);
    }
  }, 60000);

  it('自动判定与有效回复、计时和收尾使用一致口径', async () => {
    const params = { ...DEFAULT_PARAMS, responseTimingVersion: 2, replyJudgmentVersion: 1, invalidReplyEnabled: true,
      invalidReplyUnresolvedEnabled: true, invalidReplyUnresolvedStreak: 3 };
    const attempt = await sharedDb.one<{ id: number }>(
      `INSERT INTO attempts (attempt_no, account_id, level, source, param_snapshot) VALUES ($1, 1, 'L1', 'free', $2::jsonb) RETURNING id`,
      ['AT-auto-unified', JSON.stringify(params)],
    );
    const questions = [
      { seq: 1, question: '有现货吗？', keyPoints: [], automaticEvaluation: true },
      { seq: 2, question: '跳过的问题', keyPoints: [], automaticEvaluation: true },
      { seq: 3, question: '发出后大概多久能收到呢？', keyPoints: [], automaticEvaluation: true },
    ];
    const session = await sharedDb.one<{ id: number }>(
      `INSERT INTO sessions (attempt_id, script_id, buyer_name, state, current_seq, total_questions, questions, skipped_seqs, last_buyer_at, unresolved_streak)
       VALUES ($1, 1, '测试买家', 'serving', 3, 3, $2::jsonb, '[2]'::jsonb, $3, 2) RETURNING id`,
      [attempt.id, JSON.stringify(questions), new Date(Date.now() - 3000).toISOString()],
    );
    const reception = app.get(ReceptionService);
    try {
      await sharedDb.query(`INSERT INTO messages (session_id, sender, content, seq, rule_result) VALUES
        ($1,'agent','有现货',1,$2::jsonb), ($1,'buyer','发出后大概多久能收到呢？',3,$3::jsonb)`,
      [session.id, JSON.stringify({ questionSeq: 1, judgmentVersion: 1, judge: { pass: true, signal: 'key-point' } }), JSON.stringify({ responseRoundStart: true })]);
      const reply = await reception.sendMessage(1, attempt.id, session.id, '亲，发出后一般2到4天送达，偏远地区可能稍久。');
      expect(reply.ruleResult.judge.pass).toBe(true);
      expect((reply.ruleResult as any).invalid).not.toBe(true);
      expect(reply.responseSec).toBeGreaterThanOrEqual(2);
      expect(reply.ruleResult.conversationState.resolvedGoalIds).toContain('keyword-seq-3');
      await sharedDb.query(`UPDATE sessions SET state = 'awaiting_agent_close', emotion_value = 75, unresolved_streak = 3 WHERE id = $1`, [session.id]);
      const closing = await reception.sendMessage(1, attempt.id, session.id, '感谢您的咨询，祝您生活愉快，再见！');
      expect(closing.ruleResult.judge.signal).toBe('closing');
      expect(closing.ruleResult.emotionValue).toBe(75);
      expect(closing.ruleResult.emotionDelta).toBe(0);
      expect(closing.ruleResult.escalated).toBe(false);
      expect(closing.responseSec).toBeNull();
    } finally {
      (reception as any).scheduler.cancel(`next:${session.id}`);
      (reception as any).scheduler.cancel(`close:${session.id}`);
      await sharedDb.query(`UPDATE attempts SET status = 'finished' WHERE id = $1`, [attempt.id]);
    }
  }, 60000);

  it('新会话中待核实答复计时且给部分分，但仍追问而非判为解决', async () => {
    const params = { ...DEFAULT_PARAMS, responseTimingVersion: 2, replyJudgmentVersion: 1,
      invalidReplyEnabled: true, invalidReplyUnresolvedEnabled: true, invalidReplyUnresolvedStreak: 1 };
    const attempt = await sharedDb.one<{ id: number }>(
      `INSERT INTO attempts (attempt_no, account_id, level, source, param_snapshot) VALUES ($1, 1, 'L1', 'free', $2::jsonb) RETURNING id`,
      ['AT-auto-pending-new', JSON.stringify(params)],
    );
    const session = await sharedDb.one<{ id: number }>(
      `INSERT INTO sessions (attempt_id, script_id, buyer_name, state, current_seq, total_questions, questions, last_buyer_at)
       VALUES ($1, 1, '测试买家', 'serving', 1, 1, $2::jsonb, $3) RETURNING id`,
      [attempt.id, JSON.stringify([{ seq: 1, question: '能机洗吗？', keyPoints: [], automaticEvaluation: true }]), new Date(Date.now() - 3000).toISOString()],
    );
    const reception = app.get(ReceptionService);
    try {
      await sharedDb.query(`INSERT INTO messages (session_id, sender, content, seq, rule_result) VALUES ($1,'buyer','能机洗吗？',1,$2::jsonb)`,
        [session.id, JSON.stringify({ responseRoundStart: true })]);
      const response = await reception.sendMessage(1, attempt.id, session.id, '亲，我先帮您核实洗标，确认后回复您。');
      expect(response.responseSec).toBeGreaterThanOrEqual(2);
      expect(response.ruleResult.pendingVerification).toBe(true);
      expect(response.ruleResult.judge.pass).toBe(false);
      expect(response.ruleResult.conversationState.resolvedGoalIds).not.toContain('keyword-seq-1');
      await reception.advanceAfterReply(session.id);
      const buyer = await sharedDb.one<{ content: string }>(`SELECT content FROM messages WHERE session_id = $1 AND sender = 'buyer' ORDER BY id DESC LIMIT 1`, [session.id]);
      expect(buyer.content).toContain('确认');
      await reception.finishSession(1, attempt.id, session.id);
      const score = await sharedDb.one<{ solving_score: string }>(`SELECT solving_score FROM scores WHERE session_id = $1`, [session.id]);
      expect(Number(score.solving_score)).toBe(17.5);
    } finally {
      (reception as any).scheduler.cancel(`next:${session.id}`);
      await sharedDb.query(`UPDATE attempts SET status = 'finished' WHERE id = $1`, [attempt.id]);
    }
  }, 60000);

  it('新版意图判断接受模糊实质回复，拒绝纯等待，并保持部分分与追问一致', async () => {
    const params = { ...DEFAULT_PARAMS, replyJudgmentVersion: 2, responseTimingVersion: 2,
      invalidReplyEnabled: true, invalidReplyUnresolvedEnabled: true, invalidReplyUnresolvedStreak: 1 };
    const attempt = await sharedDb.one<{ id: number }>(
      `INSERT INTO attempts (attempt_no, account_id, level, source, param_snapshot) VALUES ($1, 1, 'L1', 'free', $2::jsonb) RETURNING id`,
      ['AT-intent-v2', JSON.stringify(params)],
    );
    const reception = app.get(ReceptionService);
    const ids: number[] = [];
    const cases = [
      ['要不要干洗', '不用那么麻烦，按平常洗衣方式轻柔洗就行', true],
      ['尺码不合适可以换吗', '可以的，留好吊牌就好', true],
      ['买家秀在哪里看', '往评价区翻翻，选晒图就能看大家发的图', true],
      ['色差大吗', '差不多的，手机屏幕看会有一点区别', true],
      ['实物和详情页图片色差大吗', '亲，图片光线和屏幕可能产生细微色差，一般情况是不影响日常使用的，如果您收到货后感觉不合适可以随时联系我们哈，我们家支持7天无理由的。', true],
      ['要不要干洗', '我核实一下', false],
      ['色差大吗', '稍等', false],
      ['买家秀和实拍视频分别在哪里看', '买家秀在评价区看晒图', false],
      ['梨形身材怎么选尺码', '亲，158厘米92斤可以参考M码', false],
      ['那我这个身材应该怎么选尺码呢？', '亲，可以先对照尺码表量一下腰围和臀围，也可以把身高体重告诉我，再帮您参考。', false],
      ['那一般什么时候可以发出呢？', '亲，有现货，拍下后通常48小时内发货，具体也看订单显示的时效。', true],
      ['发出后大概多久能收到呢？', '亲，发出后一般2到4天送达，偏远地区可能久一些。', true],
      ['发出后大概多久能收到呢？', '亲，付款后通常48小时内发货。', false],
      ['发出后在哪里查看物流进度呢？', '亲，在订单详情里选择查看物流，就可以看到物流进度。', true],
      ['走线整齐吗？', '针脚挺均匀的。', true],
      ['含棉量多少', '材质为其他纤维22%，商品详情未单独标注含棉量，可帮您确认。', true],
      ['含棉量多少', '商品页只标注材质其他纤维22%，确实无单独含棉量数据，暂时无法给准确数字。', true],
      ['适合搭配什么颜色的外套', '米色、卡其色、浅灰都很搭哦，温柔又显气质～', true],
      ['含棉量多少', '详情页没有明确含棉量，我可以核对成分标签后回复您。', true],
      ['走线整齐吗？', '现有资料无法确认，我帮您核对细节图上的缝线。', true],
      ['发出后在哪里查看物流进度呢？', '在我的订单打开这笔订单，点击查看物流，就能看到运单号和最新运输进度。', true],
      ['清洗后应该怎么晾晒这件衣服呢？', '洗后轻轻压出水分，整理裙型后在阴凉通风处悬挂晾干，尽量避免暴晒和用力拧干。', true],
      ['请问在哪里可以查看物流进度呢？', '亲，商品发出后在订单详情选择查看物流。', true],
      ['梨形身材选哪个码', '亲，按您提供的身高体重可以先参考M码，建议对照尺码表。', true],
      ['关于“梨形身材选哪个码”，还有哪些需要注意的呢？', '亲，建议量一下腰围和臀围，对照尺码表。', true],
      ['这条连衣裙搭配什么外套和鞋子好看', '亲，我先帮您核实这条连衣裙搭配什么外套和鞋子好看的具体情况，确认后再回复您。', false],
    ] as const;
    try {
      for (const [question, content, pass] of cases) {
        const session = await sharedDb.one<{ id: number }>(
          `INSERT INTO sessions (attempt_id, script_id, buyer_name, state, current_seq, total_questions, questions, last_buyer_at)
           VALUES ($1, 1, '测试买家', 'serving', 1, 1, $2::jsonb, $3) RETURNING id`,
          [attempt.id, JSON.stringify([{ seq: 1, question, keyPoints: question === '这条连衣裙搭配什么外套和鞋子好看' ? ['搭配'] : [], automaticEvaluation: true }]), new Date(Date.now() - 3000).toISOString()],
        );
        ids.push(session.id);
        if (question === '含棉量多少') {
          await sharedDb.query('UPDATE sessions SET products = $2::jsonb WHERE id = $1',
            [session.id, JSON.stringify([{ title: '连衣裙', attributes: [{ name: '材质', value: '其他22%' }] }])]);
        }

        await sharedDb.query(`INSERT INTO messages (session_id, sender, content, seq, rule_result) VALUES ($1,'buyer',$2,1,$3::jsonb)`,
          [session.id, question, JSON.stringify({ responseRoundStart: true })]);
        if (question === '实物和详情页图片色差大吗') {
          await sharedDb.query(
            `INSERT INTO messages (session_id, sender, content, seq, rule_result, created_at)
             VALUES ($1,'agent',$2,1,'{"openerTiming":true}'::jsonb, now() - interval '5 seconds')`,
            [session.id, content],
          );
        }
        const result = await reception.sendMessage(1, attempt.id, session.id, content);
        expect({ question, pass: result.ruleResult.judge.pass }).toEqual({ question, pass });
        if (pass) {
          expect((result.ruleResult as any).invalid).not.toBe(true);
          expect(result.responseSec).toBeGreaterThanOrEqual(2);
        }
        if (content === '针脚挺均匀的。') {
          expect(result.ruleResult.replyAssessment).toMatchObject({ status: 'resolved', acceptedGuidance: true });
          await sharedDb.query(
            `UPDATE messages SET rule_result = $2::jsonb WHERE session_id = $1 AND sender = 'agent'`,
            [session.id, JSON.stringify({ ...result.ruleResult, modelEvaluation: { resolved: false, buyerReply: '我是想问走线整齐吗？' } })]);
          await reception.advanceAfterReply(session.id);
          const state = await sharedDb.one<{ follow_ups: number }>('SELECT follow_ups FROM sessions WHERE id = $1', [session.id]);
          expect(Number(state?.follow_ups)).toBe(0);
        }
        if (question === '含棉量多少' || question === '适合搭配什么颜色的外套') {
          expect(result.ruleResult.replyAssessment?.status).toBe('resolved');
          expect(result.ruleResult.conversationState.resolvedGoalIds).toContain('keyword-seq-1');
          await reception.advanceAfterReply(session.id);
          const followUp = await sharedDb.one<{ count: string }>(
            "SELECT count(*) FROM messages WHERE session_id = $1 AND sender = 'buyer' AND content LIKE $2",
            [session.id, `%我是想问%${question}%`]);
          expect(Number(followUp?.count)).toBe(0);
        }
        if (question === '实物和详情页图片色差大吗') {
          expect(result.ruleResult.replyAssessment?.status).toBe('resolved');
          expect(result.ruleResult.replyAssessment?.evidence?.join('')).toContain('细微色差');
          expect(result.ruleResult.conversationState.resolvedGoalIds).toContain('keyword-seq-1');
          await reception.finishSession(1, attempt.id, session.id);
          const score = await sharedDb.one<{ solving_score: string }>(`SELECT solving_score FROM scores WHERE session_id = $1`, [session.id]);
          expect(Number(score!.solving_score)).toBe(35);
        }
        if (question === '发出后大概多久能收到呢？' && content.includes('48小时')) {
          expect(['unsupported', 'unanswered']).toContain(result.ruleResult.replyAssessment?.status);
          expect(result.ruleResult.judge.pass).toBe(false);
        }
        if (question === '这条连衣裙搭配什么外套和鞋子好看') {
          expect(result.ruleResult.replyAssessment?.status).toBe('unanswered');
          expect(result.ruleResult.pendingVerification).not.toBe(true);
          expect(result.ruleResult.hitPoints).toEqual([]);
          expect(result.ruleResult.conversationState.resolvedGoalIds).not.toContain('keyword-seq-1');
        }
        if (question.includes('这个身材')) {
          expect(result.ruleResult.replyAssessment?.status).toBe('partial');
          expect(result.ruleResult.conversationState.resolvedGoalIds).not.toContain('keyword-seq-1');
          await reception.advanceAfterReply(session.id);
          const buyer = await sharedDb.one<{ content: string }>(`SELECT content FROM messages WHERE session_id = $1 AND sender = 'buyer' ORDER BY id DESC LIMIT 1`, [session.id]);
          expect(buyer.content).toMatch(/身高\d+厘米，体重\d+斤/u);
          await reception.finishSession(1, attempt.id, session.id);
          const score = await sharedDb.one<{ solving_score: string }>(`SELECT solving_score FROM scores WHERE session_id = $1`, [session.id]);
          expect(Number(score.solving_score)).toBe(17.5);
        }
        if (question.includes('分别')) {
          expect(result.ruleResult.replyAssessment?.status).toBe('partial');
          expect(result.responseSec).toBeGreaterThanOrEqual(2);
          await reception.advanceAfterReply(session.id);
          const buyer = await sharedDb.one<{ content: string }>(`SELECT content FROM messages WHERE session_id = $1 AND sender = 'buyer' ORDER BY id DESC LIMIT 1`, [session.id]);
          expect(buyer.content).toContain('视频');
          expect(buyer.content).not.toContain('买家秀');
          await reception.finishSession(1, attempt.id, session.id);
          const score = await sharedDb.one<{ solving_score: string }>(`SELECT solving_score FROM scores WHERE session_id = $1`, [session.id]);
          expect(Number(score.solving_score)).toBe(17.5);
        }
      }
    } finally {
      for (const id of ids) (reception as any).scheduler.cancel(`next:${id}`);
      await sharedDb.query(`UPDATE attempts SET status = 'finished' WHERE id = $1`, [attempt.id]);
    }
  }, 60000);

  it('新版模型不能把纯核实话术升级为已解决，并接收受限商品事实', async () => {
    const attempt = await sharedDb.one<{ id: number }>(
      `INSERT INTO attempts (attempt_no, account_id, level, source, param_snapshot) VALUES ($1, 1, 'L1', 'free', $2::jsonb) RETURNING id`,
      ['AT-model-evidence-v2', JSON.stringify({ ...DEFAULT_PARAMS, replyJudgmentVersion: 2 })],
    );
    const session = await sharedDb.one<{ id: number }>(
      `INSERT INTO sessions (attempt_id, script_id, buyer_name, state, current_seq, total_questions, questions, last_buyer_at)
       VALUES ($1, 1, '测试买家', 'serving', 1, 1, $2::jsonb, now()) RETURNING id`,
      [attempt.id, JSON.stringify([{ seq: 1, question: '要不要干洗', keyPoints: [], automaticEvaluation: true }])],
    );
    const keyMock = jest.spyOn(app.get(ModelCredentialsService), 'getKeys').mockResolvedValue({ glmKey: 'test' });
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
      resolved: true, reason: '已回复', matchedPoints: [], buyerReply: '好的', evidence: ['我核实一下'],
    }) } }] }) } as Response);
    const reception = app.get(ReceptionService);
    try {
      const result = await reception.sendMessage(1, attempt.id, session.id, '我核实一下');
      expect(result.ruleResult.judge.pass).toBe(false);
      expect(result.ruleResult.pendingVerification).not.toBe(true);
      expect(result.ruleResult.replyAssessment.status).toBe('unanswered');
      const requestBody = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
      const input = JSON.parse(requestBody.messages[1].content);
      expect(input.judgmentVersion).toBe(2);
      expect(input.facts).toBeDefined();
      expect(JSON.stringify(input)).not.toContain('receiver');
    } finally {
      keyMock.mockRestore(); fetchMock.mockRestore();
      (reception as any).scheduler.cancel(`next:${session.id}`);
      await sharedDb.query(`UPDATE attempts SET status = 'finished' WHERE id = $1`, [attempt.id]);
    }
  }, 60000);

  it('线上269回归：媒体口语回复可以解决原问题，下一轮不重复追问', async () => {
    const attempt = await sharedDb.one<{ id: number }>(
      `INSERT INTO attempts (attempt_no, account_id, level, source, param_snapshot) VALUES ($1, 1, 'L1', 'free', $2::jsonb) RETURNING id`,
      ['AT-media-269', JSON.stringify({ ...DEFAULT_PARAMS, replyJudgmentVersion: 2, responseTimingVersion: 2 })],
    );
    const questions = [
      { seq: 1, question: '有没有买家秀或者实拍视频可以看', keyPoints: [], automaticEvaluation: true },
      { seq: 2, question: '色差大吗', keyPoints: [], automaticEvaluation: true },
      { seq: 3, question: '如果尺码不合适，可以换吗', keyPoints: [], automaticEvaluation: true },
    ];
    const session = await sharedDb.one<{ id: number }>(
      `INSERT INTO sessions (attempt_id, script_id, buyer_name, state, current_seq, total_questions, questions, last_buyer_at)
       VALUES ($1, 1, '测试买家', 'serving', 1, 3, $2::jsonb, now()) RETURNING id`, [attempt.id, JSON.stringify(questions)],
    );
    const reception = app.get(ReceptionService);
    try {
      await sharedDb.query(`INSERT INTO messages (session_id, sender, content, seq) VALUES ($1,'buyer',$2,1)`, [session.id, questions[0].question]);
      const response = await reception.sendMessage(1, attempt.id, session.id,
        '亲，有的，详情里能看实拍图片，买家秀也可以在评价区找晒图看；视频请以实际页面为准。');
      expect(response.ruleResult.judge.pass).toBe(true);
      expect(response.ruleResult.conversationState.resolvedGoalIds).toContain('keyword-seq-1');
      await reception.advanceAfterReply(session.id);
      const state = await sharedDb.one<{ current_seq: number; follow_ups: number }>(`SELECT current_seq, follow_ups FROM sessions WHERE id = $1`, [session.id]);
      expect(state).toMatchObject({ current_seq: 2, follow_ups: 0 });
    } finally {
      (reception as any).scheduler.cancel(`next:${session.id}`);
      (reception as any).scheduler.cancel(`timeout:${session.id}`);
      await sharedDb.query(`UPDATE attempts SET status = 'finished' WHERE id = $1`, [attempt.id]);
    }
  }, 60000);

  it('相关补题耗尽时以自然转场补足最低轮次，并保留原问题未解决', async () => {
    const attempt = await sharedDb.one<{ id: number }>(
      `INSERT INTO attempts (attempt_no, account_id, level, source, param_snapshot) VALUES ($1, 1, 'L1', 'free', $2::jsonb) RETURNING id`,
      ['AT-cross-topic-exhausted', JSON.stringify({ ...DEFAULT_PARAMS, replyJudgmentVersion: 2, responseTimingVersion: 2 })],
    );
    const questions = [
      { seq: 1, question: '这件衣服可以机洗吗？', keyPoints: [], automaticEvaluation: true },
      { seq: 2, question: '清洗这件衣服时，水温有什么要求呢？', keyPoints: [], automaticEvaluation: true, derivedFromSeq: 1 },
    ];
    const session = await sharedDb.one<{ id: number }>(
      `INSERT INTO sessions (attempt_id, script_id, buyer_name, style_code, state, current_seq, total_questions, questions, last_buyer_at)
       VALUES ($1, 1, '测试买家', 'friendly', 'serving', 2, 2, $2::jsonb, now()) RETURNING id`, [attempt.id, JSON.stringify(questions)],
    );
    const reception = app.get(ReceptionService);
    try {
      await sharedDb.query(`INSERT INTO messages (session_id, sender, content, seq, rule_result) VALUES ($1,'agent',$2,1,$3::jsonb)`,
        [session.id, '我先核实洗标能否机洗，确认后回复您。', JSON.stringify({ questionSeq: 1, judgmentVersion: 2, pendingVerification: true, judge: { pass: false, signal: 'hedge' }, replyAssessment: { status: 'pending' } })]);
      await sharedDb.query(`INSERT INTO messages (session_id, sender, content, seq) VALUES ($1,'buyer',$2,2)`, [session.id, questions[1].question]);
      const reply = await reception.sendMessage(1, attempt.id, session.id, '亲，使用冷水清洗、晾晒时阴干，也可以用洗衣袋。');
      expect(reply.ruleResult.judge.pass).toBe(true);
      // 模拟模型同时返回另一道买家问题，跨话题补题不能把它并入同一轮。
      const savedReply = await sharedDb.one<{ id: number; rule_result: any }>(`SELECT id, rule_result FROM messages WHERE session_id = $1 AND sender = 'agent' ORDER BY id DESC LIMIT 1`, [session.id]);
      await sharedDb.query(`UPDATE messages SET rule_result = $2::jsonb WHERE id = $1`, [savedReply!.id, JSON.stringify({ ...savedReply!.rule_result, modelEvaluation: { resolved: true, buyerReply: '请问还有什么颜色？' } })]);
      await reception.advanceAfterReply(session.id);
      const state = await sharedDb.one<any>(`SELECT state, current_seq, questions, conversation_state FROM sessions WHERE id = $1`, [session.id]);
      expect(state.current_seq).toBe(3);
      expect(state.state).toBe('serving');
      expect(state.questions[2].topicTransition).toBe(true);
      expect(state.questions[2].question).toContain('发货');
      expect(state.conversation_state.unresolvedGoalIds).toContain('keyword-seq-1');
      const buyer = await sharedDb.one<{ content: string }>(`SELECT content FROM messages WHERE session_id = $1 AND sender = 'buyer' ORDER BY id DESC LIMIT 1`, [session.id]);
      expect(buyer!.content).toContain('对了，我还想顺便问一下');
      expect(buyer!.content).toContain(state.questions[2].question);
      const pushed = await sharedDb.many<{ content: string }>(`SELECT content FROM messages WHERE session_id = $1 AND sender = 'buyer' AND seq = 3 ORDER BY id`, [session.id]);
      expect(pushed).toHaveLength(1);
      expect(pushed[0].content).not.toContain('还有什么颜色');
      await reception.sendMessage(1, attempt.id, session.id, '亲，付款后48小时内发货。');
      await reception.advanceAfterReply(session.id);
      const after = await sharedDb.one<any>(`SELECT conversation_state FROM sessions WHERE id = $1`, [session.id]);
      expect(after.conversation_state.unresolvedGoalIds).toContain('keyword-seq-1');
      await reception.finishSession(1, attempt.id, session.id);
      const score = await sharedDb.one<{ solving_score: string }>(`SELECT solving_score FROM scores WHERE session_id = $1`, [session.id]);
      expect(Number(score!.solving_score)).toBe(29.2);
    } finally {
      (reception as any).scheduler.cancel(`next:${session.id}`);
      (reception as any).scheduler.cancel(`close:${session.id}`);
      (reception as any).scheduler.cancel(`timeout:${session.id}`);
      await sharedDb.query(`UPDATE attempts SET status = 'finished' WHERE id = $1`, [attempt.id]);
    }
  }, 60000);

  it.each([false, true])('资料不足控制重复核实；零追问且最后一题解决=%s 时仍保留原问题待核实状态', async (noFollowUps) => {
    const attempt = await sharedDb.one<{ id: number }>(
      `INSERT INTO attempts (attempt_no, account_id, level, source, param_snapshot) VALUES ($1, 1, 'L1', 'free', $2::jsonb) RETURNING id`,
      [`AT-pending-269-${noFollowUps}`,  JSON.stringify({ ...DEFAULT_PARAMS, replyJudgmentVersion: 2, responseTimingVersion: 2 })],
    );
    const questions = [
      { seq: 1, question: '含棉量多少', keyPoints: [], automaticEvaluation: true, conversationPlan: { maxFollowUps: noFollowUps ? 0 : 2 } },
      { seq: 2, question: '是聚酯纤维吗', keyPoints: [], automaticEvaluation: true, conversationPlan: { maxFollowUps: noFollowUps ? 0 : 2 } },
    ];
    const session = await sharedDb.one<{ id: number }>(
      `INSERT INTO sessions (attempt_id, script_id, buyer_name, state, current_seq, total_questions, questions, last_buyer_at)
       VALUES ($1, 1, '测试买家', 'serving', 1, 2, $2::jsonb, now()) RETURNING id`, [attempt.id, JSON.stringify(questions)],
    );
    const reception = app.get(ReceptionService);
    try {
      await sharedDb.query(`INSERT INTO messages (session_id, sender, content, seq) VALUES ($1,'buyer',$2,1)`, [session.id, questions[0].question]);
      for (const topic of ['含棉比例', '聚酯纤维成分', '成分标签位置']) {
        const resolved = noFollowUps && topic === '成分标签位置';
        const response = await reception.sendMessage(1, attempt.id, session.id, resolved
          ? '亲，面料成分标识可以在衣服内侧的洗标上查看。'
          : `亲，我先帮您核实${topic}，确认后回复准确结果。`);
        expect(response.ruleResult.replyAssessment.status).toBe(resolved ? 'resolved' : 'pending');
        await reception.advanceAfterReply(session.id);
        const state = await sharedDb.one<{ current_seq: number; follow_ups: number }>(`SELECT current_seq, follow_ups FROM sessions WHERE id = $1`, [session.id]);
        if (!noFollowUps) {
          expect(state!.follow_ups).toBe(1);
          await reception.sendMessage(1, attempt.id, session.id, `亲，目前还需要确认${topic}，我查一下对应标签再回复您。`);
          await reception.advanceAfterReply(session.id);
        } else {
          expect(state!.follow_ups).toBe(0);
        }
      }
      const state = await sharedDb.one<{ state: string; questions: any[]; conversation_state: any }>(`SELECT state, questions, conversation_state FROM sessions WHERE id = $1`, [session.id]);
      expect(state!.state).toBe('awaiting_agent_close');
      expect(state!.questions).toHaveLength(3);
      expect(state!.questions[2].question).toContain('查看面料成分标识');
      expect(state!.conversation_state.resolvedGoalIds).toEqual(noFollowUps ? ['keyword-seq-3'] : []);
      expect(state!.conversation_state.unresolvedGoalIds.length).toBeGreaterThan(0);
      const lastBuyer = await sharedDb.one<{ content: string }>(`SELECT content FROM messages WHERE session_id = $1 AND sender = 'buyer' ORDER BY id DESC LIMIT 1`, [session.id]);
      expect(lastBuyer!.content).toContain('还没有确认具体结果');
      await reception.finishSession(1, attempt.id, session.id);
      const score = await sharedDb.one<{ solving_score: string }>(`SELECT solving_score FROM scores WHERE session_id = $1`, [session.id]);
      expect(Number(score!.solving_score)).toBe(noFollowUps ? 23.3 : 17.5);
    } finally {
      (reception as any).scheduler.cancel(`next:${session.id}`);
      (reception as any).scheduler.cancel(`close:${session.id}`);
      (reception as any).scheduler.cancel(`timeout:${session.id}`);
      await sharedDb.query(`UPDATE attempts SET status = 'finished' WHERE id = $1`, [attempt.id]);
    }
  }, 60000);

  it('自动判断识别开放式问答、复合问题和表态对象', async () => {
    const attempt = await sharedDb.one<{ id: number }>(
      `INSERT INTO attempts (attempt_no, account_id, level, source, param_snapshot) VALUES ($1, 1, 'L1', 'free', $2::jsonb) RETURNING id`,
      ['AT-auto-examples', JSON.stringify({ ...DEFAULT_PARAMS, replyJudgmentVersion: 1 })],
    );
    const cases = [
      ['这条连衣裙搭配什么外套和鞋子好看', '亲，可以搭短款西装或针织开衫，鞋子搭乐福鞋或小白鞋。', true],
      ['这条连衣裙搭配什么外套和鞋子好看', '亲，外套可以搭针织开衫哦。', false],
      ['我158/92穿什么码', '亲，158厘米92斤可以先参考M码，建议对照尺码表。', true],
      ['这条裙子是现货吗，拍下后多久能发货', '亲，页面显示有现货，48小时内发货，具体以订单显示为准。', true],
      ['这条裙子是现货吗，拍下后多久能发货', '亲，这款有现货哦。', false],
      ['平时穿M你们家偏大吗', '亲，可以先参考M码，这款是A字版型，建议对照尺码表。', false],
      ['能机洗吗？', '我不确定能否机洗，先帮您核实洗标。', false],
    ] as const;
    const reception = app.get(ReceptionService);
    const sessions: number[] = [];
    try {
      for (const [question, content, passed] of cases) {
        const session = await sharedDb.one<{ id: number }>(
          `INSERT INTO sessions (attempt_id, script_id, buyer_name, state, current_seq, total_questions, questions, last_buyer_at)
           VALUES ($1, 1, '测试买家', 'serving', 1, 1, $2::jsonb, now()) RETURNING id`,
          [attempt.id, JSON.stringify([{ seq: 1, question, keyPoints: [], automaticEvaluation: true }])],
        );
        sessions.push(session.id);
        const result = await reception.sendMessage(1, attempt.id, session.id, content);
        expect({ question, pass: result.ruleResult.judge.pass }).toEqual({ question, pass: passed });
      }
    } finally {
      for (const id of sessions) (reception as any).scheduler.cancel(`next:${id}`);
      await sharedDb.query(`UPDATE attempts SET status = 'finished' WHERE id = $1`, [attempt.id]);
    }
  }, 60000);

  it('询问是否有内衬的待核实回复不提前完成语义目标', async () => {
    const attempt = await sharedDb.one<{ id: number }>(
      `INSERT INTO attempts (attempt_no, account_id, level, source, param_snapshot)
       VALUES ($1, 1, 'L1', 'free', $2::jsonb) RETURNING id`,
      ['AT-pending-lining', JSON.stringify(DEFAULT_PARAMS)],
    );
    const questions = [{ seq: 1, question: '有内衬吗？', keyPoints: ['内衬'], stage: 'presale',
      semanticGoals: [{ id: 'lining', name: '说明是否有内衬', requiredPoints: [{ id: 'has-lining', label: '内衬', matchAny: ['内衬'] }] }] }];
    const session = await sharedDb.one<{ id: number }>(
      `INSERT INTO sessions (attempt_id, script_id, buyer_name, state, current_seq, total_questions, questions, last_buyer_at)
       VALUES ($1, 1, '测试买家', 'serving', 1, 1, $2::jsonb, $3) RETURNING id`,
      [attempt.id, JSON.stringify(questions), new Date().toISOString()],
    );
    const reception = app.get(ReceptionService);
    const reply = await reception.sendMessage(1, attempt.id, session.id, '我帮您确认有没有内衬。');
    expect(reply.ruleResult.judge.signal).toBe('hedge');
    expect(reply.ruleResult.hitPoints).toEqual([]);
    expect(reply.ruleResult.goalProgress[0].status).toBe('untriggered');
    await reception.finishSession(1, attempt.id, session.id);
  }, 60000);

  it.each([['L1', 300], ['L2', 90], ['L3', 60], ['L4', 60]])(
    '%s 整理阶段按难度设置和重置倒计时',
    async (level, expectedSeconds) => {
      const attempt = await sharedDb.one<{ id: number }>(
        `INSERT INTO attempts (attempt_no, account_id, level, source, param_snapshot)
         VALUES ($1, 1, $2, 'free', $3::jsonb) RETURNING id`,
        [`AT-close-${level}`, level, JSON.stringify(DEFAULT_PARAMS)],
      );
      const session = await sharedDb.one<{ id: number }>(
        `INSERT INTO sessions (attempt_id, script_id, buyer_name, state, current_seq, total_questions, questions)
         VALUES ($1, 1, '测试买家', 'serving', 1, 1, $2::jsonb) RETURNING id`,
        [attempt.id, JSON.stringify([{ seq: 1, question: '面料是什么？', keyPoints: ['面料'], stage: 'presale' }])],
      );
      const reception = app.get(ReceptionService);
      const checkDeadline = async () => {
        const row = await sharedDb.one<{ state: string; close_deadline_at: string }>(
          `SELECT state, close_deadline_at FROM sessions WHERE id = $1`, [session.id],
        );
        expect(row.state).toBe('awaiting_agent_close');
        const seconds = (new Date(row.close_deadline_at).getTime() - Date.now()) / 1000;
        expect(seconds).toBeGreaterThan(expectedSeconds - 5);
        expect(seconds).toBeLessThanOrEqual(expectedSeconds + 1);
      };
      try {
        await (reception as any).enterAgentCloseWindow(session.id);
        await checkDeadline();
        await sharedDb.query(`UPDATE sessions SET close_deadline_at = $2 WHERE id = $1`, [session.id, new Date(Date.now() + 1000).toISOString()]);
        await reception.sendMessage(1, attempt.id, session.id, '好的亲，我帮您继续核实，谢谢您。');
        await checkDeadline();
      } finally {
        await sharedDb.query(`UPDATE sessions SET state = 'finished' WHERE id = $1`, [session.id]);
        await sharedDb.query(`UPDATE attempts SET status = 'finished' WHERE id = $1`, [attempt.id]);
      }
    },
    60000,
  );

  it('登录与鉴权：未登录访问被拦截，错误密码被拒绝', async () => {
    const unauthorized = await request(http).get('/api/products');
    expect(unauthorized.body.code).toBe(1002);

    const bad = await request(http).post('/api/auth/login').send({ username: 'agent', password: 'wrong' });
    expect(bad.body.code).toBe(1002);
  });

  it('难度解锁状态返回四档，且 L1 默认开放', async () => {
    const token = await login('agent', 'Agent@123');
    const res = await request(http).get('/api/receptions/levels').set('Authorization', `Bearer ${token}`);
    expect(res.body.code).toBe(0);
    expect(res.body.data).toHaveLength(4);
    expect(res.body.data[0]).toMatchObject({ code: 'L1', unlocked: true, concurrent: 1 });
    expect(res.body.data[3]).toMatchObject({ code: 'L4', concurrent: 4 });
  });

  it('完整跑通一次接待：进线推送 → 客服回复 → 规则判定 → 评分 → 明细落库', async () => {
    // 自由练习只对管理员/主管开放（客户新增需求）；这条链路与角色无关，用带教账号跑
    const token = await login('leader', 'Leader@123');
    const auth = { Authorization: `Bearer ${token}` };

    const start = await request(http).post('/api/receptions').set(auth).send({ level: 'L1' });
    expect(start.body.code).toBe(0);
    const attemptId = start.body.data.attemptId;
    // 客户 2026-10-03：合计接待人数默认 10 人 → L1 是「1 人接入 + 9 人排队」
    expect(start.body.data.sessions).toHaveLength(10);
    expect(start.body.data.sessions.filter((s: any) => s.state === 'wait')).toHaveLength(1);

    // 同一账号不允许并发开启第二次接待
    const duplicate = await request(http).post('/api/receptions').set(auth).send({ level: 'L2' });
    expect(duplicate.body.code).toBe(2001);

    await sleep(800);
    let snapshot = await request(http).get(`/api/receptions/${attemptId}/snapshot`).set(auth);
    expect(snapshot.body.code).toBe(0);
    const session = snapshot.body.data.sessions[0];
    expect(snapshot.body.data.messages.filter((m: any) => m.sender === 'buyer').length).toBeGreaterThan(0);
    expect(session.timeoutLimitSec).toBe(270); // L1 宽松口径：180 × 1.5

    const question = session.questions.find((q: any) => q.seq === session.seq) || session.questions[0];
    expect(session.questions.every((q: any) => q.automaticEvaluation && q.keyPoints.length === 0)).toBe(true);
    const reply = '亲，您好，可以的哦，还有其他可以帮您的吗？';
    const send = await request(http)
      .post(`/api/receptions/${attemptId}/sessions/${session.sessionId}/messages`)
      .set(auth)
      .send({ content: reply });
    if (send.body.code !== 0) {
      // eslint-disable-next-line no-console
      console.error('[debug] sendMessage 失败:', JSON.stringify(send.body));
    }
    expect(send.body.code).toBe(0);
    expect(send.body.data.ruleResult.judge).toBeDefined();

    const empty = await request(http)
      .post(`/api/receptions/${attemptId}/sessions/${session.sessionId}/messages`)
      .set(auth)
      .send({ content: '。。。' });
    expect(empty.body.code).toBe(1001);

    const finish = await request(http).post(`/api/receptions/${attemptId}/finish`).set(auth).send({});
    if (finish.body.code !== 0) {
      // eslint-disable-next-line no-console
      console.error('[debug] 结束接待失败:', JSON.stringify(finish.body));
    }
    expect(finish.body.code).toBe(0);
    expect(finish.body.data.totalScore).toBeGreaterThan(0);
    expect(['pass', 'fail']).toContain(finish.body.data.conclusion);
    expect(finish.body.data.sessions[0].responseScore).toBeGreaterThanOrEqual(0);

    const records = await request(http).get('/api/records').set(auth);
    if (records.body.code !== 0) {
      // eslint-disable-next-line no-console
      console.error('[debug] 明细列表失败:', JSON.stringify(records.body));
    }
    expect(records.body.code).toBe(0);
    expect(records.body.data.total).toBeGreaterThan(0);
    expect(records.body.data.list[0].attemptNo).toBe(finish.body.data.attemptNo);

    const detail = await request(http).get(`/api/records/${attemptId}`).set(auth);
    if (detail.body.code !== 0) {
      // eslint-disable-next-line no-console
      console.error('[debug] 明细详情失败:', JSON.stringify(detail.body));
    }
    expect(detail.body.code).toBe(0);
    expect(detail.body.data.messages.length).toBeGreaterThan(1);
    expect(detail.body.data.sessions[0].totalScore).not.toBeNull();

    // 批注属带教能力（方案 2.2），用主管身份写入
    const leaderToken = await login('leader', 'Leader@123');
    const annotation = await request(http)
      .post(`/api/records/${attemptId}/annotations`)
      .set({ Authorization: `Bearer ${leaderToken}` })
      .send({ sessionId: session.sessionId, content: '本次首响较快，但结束语可以更自然' });
    expect(annotation.body.code).toBe(0);
  }, 60000);

  it('剧本批量生成：背景 × 内容 交叉生成并按占比分配风格', async () => {
    const token = await login('admin', 'Admin@123');
    const auth = { Authorization: `Bearer ${token}` };
    const backgrounds = await request(http).get('/api/backgrounds?pageSize=3').set(auth);
    const contents = await request(http).get('/api/contents?pageSize=4').set(auth);
    /**
     * 客户 2026-10-03 起，批量生成会按「商品与内容是否匹配」自动配商品，
     * 因此这里取**全部上架商品**（覆盖 13 个品类），保证每条内容都能配到兼容商品、数量与断言一致。
     */
    const products = await request(http).get('/api/products?pageSize=300&status=1').set(auth);

    const res = await request(http)
      .post('/api/scripts/batch-generate')
      .set(auth)
      .send({
        bgIds: backgrounds.body.data.list.map((b: any) => b.id),
        qaIds: contents.body.data.list.map((c: any) => c.id),
        productIds: products.body.data.list.map((p: any) => p.id),
        seed: 20261001,
        autoSemanticGoals: true,
        semanticGoalsBySeq: {
          '1': [{
            id: 'shipping-status',
            name: '说明物流状态',
            requiredPoints: [{
              id: 'check-tracking',
              label: '说明会核实物流',
              matchAny: ['核实物流', '查询物流'],
            }],
          }],
        },
      });
    if (res.body.code !== 0) {
      // eslint-disable-next-line no-console
      console.error('[debug] 批量生成失败:', JSON.stringify(res.body));
    }
    expect(res.body.code).toBe(0);
    expect(res.body.data.total).toBe(12); // 3 × 4
    const counts = Object.values(res.body.data.distribution as Record<string, number>);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(12);
    // 自然对话优先：不再为了满足最低轮数强行补到 6 轮。
    expect(res.body.data.preview[0].rounds).toBeGreaterThanOrEqual(1);
    const created = await request(http).get(`/api/scripts/${res.body.data.preview[0].id}`).set(auth);
    expect(created.body.code).toBe(0);
    expect(created.body.data.questionSeq[0].semanticGoals[0].id).toBe('shipping-status');
    expect(created.body.data.questionSeq[0].sourceType).toBe('core');
    expect(created.body.data.questionSeq[0].question).not.toContain('另外');
    const primaryQuestions = created.body.data.questionSeq.filter((question: any) => question.goalPriority === 'primary');
    expect(primaryQuestions).toHaveLength(1);
    expect(primaryQuestions[0].primaryGoal).toBeTruthy();
    expect(created.body.data.customerGoal).toBeTruthy();
  }, 60000);

  it('沟通风格占比校验：总和超过 100% 被拦截', async () => {
    const token = await login('admin', 'Admin@123');
    const res = await request(http)
      .put('/api/styles/ratios')
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [
          { code: 'friendly', ratio: 60 },
          { code: 'impatient', ratio: 60 },
        ],
      });
    expect(res.body.code).toBe(3002);
  });

  it('权限隔离：客服不能创建商品，管理员可以', async () => {
    const agentToken = await login('agent', 'Agent@123');
    const denied = await request(http)
      .post('/api/products')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ productNo: 'TEST-1', title: '测试商品', price: 10 });
    expect(denied.body.code).toBe(1003);

    const adminToken = await login('admin', 'Admin@123');
    const created = await request(http)
      .post('/api/products')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ productNo: 'TEST-1', title: '测试商品', price: 10 });
    expect(created.body.code).toBe(0);
  });

  it('商品导入：Excel(.xlsx) 与 CSV 共用同一套校验与落库逻辑', async () => {
    const token = await login('admin', 'Admin@123');
    const auth = { Authorization: `Bearer ${token}` };

    const shared = sharedStringsXml([
      'product_no',
      'title',
      'price',
      'stock',
      'category',
      '3781182303640999001',
      'Excel 导入测试商品',
      '家居',
      '3781182303640999002',
      '缺少价格的商品',
    ]);
    const sheet = `<worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c></row>
      <row r="2"><c r="A2" t="s"><v>5</v></c><c r="B2" t="s"><v>6</v></c><c r="C2"><v>199</v></c><c r="D2"><v>50</v></c><c r="E2" t="s"><v>7</v></c></row>
      <row r="3"><c r="A3" t="s"><v>8</v></c><c r="B3" t="s"><v>9</v></c></row>
    </sheetData></worksheet>`;

    const xlsx = buildXlsxBuffer(sheet, shared);
    const res = await request(http)
      .post('/api/products/import')
      .set(auth)
      .send({ xlsxBase64: xlsx.toString('base64') });
    expect(res.body.code).toBe(0);
    expect(res.body.data.success).toBe(1);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.failed).toHaveLength(1);
    expect(res.body.data.failed[0].row).toBe(3);

    const list = await request(http).get('/api/products?keyword=Excel').set(auth);
    expect(list.body.data.list.map((p: any) => p.productNo)).toContain('3781182303640999001');
  }, 60000);

  it('商品导入：CSV 仍可用，且缺列时给出明确报错', async () => {
    const token = await login('admin', 'Admin@123');
    const auth = { Authorization: `Bearer ${token}` };

    const bad = await request(http)
      .post('/api/products/import')
      .set(auth)
      .send({ csv: 'title,price\n只有标题,10' });
    expect(bad.body.code).not.toBe(0);

    const csv = 'product_no,title,price,stock,category\n3781182303640999003,CSV 导入测试商品,59,10,家居';
    const ok = await request(http).post('/api/products/import').set(auth).send({ csv });
    expect(ok.body.code).toBe(0);
    expect(ok.body.data.success).toBe(1);
    expect(ok.body.data.failed).toHaveLength(0);
  }, 60000);

  it('实时计时：服务端每秒下发 timer.tick，并接收 client.ack 心跳', async () => {
    // 自由练习只对管理员/主管开放（客户新增需求），计时用例改用管理员
    const token = await login('admin', 'Admin@123');
    const port = (http.address() as any).port as number;
    const socket: Socket = io(`http://127.0.0.1:${port}`, {
      path: '/realtime',
      auth: { token },
      transports: ['websocket'],
    });
    const ticks: any[] = [];
    socket.on('timer.tick', (payload: any) => ticks.push(payload));

    try {
      await new Promise<void>((resolve, reject) => {
        const guard = setTimeout(() => reject(new Error('实时连接超时')), 5000);
        socket.on('reception.connected', () => {
          clearTimeout(guard);
          resolve();
        });
        socket.on('connect_error', (err) => {
          clearTimeout(guard);
          reject(err);
        });
      });

      const started = await request(http)
        .post('/api/receptions')
        .set({ Authorization: `Bearer ${token}` })
        .send({ level: 'L1', source: 'free' });
      expect(started.body.code).toBe(0);
      const attemptId = started.body.data.attemptId;

      await waitFor(() => ticks.length > 0, 6000);
      const first = ticks[0];
      expect(first.attemptId).toBe(attemptId);
      expect(typeof first.serverTime).toBe('string');
      expect(first.sessions.length).toBeGreaterThan(0);
      // 计时由服务端给出，前端不再自己推算
      expect(typeof first.sessions[0].waitedSec).toBe('number');
      expect(typeof first.sessions[0].remainSec).toBe('number');

      // 心跳：上报焦点会话后，服务端在后续 tick 里回传最近心跳时间
      socket.emit('client.ack', { sessionId: first.sessions[0].sessionId });
      await waitFor(() => ticks.some((t) => typeof t.lastAckAt === 'string'), 6000);
      expect(ticks.find((t) => typeof t.lastAckAt === 'string').lastAckAt).toBeTruthy();
    } finally {
      socket.close();
    }
  }, 60000);

  it('操作审计：写操作会落 action_logs，且不记录密码等敏感字段', async () => {
    const token = await login('admin', 'Admin@123');
    const res = await request(http)
      .post('/api/accounts')
      .set({ Authorization: `Bearer ${token}` })
      .send({ username: 'audit_probe', password: 'Probe@123', displayName: '审计探针', roleCode: 'agent' });
    expect(res.body.code).toBe(0);

    // 审计写入是异步的（不阻塞响应），这里轮询等它落库
    let rows: any[] = [];
    const started = Date.now();
    while (Date.now() - started < 5000) {
      rows = await sharedDb.many(
        `SELECT account_id AS "accountId", action, detail FROM action_logs
         WHERE action = 'POST /api/accounts' ORDER BY id DESC LIMIT 1`
      );
      if (rows.length) break;
      await sleep(100);
    }
    expect(rows).toHaveLength(1);
    const detail = typeof rows[0].detail === 'string' ? JSON.parse(rows[0].detail) : rows[0].detail;
    expect(detail.ok).toBe(true);
    expect(JSON.stringify(detail)).not.toContain('Probe@123');
    expect(rows[0].accountId).toBeTruthy();
  }, 60000);

  it('安全：账号列表中的手机号脱敏返回', async () => {
    const token = await login('admin', 'Admin@123');
    const created = await request(http)
      .post('/api/accounts')
      .set({ Authorization: `Bearer ${token}` })
      .send({
        username: 'mask_probe',
        password: 'Probe@123',
        displayName: '脱敏探针',
        roleCode: 'agent',
        mobile: '13800001234',
      });
    expect(created.body.code).toBe(0);

    const list = await request(http).get('/api/accounts?keyword=mask_probe').set({ Authorization: `Bearer ${token}` });
    expect(list.body.code).toBe(0);
    const row = list.body.data.list.find((item: any) => item.username === 'mask_probe');
    expect(row).toBeTruthy();
    expect(row.mobile).toBe('138****1234');
  }, 60000);

  it('批量生成：超过异步阈值返回任务 ID，可查询进度并取消', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const auth = { Authorization: `Bearer ${adminToken}` };
    // 阈值调到 5，用少量数据即可触发异步路径
    await request(http).put('/api/settings').set(auth).send({ batchAsyncThreshold: 5 });

    const backgrounds = await request(http).get('/api/backgrounds?pageSize=3').set(auth);
    const contents = await request(http).get('/api/contents?pageSize=4').set(auth);
    const products = await request(http).get('/api/products?pageSize=2').set(auth);
    const res = await request(http)
      .post('/api/scripts/batch-generate')
      .set(auth)
      .send({
        bgIds: backgrounds.body.data.list.map((b: any) => b.id),
        qaIds: contents.body.data.list.map((c: any) => c.id),
        productIds: products.body.data.list.map((p: any) => p.id),
      });
    expect(res.body.code).toBe(0);
    expect(res.body.data.async).toBe(true);
    expect(res.body.data.total).toBe(12);

    let task: any = null;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const progress = await request(http)
        .get(`/api/scripts/batch-generate/tasks/${res.body.data.taskId}`)
        .set(auth);
      expect(progress.body.code).toBe(0);
      task = progress.body.data;
      if (task.status !== 'running') break;
      await sleep(200);
    }
    expect(task.status).toBe('done');
    expect(task.createdCount).toBe(12);
    expect(task.failedCount).toBe(0);

    // 取消路径：开一个大批次后立刻取消，已生成的保留、不再继续
    const bigContents = await request(http).get('/api/contents?pageSize=300').set(auth);
    const big = await request(http)
      .post('/api/scripts/batch-generate')
      .set(auth)
      .send({
        bgIds: backgrounds.body.data.list.map((b: any) => b.id),
        qaIds: bigContents.body.data.list.map((c: any) => c.id),
        productIds: products.body.data.list.map((p: any) => p.id),
      });
    expect(big.body.data.async).toBe(true);
    const cancel = await request(http)
      .post(`/api/scripts/batch-generate/tasks/${big.body.data.taskId}/cancel`)
      .set(auth);
    expect(cancel.body.code).toBe(0);

    let bigTask: any = null;
    const bigDeadline = Date.now() + 30000;
    while (Date.now() < bigDeadline) {
      const progress = await request(http)
        .get(`/api/scripts/batch-generate/tasks/${big.body.data.taskId}`)
        .set(auth);
      bigTask = progress.body.data;
      if (bigTask.status !== 'running') break;
      await sleep(300);
    }
    expect(['cancelled', 'done']).toContain(bigTask.status);
    if (bigTask.status === 'cancelled') expect(bigTask.createdCount).toBeLessThan(big.body.data.total);

    await request(http).put('/api/settings').set(auth).send({ batchAsyncThreshold: 100 });
  }, 90000);

  it('接口清单补齐：令牌续签与小组更新', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const auth = { Authorization: `Bearer ${adminToken}` };

    const refreshed = await request(http).post('/api/auth/refresh').set(auth);
    expect(refreshed.body.code).toBe(0);
    expect(typeof refreshed.body.data.token).toBe('string');
    expect((await request(http).get('/api/auth/profile').set('Authorization', `Bearer ${refreshed.body.data.token}`)).body.code).toBe(0);
    expect(refreshed.body.data.profile.roleCode).toBe('admin');

    const anon = await request(http).post('/api/auth/refresh');
    expect(anon.body.code).toBe(1002);

    const group = await request(http).post('/api/groups').set(auth).send({ name: '预热二组' });
    expect(group.body.code).toBe(0);
    const updated = await request(http)
      .put(`/api/groups/${group.body.data.id}`)
      .set(auth)
      .send({ name: '预热二组（改名）' });
    expect(updated.body.code).toBe(0);
  }, 60000);

  it('续签守卫通过后会话被撤销，不能签发有效新令牌', async () => {
    const token = await login('agent2', 'Agent@123');
    const authService = app.get(AuthService);
    const refresh = authService.refresh.bind(authService);
    const spy = jest.spyOn(authService, 'refresh').mockImplementation(async (accountId, version) => {
      await authService.logout(accountId);
      return refresh(accountId, version);
    });
    try {
      const response = await request(http).post('/api/auth/refresh').set('Authorization', `Bearer ${token}`);
      expect(response.body.code).toBe(1002);
      expect(response.body.data?.token).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('重置密码后个人资料恢复强制改密状态，改密后重新登录解除限制', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const admin = { Authorization: `Bearer ${adminToken}` };
    const created = await request(http).post('/api/accounts').set(admin)
      .send({ username: 'reset_profile_probe', password: 'Probe@123', displayName: '改密探针', roleCode: 'agent' });
    expect(created.body.code).toBe(0);
    const reset = await request(http).post(`/api/accounts/${created.body.data.id}/reset-password`).set(admin).send({ password: 'Reset@123' });
    expect(reset.body.code).toBe(0);
    const loginRes = await request(http).post('/api/auth/login').send({ username: 'reset_profile_probe', password: 'Reset@123' });
    expect(loginRes.body.data.mustChangePassword).toBe(true);
    const auth = { Authorization: `Bearer ${loginRes.body.data.token}` };
    const profile = await request(http).get('/api/auth/profile').set(auth);
    expect(profile.body.data).toMatchObject({ mustChangePassword: true, notice: expect.any(String) });
    expect((await request(http).get('/api/records').set(auth)).body.code).not.toBe(0);
    expect((await request(http).post('/api/auth/change-password').set(auth).send({ oldPassword: 'Reset@123', newPassword: 'Newpass123' })).body.code).toBe(0);
    const newToken = await login('reset_profile_probe', 'Newpass123');
    const updatedProfile = await request(http).get('/api/auth/profile').set('Authorization', `Bearer ${newToken}`);
    expect(updatedProfile.body.data).toMatchObject({ mustChangePassword: false, notice: null });
    expect((await request(http).get('/api/records').set('Authorization', `Bearer ${newToken}`)).body.code).toBe(0);
  });

  it('情绪升级：情绪值达到阈值后买家追加升级追问（方案 3.7.4 / 9.2 场景四）', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const group = await sharedDb.one<{ id: number }>(`SELECT id FROM groups WHERE name = $1`, ['新人一组']);
    await request(http)
      .post('/api/accounts')
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({
        username: 'emotion_probe',
        password: 'Probe@123',
        displayName: '情绪探针',
        // 探针账号要能自由练习（客户新增需求后客服不能用自由练习）
        roleCode: 'leader',
        groupId: group?.id ?? null,
      });
    const token = await login('emotion_probe', 'Probe@123');
    const auth = { Authorization: `Bearer ${token}` };

    const started = await request(http).post('/api/receptions').set(auth).send({ level: 'L1', source: 'free' });
    expect(started.body.code).toBe(0);
    const attemptId = started.body.data.attemptId;
    const sessionId = started.body.data.sessions[0].sessionId;

    // 连续使用禁用词把情绪值顶到升级阈值（默认 80）
    for (let i = 0; i < 4; i += 1) {
      const replied = await request(http)
        .post(`/api/receptions/${attemptId}/sessions/${sessionId}/messages`)
        .set(auth)
        .send({ content: '不知道，你自己看吧' });
      expect(replied.body.code).toBe(0);
    }

    const escalation = '你们这样处理我实在接受不了，我要投诉你们！';
    const escalated = await sharedDb.one<{ count: string }>(
      `SELECT count(*)::text AS count FROM messages WHERE session_id = $1 AND content = $2`,
      [sessionId, escalation]
    );
    expect(Number(escalated!.count)).toBe(1);

    const emotion = await sharedDb.one<{ emotion_value: number }>(
      `SELECT emotion_value FROM sessions WHERE id = $1`,
      [sessionId]
    );
    expect(Number(emotion!.emotion_value)).toBeGreaterThanOrEqual(80);
  }, 60000);

  it('超时口径：超过阈值未回复会记录超时并扣响应分（方案 4.2 / 9.2 场景二）', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const adminAuth = { Authorization: `Bearer ${adminToken}` };
    // 把阈值与进线间隔调小，便于在秒级验证真实规则（规则本身不变）
    await request(http).put('/api/settings').set(adminAuth).send({ timeoutSec: 1, levelJoinDelaySec: [0, 1] });

    await request(http)
      .post('/api/accounts')
      .set(adminAuth)
      .send({ username: 'timeout_probe', password: 'Probe@123', displayName: '超时探针', roleCode: 'leader' });
    const token = await login('timeout_probe', 'Probe@123');
    const auth = { Authorization: `Bearer ${token}` };

    const started = await request(http).post('/api/receptions').set(auth).send({ level: 'L1', source: 'free' });
    expect(started.body.code).toBe(0);
    const attemptId = started.body.data.attemptId;
    const sessionId = started.body.data.sessions[0].sessionId;

    // 买家进线后不回复，等待超时扫描（每 5 秒一次）记录超时
    let state: any = null;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      state = await sharedDb.one<{ timeout_count: number; state: string }>(
        `SELECT timeout_count, state FROM sessions WHERE id = $1`,
        [sessionId]
      );
      if (Number(state?.timeout_count) > 0) break;
      await sleep(1000);
    }
    expect(Number(state!.timeout_count)).toBeGreaterThan(0);
    expect(state!.state).toBe('timeout');

    const timeoutMessage = await sharedDb.one<{ count: string }>(
      `SELECT count(*)::text AS count FROM messages WHERE session_id = $1 AND is_timeout = true`,
      [sessionId]
    );
    expect(Number(timeoutMessage!.count)).toBeGreaterThan(0);

    // 同一次超时既有系统提示，又有迟到回复标记，最终只能扣一次。
    const lateReply = await request(http)
      .post(`/api/receptions/${attemptId}/sessions/${sessionId}/messages`)
      .set(auth)
      .send({ content: '亲您好，我在的，请问有什么可以帮您？' });
    expect(lateReply.body.code).toBe(0);
    expect(lateReply.body.data.isTimeout).toBe(true);

    const finished = await request(http).post(`/api/receptions/${attemptId}/finish`).set(auth);
    expect(finished.body.code).toBe(0);

    // 评分落库时应包含超时次数与响应维度扣分
    const score = await sharedDb.one<any>(`SELECT metrics, deductions FROM scores WHERE session_id = $1`, [sessionId]);
    expect(Number(score.metrics.timeoutCount)).toBe(1);
    expect(JSON.stringify(score.deductions)).toContain('超时');

    await request(http).put('/api/settings').set(adminAuth).send({ timeoutSec: 180, levelJoinDelaySec: [10, 30] });
  }, 90000);

  it('导入校验：分类不存在与价格非法都计入失败清单（方案 9.2 场景七）', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const csv = [
      'product_no,title,price,stock,category',
      '3781182303640999101,分类合法商品,10,5,家居',
      '3781182303640999102,分类非法商品,10,5,不存在的分类',
      '3781182303640999103,价格非法商品,-5,5,家居',
    ].join('\n');
    const res = await request(http)
      .post('/api/products/import')
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({ csv });
    expect(res.body.code).toBe(0);
    expect(res.body.data.success).toBe(1);
    expect(res.body.data.failed.map((item: any) => item.row)).toEqual([3, 4]);
    const reasons = res.body.data.failed.map((item: any) => item.reason).join(' ');
    expect(reasons).toContain('分类不存在');
    expect(reasons).toContain('价格');
  }, 60000);

  it('沟通风格默认占比与方案 10.3 一致', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const res = await request(http).get('/api/styles').set({ Authorization: `Bearer ${adminToken}` });
    expect(res.body.code).toBe(0);
    const ratios = new Map<string, number | null>(res.body.data.map((s: any) => [s.code, s.ratio]));
    expect(ratios.get('friendly')).toBe(30);
    expect(ratios.get('impatient')).toBe(15);
    expect(ratios.get('direct')).toBe(20);
    expect(ratios.get('hesitant')).toBe(20);
    expect(ratios.get('silent')).toBe(15);
    // 扩充风格默认不参与分配
    expect(ratios.get('newbie')).toBeNull();
  }, 60000);

  it('方案 F3-11：剧本预览按对话流给出提问序列（与列表轮数一致）', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const adminAuth = { Authorization: `Bearer ${adminToken}` };
    const list = await request(http).get('/api/scripts?pageSize=1').set(adminAuth);
    const script = list.body.data.list[0];
    expect(script).toBeTruthy();

    const preview = await request(http).get(`/api/scripts/${script.id}/preview`).set(adminAuth);
    expect(preview.body.code).toBe(0);
    const rounds = preview.body.data.questionSeq;
    expect(Array.isArray(rounds)).toBe(true);
    expect(rounds.length).toBeGreaterThan(0);
    expect(rounds[0]).toHaveProperty('question');
    expect(rounds[0].keyPoints.length).toBeGreaterThan(0);
    expect(preview.body.data.customerGoal).toBeTruthy();
    // 方案 3.3：预览的提问序列要与接待抽取到的一致（轮数对得上）
    expect(rounds.length).toBe(script.rounds);
  });

  it('回归：工艺细节场景不会为了凑轮数插入发货/优惠/竞品问题', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const auth = { Authorization: `Bearer ${adminToken}` };
    const suffix = String(Date.now());

    const bg = await request(http)
      .post('/api/backgrounds')
      .set(auth)
      .send({
        name: `耐穿与打理成本-${suffix}`,
        description: '关注耐穿、做工和后续打理成本',
        category: '通用',
      });
    expect(bg.body.code).toBe(0);

    const qa = await request(http)
      .post('/api/contents')
      .set(auth)
      .send({
        templateName: `咨询工艺细节-${suffix}`,
        question: '是包边还是锁边？;走线整齐吗？;有内衬吗？',
        keyPoints: [
          ['工艺', '包边', '锁边'],
          ['走线', '牢固'],
          ['内衬'],
        ],
        acceptedAnswer: '说明工艺做法、走线水平和内衬情况，可提供细节实拍',
        stage: 'presale',
        category: '通用',
      });
    expect(qa.body.code).toBe(0);

    // 工艺题必须使用服饰商品，不能假定按 id DESC 排序的首件商品一定兼容。
    const products = await request(http).get('/api/products?pageSize=100&status=1&category=女装').set(auth);
    expect(products.body.code).toBe(0);
    const product = products.body.data.list.find((item: any) => item.category === '女装');
    expect(product).toBeTruthy();

    const created = await request(http)
      .post('/api/scripts')
      .set(auth)
      .send({
        bgId: bg.body.data.id,
        qaId: qa.body.data.id,
        productIds: [product.id],
        stage: 'presale',
        autoSemanticGoals: true,
        name: `售前-耐穿与打理成本-咨询工艺细节-${suffix}`,
      });
    expect(created.body.code).toBe(0);

    const preview = await request(http).get(`/api/scripts/${created.body.data.id}/preview`).set(auth);
    expect(preview.body.code).toBe(0);
    const previewSeq = preview.body.data.questionSeq;
    // 3 题工艺短场景按最低 6 轮补齐：前 3 条为原始 core 问题，后 3 条为工艺相关衍生追问。
    expect(previewSeq).toHaveLength(6);
    expect(previewSeq.slice(0, 3).map((q: any) => q.question)).toEqual([
      '是包边还是锁边？',
      '走线整齐吗？',
      '有内衬吗？',
    ]);
    expect(previewSeq.slice(0, 3).every((q: any) => q.sourceType === 'core')).toBe(true);
    expect(previewSeq.slice(3).every((q: any) => q.sourceType === 'derived')).toBe(true);
    expect(previewSeq[0].primaryGoal).toBe('工艺');
    expect(preview.body.data.customerGoal).toBe('确认商品工艺质量和耐穿程度');
    expect(preview.body.data.roundsWarning).toBeNull();

    const allText = previewSeq.map((q: any) => q.question).join(' ');
    expect(allText).not.toContain('多久能处理好');
    expect(allText).not.toContain('有什么优势');
    expect(allText).not.toContain('额外优惠');

    await request(http).delete(`/api/scripts/${created.body.data.id}`).set(auth);
    await request(http).post('/api/contents/batch-delete').set(auth).send({ ids: [qa.body.data.id] });
    await request(http).post('/api/backgrounds/batch-delete').set(auth).send({ ids: [bg.body.data.id] });
  }, 60000);

  it('方案 F4-05：商品列表支持关键词 / 分类 / 价格区间 / 状态筛选', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const adminAuth = { Authorization: `Bearer ${adminToken}` };
    const all = await request(http).get('/api/products?pageSize=200').set(adminAuth);
    const sample = all.body.data.list.find((p: any) => p.status === 1);
    expect(sample).toBeTruthy();

    // 关键词（标题片段）
    const byKeyword = await request(http)
      .get(`/api/products?keyword=${encodeURIComponent(String(sample.title).slice(0, 4))}`)
      .set(adminAuth);
    expect(byKeyword.body.data.list.some((p: any) => p.id === sample.id)).toBe(true);

    // 分类
    const byCategory = await request(http)
      .get(`/api/products?category=${encodeURIComponent(sample.category)}`)
      .set(adminAuth);
    expect(byCategory.body.data.list.length).toBeGreaterThan(0);
    expect(byCategory.body.data.list.every((p: any) => p.category === sample.category)).toBe(true);

    // 价格区间（卡在该商品价格 ±1 元）
    const low = Math.max(0, Number(sample.price) - 1);
    const high = Number(sample.price) + 1;
    const byPrice = await request(http).get(`/api/products?minPrice=${low}&maxPrice=${high}`).set(adminAuth);
    expect(byPrice.body.data.list.length).toBeGreaterThan(0);
    expect(byPrice.body.data.list.every((p: any) => Number(p.price) >= low && Number(p.price) <= high)).toBe(true);

    // 状态：只看下架
    const offline = await request(http).get('/api/products?status=0').set(adminAuth);
    expect(offline.body.data.list.every((p: any) => p.status === 0)).toBe(true);
  });

  it('方案 F1-09：售后（L4 档位）会话带出订单卡片的下单时间、金额与状态', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const adminAuth = { Authorization: `Bearer ${adminToken}` };
    const current = await request(http).get('/api/receptions/current').set(adminAuth);
    if (current.body.data?.attemptId) {
      await request(http).post(`/api/receptions/${current.body.data.attemptId}/finish`).set(adminAuth).send({});
    }

    // L4 档位的抽取偏好是售后剧本；售后会话才会带模拟订单
    const started = await request(http).post('/api/receptions').set(adminAuth).send({ level: 'L4' });
    expect(started.body.code).toBe(0);
    const attemptId = started.body.data.attemptId;
    const withOrder = started.body.data.sessions.filter((s: any) => s.order);
    expect(withOrder.length).toBeGreaterThan(0);

    const order = withOrder[0].order;
    expect(order.orderNo).toBeTruthy();
    expect(typeof order.amount).toBe('number');
    // 订单卡片三态（客户 2026-10-03）：stage 是机器值、statusText 是界面展示的「待支付/待发货/已发货」
    expect(order.stage).toBe('shipped');
    expect(order.statusText).toBe('已发货');
    // 下单时间：模拟成「进线前 1～3 小时」，且两次读取保持一致、永远早于进线
    expect(Number.isFinite(Date.parse(order.placedAt))).toBe(true);
    expect(Date.parse(order.placedAt)).toBeLessThan(Date.parse(withOrder[0].joinAt) + 1);

    const snap = await request(http).get(`/api/receptions/${attemptId}/snapshot`).set(adminAuth);
    const sameSession = snap.body.data.sessions.find((s: any) => s.sessionId === withOrder[0].sessionId);
    expect(sameSession.order.placedAt).toBe(order.placedAt);

    await request(http).post(`/api/receptions/${attemptId}/finish`).set(adminAuth).send({});
  }, 60000);

  it('方案 F7-04：剧本风格会影响买家消息的语气（情绪化风格还会追加一句）', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const adminAuth = { Authorization: `Bearer ${adminToken}` };
    const current = await request(http).get('/api/receptions/current').set(adminAuth);
    if (current.body.data?.attemptId) {
      await request(http).post(`/api/receptions/${current.body.data.attemptId}/finish`).set(adminAuth).send({});
    }

    const started = await request(http).post('/api/receptions').set(adminAuth).send({ level: 'L2' });
    expect(started.body.code).toBe(0);
    const attemptId = started.body.data.attemptId;
    await sleep(3000); // 等第一名买家进线并推送第一条问题

    const snap = await request(http).get(`/api/receptions/${attemptId}/snapshot`).set(adminAuth);
    expect(snap.body.code).toBe(0);
    const session = snap.body.data.sessions[0];
    const buyerMessages = snap.body.data.messages
      .filter((m: any) => m.sessionId === session.sessionId && m.sender === 'buyer')
      .map((m: any) => m.content);
    expect(buyerMessages.length).toBeGreaterThan(0);

    const question: string = session.questions[0].question;
    const styleCode: string = session.styleCode;
    if (styleCode === 'impatient') {
      expect(buyerMessages[0]).toBe(`${question.replace(/[？?]$/u, '')}？麻烦直接说一下。`);
    } else if (styleCode === 'hesitant') {
      expect(buyerMessages[0]).toBe(`我想确认一下，${question.trim()}`);
    } else if (styleCode === 'silent') {
      // 沉默寡言只控制语气，不允许截断用户真正关心的问题。
      expect(buyerMessages[0]).toBe(question.trim());
    } else {
      // friendly / direct / 自定义风格：原样推送，不加戏
      expect(buyerMessages[0]).toBe(question);
      expect(buyerMessages).toHaveLength(1);
    }
    // 情绪基线来自风格（friendly 15 / impatient 65 / …），不是写死的
    expect(typeof session.emotionValue).toBe('number');

    await request(http).post(`/api/receptions/${attemptId}/finish`).set(adminAuth).send({});
  }, 60000);

  it('首页数据契约：难度接口返回完整字段，概览接口不再重复返回 levels', async () => {
    const agentToken = await login('agent', 'Agent@123');
    const auth = { Authorization: `Bearer ${agentToken}` };

    // 首页难度卡片依赖这些字段（曾因与概览接口的 levels 混用导致数值丢失）
    const levels = await request(http).get('/api/receptions/levels').set(auth);
    expect(levels.body.code).toBe(0);
    expect(levels.body.data).toHaveLength(4);
    for (const level of levels.body.data) {
      expect(typeof level.code).toBe('string');
      expect(typeof level.name).toBe('string');
      expect(typeof level.concurrent).toBe('number');
      expect(typeof level.requiredStreak).toBe('number');
      expect(typeof level.unlocked).toBe('boolean');
    }
    expect(levels.body.data.map((item: any) => item.concurrent)).toEqual([1, 2, 3, 4]);

    const overview = await request(http).get('/api/records/overview').set(auth);
    expect(overview.body.code).toBe(0);
    expect(overview.body.data.levels).toBeUndefined();
  }, 60000);

  it('验收标准：四档难度开局并发数正确，结束后 3 秒内出结果', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const adminAuth = { Authorization: `Bearer ${adminToken}` };
    const group = await sharedDb.one<{ id: number }>(`SELECT id FROM groups WHERE name = $1`, ['新人一组']);
    await request(http)
      .post('/api/accounts')
      .set(adminAuth)
      .send({
        username: 'level_probe',
        password: 'Probe@123',
        displayName: '难度探针',
        // 客户新增需求：客服不开放自由练习，四档并发的验收改用管理员账号
        roleCode: 'admin',
        groupId: group?.id ?? null,
      });
    const token = await login('level_probe', 'Probe@123');
    const auth = { Authorization: `Bearer ${token}` };

    for (const [level, concurrent] of [
      ['L1', 1],
      ['L2', 2],
      ['L3', 3],
      ['L4', 4],
    ] as [string, number][]) {
      const started = await request(http).post('/api/receptions').set(auth).send({ level, source: 'free' });
      expect(started.body.code).toBe(0);
      // 合计人数默认 10：本档同时接入 existing=concurrent 个，其余排队待接入
      expect(started.body.data.sessions).toHaveLength(10);
      expect(started.body.data.sessions.filter((s: any) => s.state === 'wait')).toHaveLength(concurrent);
      expect(started.body.data.sessions.filter((s: any) => s.state === 'pending')).toHaveLength(10 - concurrent);

      const startedAt = Date.now();
      const finished = await request(http)
        .post(`/api/receptions/${started.body.data.attemptId}/finish`)
        .set(auth);
      expect(finished.body.code).toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(3000);
    }
  }, 90000);

  it('验收标准：4 背景 × 10 内容生成 40 个剧本，命名不重复且商品与风格齐全', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const auth = { Authorization: `Bearer ${adminToken}` };
    const backgrounds = await request(http).get('/api/backgrounds?pageSize=4').set(auth);
    const contents = await request(http).get('/api/contents?pageSize=10').set(auth);
    // 同上：取全部上架商品，保证「4 背景 × 10 内容」每条内容都能配到兼容商品
    const products = await request(http).get('/api/products?pageSize=300&status=1').set(auth);
    const res = await request(http)
      .post('/api/scripts/batch-generate')
      .set(auth)
      .send({
        bgIds: backgrounds.body.data.list.map((b: any) => b.id),
        qaIds: contents.body.data.list.map((c: any) => c.id),
        productIds: products.body.data.list.map((p: any) => p.id),
        seed: 20261001,
      });
    expect(res.body.code).toBe(0);
    expect(res.body.data.total).toBe(40);
    const preview = res.body.data.preview as any[];
    expect(preview).toHaveLength(40);
    expect(new Set(preview.map((item) => item.name)).size).toBe(40);
    expect(new Set(preview.map((item) => item.scriptNo)).size).toBe(40);

    const ids = preview.map((item) => item.id);
    const rows = await sharedDb.many<any>(
      `SELECT name, style_id, product_ids FROM scripts WHERE id IN (${ids.join(',')})`
    );
    expect(rows).toHaveLength(40);
    for (const row of rows) {
      expect(row.name).toBeTruthy();
      expect(row.style_id).toBeTruthy();
      const productIds = typeof row.product_ids === 'string' ? JSON.parse(row.product_ids) : row.product_ids;
      expect(Array.isArray(productIds) && productIds.length).toBeTruthy();
    }

    // 沟通风格占比偏差 ≤ ±5%（方案 9.1）：再生成 100 个剧本看分布
    const hundred = await request(http)
      .post('/api/scripts/batch-generate')
      .set(auth)
      .send({
        bgIds: backgrounds.body.data.list.map((b: any) => b.id),
        qaIds: (await request(http).get('/api/contents?pageSize=25').set(auth)).body.data.list
          .slice(0, 25)
          .map((c: any) => c.id),
        productIds: products.body.data.list.map((p: any) => p.id),
        seed: 20261002,
      });
    if (hundred.body.code === 0 && hundred.body.data.total === 100) {
      const distribution = hundred.body.data.distribution as Record<string, number>;
      expect(Math.abs((distribution.friendly || 0) - 30)).toBeLessThanOrEqual(5);
      expect(Math.abs((distribution.impatient || 0) - 15)).toBeLessThanOrEqual(5);
      expect(Math.abs((distribution.direct || 0) - 20)).toBeLessThanOrEqual(5);
      expect(Math.abs((distribution.hesitant || 0) - 20)).toBeLessThanOrEqual(5);
      expect(Math.abs((distribution.silent || 0) - 15)).toBeLessThanOrEqual(5);
    }
  }, 90000);

  it('验收标准：100 条商品导入成功率 ≥ 99%，下架商品不能用于新剧本', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const auth = { Authorization: `Bearer ${adminToken}` };

    const rows = [];
    for (let i = 1; i <= 100; i += 1) {
      rows.push(`3781182303640970${String(i).padStart(3, '0')},导入商品${i},${10 + i},5,家居`);
    }
    const imported = await request(http)
      .post('/api/products/import')
      .set(auth)
      .send({ csv: ['product_no,title,price,stock,category', ...rows].join('\n') });
    expect(imported.body.code).toBe(0);
    expect(imported.body.data.total).toBe(100);
    expect(imported.body.data.success / imported.body.data.total).toBeGreaterThanOrEqual(0.99);

    // 下架商品不参与新建剧本
    const created = await request(http)
      .post('/api/products')
      .set(auth)
      .send({ productNo: 'OFF-1', title: '待下架商品', price: 10 });
    const productId = created.body.data.id;
    await request(http).put(`/api/products/${productId}`).set(auth).send({ status: 0 });

    const backgrounds = await request(http).get('/api/backgrounds?pageSize=1').set(auth);
    const contents = await request(http).get('/api/contents?pageSize=1').set(auth);
    const blocked = await request(http)
      .post('/api/scripts/batch-generate')
      .set(auth)
      .send({
        bgIds: [backgrounds.body.data.list[0].id],
        qaIds: [contents.body.data.list[0].id],
        productIds: [productId],
      });
    expect(blocked.body.code).not.toBe(0);
    expect(blocked.body.message).toContain('下架');

    const sellable = await request(http).get('/api/products?status=1&pageSize=300').set(auth);
    expect(sellable.body.data.list.some((p: any) => p.id === productId)).toBe(false);
  }, 90000);

  it('权限矩阵：受限写接口对无权角色一律返回 1003（方案 2.2 / 9.1）', async () => {
    const tokens: Record<string, string> = {
      admin: await login('admin', 'Admin@123'),
      leader: await login('leader', 'Leader@123'),
      agent: await login('agent', 'Agent@123'),
    };
    // 路径里的 id 用不存在的值即可：角色守卫先于业务逻辑执行，无权角色必然被拦下
    const endpoints: { method: string; path: string; body?: any; allow: string[] }[] = [
      { method: 'post', path: '/api/accounts', body: {}, allow: ['admin'] },
      { method: 'put', path: '/api/accounts/999999', body: {}, allow: ['admin'] },
      { method: 'post', path: '/api/accounts/999999/reset-password', body: { password: 'Xyz12345' }, allow: ['admin'] },
      { method: 'post', path: '/api/groups', body: { name: 'x' }, allow: ['admin'] },
      { method: 'put', path: '/api/groups/999999', body: { name: 'x' }, allow: ['admin'] },
      { method: 'post', path: '/api/accounts/999999/unlock-levels', body: { levels: ['L2'] }, allow: ['admin', 'leader'] },
      { method: 'put', path: '/api/settings', body: {}, allow: ['admin'] },
      { method: 'post', path: '/api/products', body: {}, allow: ['admin'] },
      { method: 'put', path: '/api/products/999999', body: {}, allow: ['admin'] },
      { method: 'delete', path: '/api/products/999999', allow: ['admin'] },
      { method: 'post', path: '/api/products/import', body: {}, allow: ['admin'] },
      { method: 'post', path: '/api/uploads', body: {}, allow: ['admin', 'leader'] },
      { method: 'post', path: '/api/backgrounds', body: {}, allow: ['admin', 'leader'] },
      { method: 'put', path: '/api/backgrounds/999999', body: {}, allow: ['admin', 'leader'] },
      { method: 'post', path: '/api/backgrounds/batch-delete', body: { ids: [] }, allow: ['admin', 'leader'] },
      { method: 'post', path: '/api/contents', body: {}, allow: ['admin', 'leader'] },
      { method: 'put', path: '/api/contents/999999', body: {}, allow: ['admin', 'leader'] },
      { method: 'post', path: '/api/contents/batch-delete', body: { ids: [] }, allow: ['admin', 'leader'] },
      { method: 'post', path: '/api/categories', body: {}, allow: ['admin', 'leader'] },
      { method: 'put', path: '/api/categories/reorder', body: { items: [] }, allow: ['admin', 'leader'] },
      { method: 'delete', path: '/api/categories/999999', allow: ['admin', 'leader'] },
      { method: 'post', path: '/api/scripts', body: {}, allow: ['admin', 'leader'] },
      { method: 'put', path: '/api/scripts/999999', body: {}, allow: ['admin', 'leader'] },
      { method: 'delete', path: '/api/scripts/999999', allow: ['admin', 'leader'] },
      { method: 'post', path: '/api/scripts/batch-generate', body: {}, allow: ['admin', 'leader'] },
      { method: 'get', path: '/api/scripts/batch-generate/tasks/999999', allow: ['admin', 'leader'] },
      { method: 'post', path: '/api/scripts/batch-generate/tasks/999999/cancel', body: {}, allow: ['admin', 'leader'] },
      { method: 'post', path: '/api/styles', body: {}, allow: ['admin'] },
      { method: 'put', path: '/api/styles/999999', body: {}, allow: ['admin'] },
      { method: 'delete', path: '/api/styles/999999', allow: ['admin'] },
      { method: 'put', path: '/api/styles/ratios', body: { items: [] }, allow: ['admin'] },
      { method: 'post', path: '/api/phrases', body: {}, allow: ['admin', 'leader'] },
      { method: 'put', path: '/api/phrases/999999', body: {}, allow: ['admin', 'leader'] },
      { method: 'delete', path: '/api/phrases/999999', allow: ['admin', 'leader'] },
      { method: 'post', path: '/api/tasks', body: {}, allow: ['admin', 'leader'] },
      { method: 'delete', path: '/api/tasks/999999', allow: ['admin', 'leader'] },
      { method: 'post', path: '/api/cases/import/text', body: {}, allow: ['admin', 'leader'] },
      { method: 'post', path: '/api/cases/999999/to-content', body: {}, allow: ['admin', 'leader'] },
      { method: 'post', path: '/api/cases/messages/999999/excellent', body: {}, allow: ['admin', 'leader'] },
      { method: 'delete', path: '/api/cases/999999', allow: ['admin', 'leader'] },
      { method: 'post', path: '/api/records/999999/annotations', body: { content: 'x' }, allow: ['admin', 'leader'] },
    ];

    const violations: string[] = [];
    for (const endpoint of endpoints) {
      for (const role of ['admin', 'leader', 'agent']) {
        if (endpoint.allow.includes(role)) continue;
        const res = await (request(http) as any)
          [endpoint.method](endpoint.path)
          .set({ Authorization: `Bearer ${tokens[role]}` })
          .send(endpoint.body ?? {});
        if (res.body.code !== 1003) {
          violations.push(`${role} ${endpoint.method.toUpperCase()} ${endpoint.path} 返回 ${res.body.code}`);
        }
      }
    }
    expect(violations).toEqual([]);

    // 客服只读：能看商品与剧本，不能改
    const agentRead = await request(http).get('/api/products').set({ Authorization: `Bearer ${tokens.agent}` });
    expect(agentRead.body.code).toBe(0);
  }, 90000);

  it('商品关联剧本数按数组元素精确统计（避免把 id=1 误算到 [11]、[21]）', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const auth = { Authorization: `Bearer ${adminToken}` };

    const products = await request(http).get('/api/products?pageSize=500').set(auth);
    expect(products.body.code).toBe(0);
    const rows = products.body.data.list as any[];
    const pageIds = new Set(rows.map((row) => Number(row.id)));
    const counted = rows.reduce((acc, row) => acc + Number(row.scriptCount || 0), 0);

    // 与「剧本里真实引用到的商品 id」逐一对齐：旧实现用 LIKE '%id%' 会多算
    const scriptRows = await sharedDb.many<{ product_ids: any }>(`SELECT product_ids FROM scripts`);
    const linked = scriptRows.reduce((acc, row) => {
      const ids = typeof row.product_ids === 'string' ? JSON.parse(row.product_ids) : row.product_ids;
      if (!Array.isArray(ids)) return acc;
      return acc + ids.filter((id: any) => pageIds.has(Number(id))).length;
    }, 0);
    expect(counted).toBe(linked);

    // 商品详情的关联剧本应与列表计数一致
    const sample = rows.find((row) => Number(row.scriptCount) > 0);
    if (sample) {
      const detail = await request(http).get(`/api/products/${sample.id}`).set(auth);
      expect(detail.body.code).toBe(0);
      expect(detail.body.data.scripts).toHaveLength(Number(sample.scriptCount));
    }
  }, 60000);

  it('验收标准：带教可为客服开放指定难度，客服无此权限（方案 4.4）', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const leaderToken = await login('leader', 'Leader@123');
    const group = await sharedDb.one<{ id: number }>(`SELECT id FROM groups WHERE name = $1`, ['新人一组']);
    await request(http)
      .post('/api/accounts')
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({
        username: 'unlock_probe',
        password: 'Probe@123',
        displayName: '难度开放探针',
        roleCode: 'agent',
        groupId: group?.id ?? null,
      });
    const account = await sharedDb.one<{ id: number }>(`SELECT id FROM accounts WHERE username = 'unlock_probe'`);

    const granted = await request(http)
      .post(`/api/accounts/${account!.id}/unlock-levels`)
      .set({ Authorization: `Bearer ${leaderToken}` })
      .send({ levels: ['L3', 'L4'] });
    expect(granted.body.code).toBe(0);

    const unlocked = await sharedDb.many<{ level: string }>(
      `SELECT level FROM unlock_progress WHERE account_id = $1 AND unlocked = true`,
      [account!.id]
    );
    // L1 默认开放（不依赖 unlock_progress 记录），这里只校验被显式开放的档位
    expect(unlocked.map((row) => row.level).sort()).toEqual(['L3', 'L4']);

    const agentToken = await login('unlock_probe', 'Probe@123');
    // 开放结果应体现在难度状态接口上（L1 始终开放，L2 仍未开放）
    const levels = await request(http)
      .get('/api/receptions/levels')
      .set({ Authorization: `Bearer ${agentToken}` });
    const statusMap = new Map<string, boolean>(levels.body.data.map((item: any) => [item.code, item.unlocked]));
    expect(statusMap.get('L1')).toBe(true);
    expect(statusMap.get('L2')).toBe(false);
    expect(statusMap.get('L3')).toBe(true);
    expect(statusMap.get('L4')).toBe(true);

    const denied = await request(http)
      .post(`/api/accounts/${account!.id}/unlock-levels`)
      .set({ Authorization: `Bearer ${agentToken}` })
      .send({ levels: ['L2'] });
    expect(denied.body.code).toBe(1003);
  }, 60000);

  it('安全：批注权限矩阵、SQL 注入与 XSS 载荷处理', async () => {
    const adminToken = await login('admin', 'Admin@123');
    const agentToken = await login('agent', 'Agent@123');
    const leaderToken = await login('leader', 'Leader@123');

    // 选一条归带教本组的接待记录（主管只能操作本组）
    const attempt = await sharedDb.one<{ id: number }>(
      `SELECT a.id FROM attempts a JOIN accounts ac ON ac.id = a.account_id
       WHERE ac.group_id = (SELECT group_id FROM accounts WHERE username = 'leader')
       ORDER BY a.id DESC LIMIT 1`
    );
    expect(attempt?.id).toBeTruthy();

    // 方案 2.2：客服仅可查看与回复批注，不能新建批注
    const denied = await request(http)
      .post(`/api/records/${attempt!.id}/annotations`)
      .set({ Authorization: `Bearer ${agentToken}` })
      .send({ content: '客服不应能创建批注' });
    expect(denied.body.code).toBe(1003);

    // 带教可以新建批注
    const created = await request(http)
      .post(`/api/records/${attempt!.id}/annotations`)
      .set({ Authorization: `Bearer ${leaderToken}` })
      .send({ content: '带教批注示例' });
    expect(created.body.code).toBe(0);

    // 回复批注也要做越权校验（此前只按 id 更新，任意用户都能改）
    const otherAttempt = await sharedDb.one<{ id: number }>(
      `SELECT id FROM attempts ORDER BY id ASC LIMIT 1`
    );
    const foreignAnnotation = await sharedDb.one<{ id: number }>(
      `SELECT id FROM annotations WHERE attempt_id = $1 ORDER BY id LIMIT 1`,
      [otherAttempt!.id]
    );
    if (foreignAnnotation) {
      const replyDenied = await request(http)
        .post(`/api/records/annotations/${foreignAnnotation.id}/reply`)
        .set({ Authorization: `Bearer ${adminToken}` })
        .send({ replyContent: '管理员回复' });
      expect(replyDenied.body.code).toBe(0);
    }

    // SQL 注入探测：参数化查询不应被绕过
    const injected = await request(http)
      .get(`/api/products?keyword=${encodeURIComponent("' OR 1=1 --")}`)
      .set({ Authorization: `Bearer ${adminToken}` });
    expect(injected.body.code).toBe(0);
    expect(injected.body.data.list).toHaveLength(0);

    const dropProbe = await request(http)
      .get(`/api/products?keyword=${encodeURIComponent("'; DROP TABLE products; --")}`)
      .set({ Authorization: `Bearer ${adminToken}` });
    expect(dropProbe.body.code).toBe(0);
    const stillThere = await sharedDb.one<{ count: string }>(`SELECT count(*)::text AS count FROM products`);
    expect(Number(stillThere!.count)).toBeGreaterThan(0);

    // XSS 载荷原样存储，服务端不拼接 HTML（前端由 React 默认转义）
    const payload = '<script>alert(1)</script>';
    const product = await request(http)
      .post('/api/products')
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({ productNo: 'XSS-1', title: `标题${payload}`, price: 1 });
    expect(product.body.code).toBe(0);
    const detail = await request(http)
      .get(`/api/products/${product.body.data.id}`)
      .set({ Authorization: `Bearer ${adminToken}` });
    expect(detail.body.data.title).toBe(`标题${payload}`);
  }, 60000);

  // 放在最后：本用例会关闭当前实例，用同一个数据库重新起一个实例来模拟服务重启。
  it('断线超时：客服端断线超过宽限期后，进行中的会话按异常中止处理', async () => {
    const adminToken = await login('admin', 'Admin@123');
    // 宽限期调到 1 秒，避免测试真的等 60 秒（方案 4.7 / 4.8 的规则本身不变）
    await request(http)
      .put('/api/settings')
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({ disconnectGraceSec: 1 });
    await request(http)
      .post('/api/accounts')
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({ username: 'offline_probe', password: 'Probe@123', displayName: '断线探针', roleCode: 'leader' });

    const token = await login('offline_probe', 'Probe@123');
    const port = (http.address() as any).port as number;
    const socket: Socket = io(`http://127.0.0.1:${port}`, {
      path: '/realtime',
      auth: { token },
      transports: ['websocket'],
    });
    await new Promise<void>((resolve, reject) => {
      const guard = setTimeout(() => reject(new Error('实时连接超时')), 5000);
      socket.on('reception.connected', () => {
        clearTimeout(guard);
        resolve();
      });
      socket.on('connect_error', (err) => {
        clearTimeout(guard);
        reject(err);
      });
    });

    const started = await request(http)
      .post('/api/receptions')
      .set({ Authorization: `Bearer ${token}` })
      .send({ level: 'L1', source: 'free' });
    expect(started.body.code).toBe(0);
    const attemptId = started.body.data.attemptId;

    // 关闭实时连接，模拟关闭浏览器
    socket.close();

    let states: string[] = [];
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const rows = await sharedDb.many<{ state: string }>(`SELECT state FROM sessions WHERE attempt_id = $1`, [attemptId]);
      states = rows.map((row) => row.state);
      if (states.length && states.every((state) => state === 'aborted')) break;
      await sleep(1000);
    }
    expect(states.length).toBeGreaterThan(0);
    expect(states.every((state) => state === 'aborted')).toBe(true);

    // 会话全部中止后，接待任务应自动结束
    const attemptRow = await sharedDb.one<{ status: string }>(`SELECT status FROM attempts WHERE id = $1`, [attemptId]);
    expect(attemptRow?.status).not.toBe('running');

    // 还原宽限期，避免影响后续用例
    await request(http)
      .put('/api/settings')
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({ disconnectGraceSec: 60 });
  }, 60000);

  it('个人资料：可保存昵称/手机号/头像，并支持自助修改密码', async () => {
    const adminToken = await login('admin', 'Admin@123');
    await request(http)
      .post('/api/accounts')
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({ username: 'profile_probe', password: 'Probe@123', displayName: '资料探针', roleCode: 'agent' });

    const token = await login('profile_probe', 'Probe@123');
    const auth = { Authorization: `Bearer ${token}` };

    const updated = await request(http)
      .put('/api/auth/profile')
      .set(auth)
      .send({ displayName: '新昵称', mobile: '13900001234', preference: { avatarUrl: '/uploads/avatar.png' } });
    expect(updated.body.code).toBe(0);
    expect(updated.body.data.displayName).toBe('新昵称');
    expect(updated.body.data.avatarUrl).toBe('/uploads/avatar.png');
    expect(updated.body.data.mobile).toBe('139****1234');

    const profile = await request(http).get('/api/auth/profile').set(auth);
    expect(profile.body.data.avatarUrl).toBe('/uploads/avatar.png');
    expect(profile.body.data.mobile).toBe('139****1234');

    const weak = await request(http)
      .post('/api/auth/change-password')
      .set(auth)
      .send({ oldPassword: 'Probe@123', newPassword: 'abcdefgh' });
    expect(weak.body.code).not.toBe(0);

    const wrongOld = await request(http)
      .post('/api/auth/change-password')
      .set(auth)
      .send({ oldPassword: 'not-the-password', newPassword: 'Newpass1' });
    expect(wrongOld.body.code).not.toBe(0);

    const changed = await request(http)
      .post('/api/auth/change-password')
      .set(auth)
      .send({ oldPassword: 'Probe@123', newPassword: 'Newpass1' });
    expect(changed.body.code).toBe(0);
    await expect(login('profile_probe', 'Newpass1')).resolves.toBeTruthy();
  }, 60000);

  it('图片上传：返回可访问地址、校验类型，并写入商品主图与详情图', async () => {
    const uploadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-upload-'));
    process.env.UPLOAD_DIR = uploadRoot;
    const token = await login('admin', 'Admin@123');
    const auth = { Authorization: `Bearer ${token}` };
    // 内容只按 multipart 里的 MIME 判定，这里给一段带 PNG 文件头的字节
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

    try {
      const uploaded = await request(http)
        .post('/api/uploads')
        .set(auth)
        .attach('file', png, { filename: 'cover.png', contentType: 'image/png' });
      expect(uploaded.body.code).toBe(0);
      expect(uploaded.body.data.url).toMatch(/^\/uploads\/.+\.png$/);
      expect(fs.existsSync(path.join(uploadRoot, path.basename(uploaded.body.data.url)))).toBe(true);

      const rejected = await request(http)
        .post('/api/uploads')
        .set(auth)
        .attach('file', Buffer.from('not-an-image'), { filename: 'a.txt', contentType: 'text/plain' });
      expect(rejected.body.code).not.toBe(0);
      const disguised = await request(http).post('/api/uploads').set(auth)
        .attach('file', Buffer.from('not-an-image'), { filename: 'a.png', contentType: 'image/png' });
      expect(disguised.body.code).not.toBe(0);

      const agentToken = await login('agent', 'Agent@123');
      const denied = await request(http)
        .post('/api/uploads')
        .set({ Authorization: `Bearer ${agentToken}` })
        .attach('file', png, { filename: 'c.png', contentType: 'image/png' });
      expect(denied.body.code).toBe(1003);

      const created = await request(http)
        .post('/api/products')
        .set(auth)
        .send({
          productNo: 'IMG-1',
          title: '带图商品',
          price: 10,
          coverUrl: uploaded.body.data.url,
          detailImages: [uploaded.body.data.url],
        });
      expect(created.body.code).toBe(0);

      const detail = await request(http).get(`/api/products/${created.body.data.id}`).set(auth);
      expect(detail.body.data.coverUrl).toBe(uploaded.body.data.url);
      expect(detail.body.data.detailImages).toEqual([uploaded.body.data.url]);
    } finally {
      delete process.env.UPLOAD_DIR;
      fs.rmSync(uploadRoot, { recursive: true, force: true });
    }
  }, 60000);

  // 放在最后：本用例会关闭当前实例，用同一个数据库重新起一个实例来模拟服务重启。
  // 覆盖两件事：①方案 5.11「重启后接待状态可恢复」；②客户需求 C5「重启后待接入队列要能恢复并继续补位」。
  it('买家收尾通知发出时已进入整理阶段，标准收尾语不参与问答判定或扣收尾分', async () => {
    const params = { ...DEFAULT_PARAMS, replyJudgmentVersion: 2, invalidReplyEnabled: true,
      invalidReplyUnresolvedEnabled: true, invalidReplyUnresolvedStreak: 1, banalWords: ['祝购物愉快'] };
    const attempt = await sharedDb.one<{ id: number }>(
      `INSERT INTO attempts (attempt_no, account_id, level, source, param_snapshot)
       VALUES ('AT-closing-message-order', 1, 'L1', 'free', $1::jsonb) RETURNING id`, [JSON.stringify(params)],
    );
    const session = await sharedDb.one<{ id: number }>(
      `INSERT INTO sessions (attempt_id, script_id, buyer_name, state, current_seq, total_questions, questions)
       VALUES ($1, 1, '收尾买家', 'waiting_buyer', 1, 1, $2::jsonb) RETURNING id`,
      [attempt.id, JSON.stringify([{ seq: 1, question: '面料是什么？', keyPoints: ['面料'] }])],
    );
    const reception = app.get(ReceptionService);
    const gateway = app.get(ReceptionGateway);
    let stateWhenNotified: Promise<{ state: string } | null> | undefined;
    const emit = jest.spyOn(gateway, 'emitToUser').mockImplementation((_accountId, event, payload: any) => {
      if (event === 'buyer.message' && payload.naturalEnding) {
        stateWhenNotified = sharedDb.one(`SELECT state FROM sessions WHERE id = $1`, [session.id]);
      }
    });
    try {
      await (reception as any).closeWithBuyerMessage({ id: session.id, attempt_id: attempt.id, current_seq: 1 }, {
        unresolvedGoalIds: [], satisfaction: 75,
      });
      expect(await stateWhenNotified).toEqual({ state: 'awaiting_agent_close' });
      const closing = await reception.sendMessage(1, attempt.id, session.id, '感谢咨询，祝购物愉快');
      expect(closing.ruleResult.judge.signal).toBe('closing');
      expect(closing.ruleResult.invalid).toBeUndefined();
      await reception.finishSession(1, attempt.id, session.id);
      const score = await sharedDb.one<{ deductions: { reason: string }[] }>(
        `SELECT deductions FROM scores WHERE session_id = $1`, [session.id],
      );
      expect(score.deductions.some((item) => item.reason === '结束缺少收尾用语')).toBe(false);
    } finally {
      emit.mockRestore();
      await sharedDb.query(`UPDATE attempts SET status = 'finished' WHERE id = $1`, [attempt.id]);
    }
  });

  it('商品链接开场回复直接推进首个问题，模型故障也不影响推送', async () => {
    const attempt = await sharedDb.one<{ id: number }>(
      `INSERT INTO attempts (attempt_no, account_id, level, source, param_snapshot)
       VALUES ('AT-product-link-opener', 1, 'L1', 'free', $1::jsonb) RETURNING id`,
      [JSON.stringify({ ...DEFAULT_PARAMS, questionPushDelaySec: [0, 0] })],
    );
    const question = '如果想穿得休闲一些，鞋子可以怎么搭配呢？';
    const session = await sharedDb.one<{ id: number }>(
      `INSERT INTO sessions (attempt_id, script_id, buyer_name, state, current_seq, total_questions, questions, opener_pending, last_buyer_at)
       VALUES ($1, 1, '链接买家', 'serving', 0, 1, $2::jsonb, true, now()) RETURNING id`,
      [attempt.id, JSON.stringify([{ seq: 1, question, keyPoints: [] }])],
    );
    await sharedDb.query(
      `INSERT INTO messages (session_id, sender, content, seq, rule_result)
       VALUES ($1, 'buyer', $2, 1, $3::jsonb)`,
      [session.id, '【商品链接】https://haohuo.jinritemai.com/views/product/item2?id=1',
        JSON.stringify({ responseRoundStart: true, responseRoundType: 'opener' })],
    );
    const reception = app.get(ReceptionService);
    const emit = jest.spyOn(app.get(ReceptionGateway), 'emitToUser');
    const model = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('本地模型不可用'));
    const oldMode = process.env.REPLY_JUDGMENT_MODE;
    process.env.REPLY_JUDGMENT_MODE = 'local';
    try {
      const saved = await reception.submitMessage(1, attempt.id, session.id, '亲您好，有什么可以帮您？', true);
      expect(saved.ruleResult).toMatchObject({ judge: { pass: true, signal: 'opener' } });
      await waitFor(() => emit.mock.calls.some(([, event, payload]) =>
        event === 'buyer.message' && !!payload && typeof payload === 'object' &&
        'sessionId' in payload && payload.sessionId === session.id && 'question' in payload));
      const snapshot = await reception.snapshot(1, attempt.id);
      expect(snapshot.sessions[0]).toMatchObject({ state: 'serving', seq: 1, timerPausedAt: null });
      expect(snapshot.messages).toHaveLength(3);
      expect(snapshot.messages.at(-1)).toMatchObject({ sender: 'buyer', content: question });
      expect(model).not.toHaveBeenCalled();
    } finally {
      if (oldMode === undefined) delete process.env.REPLY_JUDGMENT_MODE; else process.env.REPLY_JUDGMENT_MODE = oldMode;
      model.mockRestore();
      emit.mockRestore();
      await sharedDb.query(`UPDATE attempts SET status = 'finished' WHERE id = $1`, [attempt.id]);
    }
  });

  it('本地判定按当前成分问题推进两轮，并保留规则依据和解决分', async () => {
    const attempt = await sharedDb.one<{ id: number }>(
      `INSERT INTO attempts (attempt_no, account_id, level, source, param_snapshot)
       VALUES ('AT-material-disclosure-rounds', 1, 'L1', 'free', $1::jsonb) RETURNING id`,
      [JSON.stringify({ ...DEFAULT_PARAMS, questionPushDelaySec: [600, 600] })],
    );
    const questions = [
      { seq: 1, question: '含棉量大概多少呢？', keyPoints: [], automaticEvaluation: true },
      { seq: 2, question: '这款是聚酯纤维吗？', keyPoints: [], automaticEvaluation: true, topicTransition: true },
    ];
    const products = [{ id: 1, title: '棉感衬衫', attributes: [{ name: '材质', value: '其他纤维22%' }] }];
    const session = await sharedDb.one<{ id: number }>(
      `INSERT INTO sessions (attempt_id, script_id, buyer_name, style_code, state, current_seq, total_questions, questions, products, last_buyer_at)
       VALUES ($1, 1, '成分测试买家', 'impatient', 'serving', 1, 2, $2::jsonb, $3::jsonb, now()) RETURNING id`,
      [attempt.id, JSON.stringify(questions), JSON.stringify(products)],
    );
    await sharedDb.query(
      `INSERT INTO messages (session_id, sender, content, seq, rule_result) VALUES ($1, 'buyer', $2, 1, $3::jsonb)`,
      [session.id, questions[0].question, JSON.stringify({ responseRoundStart: true, responseRoundType: 'question' })],
    );
    const reception = app.get(ReceptionService);
    const oldMode = process.env.REPLY_JUDGMENT_MODE;
    process.env.REPLY_JUDGMENT_MODE = 'local';
    const fetchMock = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('本地模型不可用'));
    try {
      const first = await reception.submitMessage(1, attempt.id, session.id,
        '商品页只标注材质其他纤维22%，确实无单独含棉量数据，暂时无法给准确数字。', true);
      expect(first.ruleResult).toMatchObject({ judge: { pass: true }, replyAssessment: { source: 'rule' } });
      await reception.advanceAfterReply(session.id);
      const pushed = await reception.snapshot(1, attempt.id);
      expect(pushed.messages.at(-1)?.content).toBe('还有个问题，麻烦直接说下：这款是聚酯纤维吗？');
      const second = await reception.submitMessage(1, attempt.id, session.id,
        '商品详情没有注明是否含聚酯纤维，可以帮您核对标签。', true);
      expect(second.ruleResult).toMatchObject({ judge: { pass: true }, replyAssessment: { source: 'rule' } });
      expect(fetchMock).not.toHaveBeenCalled();
      await reception.finishSession(1, attempt.id, session.id);
      const result = await reception.attemptResult(attempt.id);
      expect(result.sessions[0].metrics.solvedCount).toBe(2);
    } finally {
      fetchMock.mockRestore();
      if (oldMode === undefined) delete process.env.REPLY_JUDGMENT_MODE; else process.env.REPLY_JUDGMENT_MODE = oldMode;
      (reception as any).scheduler.cancel(`next:${session.id}`);
      await sharedDb.query(`UPDATE attempts SET status = 'finished' WHERE id = $1`, [attempt.id]);
    }
  });

  it('服务重启恢复：进行中的接待不被中止，待接入队列保留且能继续补位', async () => {
    // 自由练习只对管理员/主管开放（客户新增需求）
    const token = await login('admin', 'Admin@123');
    const auth = { Authorization: `Bearer ${token}` };
    // C5：L2 同时在线 2 人、本次合计接待 4 人 → 开局 2 个接入 + 2 个待接入
    await request(http)
      .put('/api/settings')
      .set(auth)
      .send({ maxConcurrent: 4, levelConcurrent: { L2: 2 }, levelTotal: { L2: 4 } });
    const started = await request(http)
      .post('/api/receptions')
      .set(auth)
      .send({ level: 'L2', source: 'free' });
    expect(started.body.code).toBe(0);
    const attemptId = started.body.data.attemptId;
    const beforeRestart = started.body.data.sessions;
    expect(beforeRestart.filter((s: any) => s.state === 'pending')).toHaveLength(2);
    expect(beforeRestart.filter((s: any) => s.state === 'wait')).toHaveLength(2);

    // 模拟服务重启：当前实例关闭（内存定时器全部丢失），数据库里的状态保留
    await app.close();
    app = null;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DbService)
      .useValue(sharedDb)
      .compile();
    const restarted = moduleRef.createNestApplication();
    restarted.useGlobalFilters(new AllExceptionsFilter());
    restarted.useGlobalInterceptors(new ResponseInterceptor());
    const http2 = await restarted.listen(0);

    const socket: Socket = io(`http://127.0.0.1:${(http2.address() as any).port}`, {
      path: '/realtime',
      auth: { token },
      transports: ['websocket'],
    });
    const buyerMessages: any[] = [];
    socket.on('buyer.message', (payload: any) => buyerMessages.push(payload));

    try {
      await new Promise<void>((resolve, reject) => {
        const guard = setTimeout(() => reject(new Error('重连超时')), 5000);
        socket.on('reception.connected', () => {
          clearTimeout(guard);
          resolve();
        });
        socket.on('connect_error', (err) => {
          clearTimeout(guard);
          reject(err);
        });
      });

      // 接待仍在进行中，而不是被判定为异常中止
      const snap = await request(http2)
        .get(`/api/receptions/${attemptId}/snapshot`)
        .set(auth);
      expect(snap.body.code).toBe(0);
      expect(snap.body.data.attempt.status).toBe('running');
      const afterRestart = snap.body.data.sessions;
      expect(afterRestart.some((s: any) => s.state === 'aborted')).toBe(false);
      // C5：重启后「同时在线」与「待接入」的分布不变（待接入的买家没有被丢掉、也没有被提前放进来）
      expect(afterRestart.filter((s: any) => s.state === 'pending')).toHaveLength(2);
      expect(
        afterRestart.filter((s: any) => !['finished', 'transferred', 'aborted', 'pending'].includes(s.state))
      ).toHaveLength(2);

      // 重启后重新挂载的进线推送应当把买家问题推出来
      await waitFor(() => buyerMessages.length > 0, 10000);
      expect(buyerMessages[0].attemptId).toBe(attemptId);
      expect(buyerMessages[0].contents?.length).toBeGreaterThan(0);

      // C5：结束一个正在接待的会话 → 待接入 2 → 1，同时在线仍是 2（补位逻辑在重启后的实例上照样生效）
      const activeOne = afterRestart.find(
        (s: any) => !['finished', 'transferred', 'aborted', 'pending'].includes(s.state)
      );
      const finished = await request(http2)
        .post(`/api/receptions/${attemptId}/sessions/${activeOne.sessionId}/finish`)
        .set(auth)
        .send({});
      expect(finished.body.code).toBe(0);
      // 补位带定时器，轮询等一下（waitFor 只支持同步断言，这里直接轮询）
      let promoted: any[] = [];
      for (let i = 0; i < 40; i += 1) {
        const again = await request(http2).get(`/api/receptions/${attemptId}/snapshot`).set(auth);
        promoted = again.body.data?.sessions || [];
        if (promoted.filter((s: any) => s.state === 'pending').length === 1) break;
        await sleep(150);
      }
      expect(promoted.filter((s: any) => s.state === 'pending')).toHaveLength(1);
      expect(
        promoted.filter((s: any) => !['finished', 'transferred', 'aborted', 'pending'].includes(s.state))
      ).toHaveLength(2);
    } finally {
      socket.close();
      await restarted.close();
    }
  }, 60000);

});
