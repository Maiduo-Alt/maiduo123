/**
 * 断线超时判定（方案 4.1 / 4.7 / 4.8）。
 *
 * 规则：客服端**曾经连接过**实时通道、当前**没有活动连接**，且超过宽限期没有任何信号，
 * 进行中的会话按异常中止处理（0 分计入接待任务）。
 *
 * 计时起点取「接待开始时刻」与「最后一次在线时刻」里**较晚**的一个，这一点很关键：
 * 客服早就关掉浏览器（离线时间已远超宽限期），之后再用 HTTP 开一局时，
 * 若只按「最后在线时间」算，这一局会在下一秒就被判异常中止——那不是规则的本意。
 */
export function shouldAbortAsDisconnected(input: {
  /** 接待开始时间戳 */
  startedAt: number;
  /** 该账号最后一次在线时间戳（0 表示从未连过） */
  lastSeenAt: number;
  /** 当前活动连接数 */
  sockets: number;
  /** 是否曾经连接过实时通道 */
  everConnected: boolean;
  /** 当前时间戳 */
  now: number;
  /** 宽限期（毫秒） */
  graceMs: number;
}): boolean {
  const { startedAt, lastSeenAt, sockets, everConnected, now, graceMs } = input;
  // 只用 HTTP 调接口、从未建立实时连接的账号不判（避免误伤脚本与自测）
  if (!everConnected) return false;
  if (sockets > 0) return false;
  const reference = Math.max(startedAt || 0, lastSeenAt || 0);
  return now - reference > graceMs;
}
