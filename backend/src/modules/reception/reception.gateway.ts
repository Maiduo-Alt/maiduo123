import { Logger, OnModuleDestroy } from '@nestjs/common';
import {
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { ConnectedSocket } from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { DbService } from '../../db/db.service';
import { SessionEvents } from '../../common/session-events';

/** 实时通道：推送买家消息、计时同步与超时提醒。 */
@WebSocketGateway({
  path: '/realtime',
  cors: { origin: true, credentials: true },
})
export class ReceptionGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  private readonly logger = new Logger(ReceptionGateway.name);

  @WebSocketServer()
  server!: Server;

  /** 前端心跳（client.ack）记录：用于判断客服端是否在线，辅助计时推送与诊断。 */
  private readonly acks = new Map<number, { at: string; sessionId?: number; readSessionIds?: number[] }>();

  /** 在线状态：用于断线超时判定（方案 4.7 / 4.8 关闭浏览器超过 60 秒视为异常中止）。 */
  private readonly presence = new Map<number, { sockets: number; lastSeenAt: number; everConnected: boolean }>();

  private touch(userId: number, socketDelta: number): void {
    const state = this.presence.get(userId) || { sockets: 0, lastSeenAt: Date.now(), everConnected: false };
    state.sockets = Math.max(0, state.sockets + socketDelta);
    state.lastSeenAt = Date.now();
    if (socketDelta > 0) state.everConnected = true;
    this.presence.set(userId, state);
  }

  /** 账号的在线状态快照，供断线超时判定使用（判定口径见 domain/disconnect.ts）。 */
  presenceOf(userId: number): { sockets: number; lastSeenAt: number; everConnected: boolean } {
    const state = this.presence.get(userId);
    return state
      ? { sockets: state.sockets, lastSeenAt: state.lastSeenAt, everConnected: state.everConnected }
      : { sockets: 0, lastSeenAt: 0, everConnected: false };
  }

  private readonly revokeSockets = (userId: number) => this.server?.in(`user:${userId}`).disconnectSockets(true);

  constructor(private readonly jwt: JwtService, private readonly db: DbService, private readonly events: SessionEvents) {
    this.events.on('revoke', this.revokeSockets);
  }

  onModuleDestroy(): void {
    this.events.off('revoke', this.revokeSockets);
  }

  async handleConnection(socket: Socket): Promise<void> {
    try {
      const token =
        (socket.handshake.auth?.token as string) ||
        (socket.handshake.query?.token as string) ||
        (socket.handshake.headers?.authorization as string)?.replace('Bearer ', '');
      const payload: any = await this.jwt.verifyAsync(token);
      const account = await this.db.one<{ status: number; must_change_password: boolean; token_version: number }>(
        `SELECT status, must_change_password, token_version FROM accounts WHERE id = $1 AND deleted_at IS NULL`, [payload.sub],
      );
      if (!account || account.status !== 1 || account.must_change_password || account.token_version !== payload.tokenVersion) throw new Error('无效会话');
      socket.data.userId = payload.sub;
      socket.data.token = token;
      await socket.join(`user:${payload.sub}`);
      socket.data.expiryTimer = setTimeout(() => socket.disconnect(true), Math.max(0, payload.exp * 1000 - Date.now()));
      this.touch(payload.sub, 1);
      socket.emit('reception.connected', { userId: payload.sub });
    } catch {
      socket.emit('reception.error', { message: '鉴权失败' });
      socket.disconnect(true);
    }
  }

  handleDisconnect(socket: Socket): void {
    clearTimeout(socket.data?.expiryTimer);
    this.logger.debug(`客户端断开: ${socket.id}`);
    const userId = socket.data?.userId as number | undefined;
    if (userId) this.touch(userId, -1);
  }

  emitToUser(userId: number, event: string, payload: unknown): void {
    if (!this.server) return;
    this.server.to(`user:${userId}`).emit(event, payload);
  }

  /**
   * 客户端每秒心跳（方案 5.5 的 client.ack）：携带当前焦点会话与已读会话。
   * 计时权威在服务端，这里只记录在线状态与焦点，供计时推送附带健康信息。
   */
  @SubscribeMessage('client.ack')
  async handleClientAck(@ConnectedSocket() socket: Socket, @MessageBody() payload: any) {
    const userId = socket.data.userId as number | undefined;
    if (!userId) return { ok: false };
    try {
      const claims: any = await this.jwt.verifyAsync(socket.data.token);
      const account = await this.db.one<{ status: number; must_change_password: boolean; token_version: number }>(
        `SELECT status, must_change_password, token_version FROM accounts WHERE id = $1 AND deleted_at IS NULL`, [userId],
      );
      if (!account || account.status !== 1 || account.must_change_password || account.token_version !== claims.tokenVersion) throw new Error('无效会话');
    } catch {
      socket.disconnect(true);
      return { ok: false };
    }
    this.touch(userId, 0);
    this.acks.set(userId, {
      at: new Date().toISOString(),
      sessionId: typeof payload?.sessionId === 'number' ? payload.sessionId : undefined,
      readSessionIds: Array.isArray(payload?.readSessionIds) ? payload.readSessionIds : undefined,
    });
    return { ok: true, serverTime: new Date().toISOString() };
  }

  lastAck(userId: number): { at: string; sessionId?: number; readSessionIds?: number[] } | null {
    return this.acks.get(userId) || null;
  }
}
