/** 页面只显示服务端计时的推算值；超时和评分仍由服务器决定。 */
export function projectSessionTimer<T extends {
  state: string;
  timerMode: 'response' | 'agent_close';
  lastBuyerAt?: string | null;
  closeDeadlineAt?: string | null;
  timeoutLimitSec: number;
}>(session: T, serverNow: number | null): T & { waitedSec?: number; remainSec?: number; closeRemainSec?: number } {
  if (serverNow === null) return session;
  if (session.timerMode === 'agent_close' && session.closeDeadlineAt) {
    const remaining = Math.max(0, Math.ceil((Date.parse(session.closeDeadlineAt) - serverNow) / 1000));
    return { ...session, remainSec: remaining, closeRemainSec: remaining };
  }
  if ((session.state === 'serving' || session.state === 'timeout') && session.lastBuyerAt) {
    const waited = Math.max(0, Math.round((serverNow - Date.parse(session.lastBuyerAt)) / 1000));
    return { ...session, waitedSec: waited, remainSec: Math.max(0, session.timeoutLimitSec - waited) };
  }
  return session;
}
