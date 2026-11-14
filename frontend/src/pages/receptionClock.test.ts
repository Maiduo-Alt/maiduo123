import { describe, expect, it } from 'vitest';
import { projectSessionTimer } from './receptionClock';

const start = Date.parse('2026-11-14T10:00:00.000Z');
const session = { state: 'serving', timerMode: 'response' as const, lastBuyerAt: new Date(start).toISOString(), timeoutLimitSec: 45, waitedSec: 0, remainSec: 45 };

describe('接待计时显示', () => {
  it('用服务端时间与买家消息起点计算等待和剩余时间', () => {
    expect(projectSessionTimer(session, start + 19100)).toMatchObject({ waitedSec: 19, remainSec: 26 });
    expect(projectSessionTimer(session, start + 50000)).toMatchObject({ waitedSec: 50, remainSec: 0 });
  });

  it('客服回复后不继续增长等待时间', () => {
    const replied = { ...session, state: 'waiting_buyer', waitedSec: 0, remainSec: 45 };
    expect(projectSessionTimer(replied, start + 20000)).toEqual(replied);
  });

  it('整理阶段使用服务端截止时间倒计时', () => {
    const closing = { ...session, state: 'awaiting_agent_close', timerMode: 'agent_close' as const, closeDeadlineAt: new Date(start + 30000).toISOString() };
    expect(projectSessionTimer(closing, start + 10500)).toMatchObject({ remainSec: 20, closeRemainSec: 20 });
  });

  it('未收到服务端时间或等待买家尚未进线时沿用服务端数据', () => {
    expect(projectSessionTimer(session, null)).toEqual(session);
    const waiting = { ...session, state: 'wait', lastBuyerAt: null };
    expect(projectSessionTimer(waiting, start + 20000)).toEqual(waiting);
  });

  it('已显示在当前会话的买家在首条消息之前也开始计时', () => {
    const joined = { ...session, state: 'wait' };
    expect(projectSessionTimer(joined, start + 9000)).toMatchObject({ waitedSec: 9, remainSec: 36 });
  });
});
