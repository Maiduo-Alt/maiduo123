import { shouldAbortAsDisconnected } from '../../src/domain/disconnect';

describe('断线超时判定（方案 4.1 / 4.7 / 4.8）', () => {
  const base = { sockets: 0, everConnected: true, now: 1_000_000, graceMs: 60_000 };

  it('从未连接过实时通道的账号不判异常（脚本 / 纯 HTTP 调用）', () => {
    expect(shouldAbortAsDisconnected({ ...base, everConnected: false, startedAt: 0, lastSeenAt: 0 })).toBe(false);
  });

  it('当前还有活动连接时不判异常', () => {
    expect(shouldAbortAsDisconnected({ ...base, sockets: 1, startedAt: 0, lastSeenAt: 0 })).toBe(false);
  });

  it('离线时间超过宽限期时判定为异常中止', () => {
    expect(
      shouldAbortAsDisconnected({ ...base, startedAt: base.now - 10 * 60_000, lastSeenAt: base.now - 61_000 })
    ).toBe(true);
    expect(
      shouldAbortAsDisconnected({ ...base, startedAt: base.now - 10 * 60_000, lastSeenAt: base.now - 30_000 })
    ).toBe(false);
  });

  it('计时起点取「接待开始」与「最后在线」里较晚的一个', () => {
    // 客服半小时前就离线了，但这一局是刚刚开的 —— 不能下一秒就判异常中止
    const justStarted = base.now - 2_000;
    expect(shouldAbortAsDisconnected({ ...base, startedAt: justStarted, lastSeenAt: base.now - 30 * 60_000 })).toBe(false);
    // 同一局等到超过宽限期，才该被判异常
    expect(
      shouldAbortAsDisconnected({ ...base, startedAt: justStarted, lastSeenAt: base.now - 30 * 60_000, now: base.now + 65_000 })
    ).toBe(true);
  });

  it('在接待过程中掉线：从掉线时刻起算宽限期', () => {
    const startedAt = base.now - 5 * 60_000;
    expect(shouldAbortAsDisconnected({ ...base, startedAt, lastSeenAt: base.now - 59_000 })).toBe(false);
    expect(shouldAbortAsDisconnected({ ...base, startedAt, lastSeenAt: base.now - 61_000 })).toBe(true);
  });
});
