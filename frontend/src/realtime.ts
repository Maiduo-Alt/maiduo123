import { io, Socket } from 'socket.io-client';
import { API_BASE, getToken } from './api/client';

let socket: Socket | null = null;

export function connectRealtime(onEvent: (event: string, payload: any) => void): () => void {
  if (socket) socket.disconnect();
  /**
   * 实时通道地址：同域部署时用默认（浏览器当前域），前后端分开部署时用 VITE_SOCKET_URL
   * （或复用 VITE_API_BASE）。见 deploy/FREE.md。
   */
  const socketUrl = String((import.meta as any).env?.VITE_SOCKET_URL || API_BASE || '') || undefined;
  socket = io(socketUrl, {
    path: '/realtime',
    auth: { token: getToken() },
    transports: ['websocket', 'polling'],
  });
  const events = [
    'reception.connected',
    'reception.ready',
    'buyer.message',
    'agent.message.ack',
    'session.finished',
    'reception.finished',
    'timeout.warning',
    'session.transferred',
    'timer.tick',
  ];
  events.forEach((e) => socket!.on(e, (payload: any) => onEvent(e, payload)));
  return () => {
    socket?.disconnect();
    socket = null;
  };
}

export function disconnectRealtime(): void {
  socket?.disconnect();
  socket = null;
}

/**
 * 每秒心跳（方案 5.5 的 client.ack）：告知服务端当前焦点会话与已读会话。
 * 计时以服务端 timer.tick 为准，这里只上报客户端状态。
 */
export function sendClientAck(payload: { sessionId?: number; readSessionIds?: number[] }): void {
  socket?.emit('client.ack', payload);
}
