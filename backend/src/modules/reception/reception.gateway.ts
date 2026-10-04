import { Logger } from '@nestjs/common';
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

/** 实时通道：推送买家消息、计时同步与超时提醒。 */
@WebSocketGateway({
  path: '/realtime',
  cors: { origin: true, credentials: true },
})
export class ReceptionGateway implements OnGatewayConnection, OnGatewayDisconnect {
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

  constructor(private readonly jwt: JwtService) {}

  async handleConnection(socket: Socket): Promise<void> {
    try {
      const token =
        (socket.handshake.auth?.token as string) ||
        (socket.handshake.query?.token as string) ||
        (socket.handshake.headers?.authorization as string)?.replace('Bearer ', '');
      const payload: any = await this.jwt.verifyAsync(token);
      socket.data.userId = payload.sub;
      await socket.join(`user:${payload.sub}`);
      this.touch(payload.sub, 1);
      socket.emit('reception.connected', { userId: payload.sub });
    } catch {
      socket.emit('reception.error', { message: '鉴权失败' });
      socket.disconnect(true);
    }
  }

  handleDisconnect(socket: Socket): void {
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
  handleClientAck(@ConnectedSocket() socket: Socket, @MessageBody() payload: any) {
    const userId = socket.data.userId as number | undefined;
    if (!userId) return { ok: false };
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
