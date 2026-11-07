import { RecordsService } from '../../src/modules/records/records.service';

describe('接待列表平均响应时间', () => {
  it('按有效轮次汇总历史消息，计入无回复并保留精度，排除单题买家离场', async () => {
    const questions = (count: number) => Array.from({ length: count }, (_, i) => ({ seq: i + 1, question: '问题', keyPoints: [] }));
    const db: any = {
      one: jest.fn().mockResolvedValue({ count: '1' }),
      many: jest.fn()
        .mockResolvedValueOnce([{ id: 10, startedAt: '2026-01-01', finishedAt: '2026-01-01' }])
        .mockResolvedValueOnce([
          { id: 1, attempt_id: 10, total_questions: 3, current_seq: 3, questions: questions(3), skipped_seqs: [] },
          { id: 2, attempt_id: 10, total_questions: 1, current_seq: 1, questions: questions(1), skipped_seqs: [] },
          { id: 3, attempt_id: 10, total_questions: 1, current_seq: 1, questions: questions(1), skipped_seqs: [] },
        ])
        .mockResolvedValueOnce([
          { session_id: 1, sender: 'agent', seq: 1, response_sec: 1 },
          { session_id: 1, sender: 'agent', seq: 2, response_sec: 2 },
          { session_id: 2, sender: 'agent', seq: 1, response_sec: 3 },
          { session_id: 3, sender: 'buyer', seq: 1, response_sec: null },
        ])
        .mockResolvedValueOnce([{ attempt_id: 10, sessionCount: 3, earlyCount: 1, timeoutCount: 0 }])
        .mockResolvedValueOnce([]),
    };
    const service = new RecordsService(db);
    const result = await service.list({ id: 1, username: 'a', displayName: 'a', roleCode: 'admin', groupId: null }, {});
    expect(result.list[0].avgResponseSec).toBe(151.5);
  });
});
