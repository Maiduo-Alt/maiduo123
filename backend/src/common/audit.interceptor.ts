import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { DbService } from '../db/db.service';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SENSITIVE_KEYS = ['password', 'newPassword', 'oldPassword', 'passwordHash', 'token'];
const MAX_STRING_LENGTH = 200;

/** 审计明细里的值做脱敏与截断：不写密码，也不把 base64 文件内容塞进日志。 */
function sanitize(value: any, depth = 0): any {
  if (depth > 3 || value === null || typeof value !== 'object') {
    if (typeof value === 'string' && value.length > MAX_STRING_LENGTH) {
      return `${value.slice(0, MAX_STRING_LENGTH)}...(truncated ${value.length})`;
    }
    return value;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitize(item, depth + 1));
  const out: Record<string, any> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_KEYS.includes(key) ? '***' : sanitize(item, depth + 1);
  }
  return out;
}

/**
 * 操作审计（方案 5.11 安全：操作类接口写审计日志）。
 *
 * 对所有写操作（POST/PUT/PATCH/DELETE）在请求结束后写入 action_logs，
 * 记录操作人、动作、路径、脱敏后的请求体与结果状态；失败也不影响业务响应。
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(private readonly db: DbService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const method: string = req?.method || '';
    if (!WRITE_METHODS.has(method)) return next.handle();

    const accountId: number | null = req?.user?.id ?? null;
    // 避免把 id 写进动作名，保证同一类操作可聚合
    const routePath = String(req?.route?.path || req?.url || 'unknown').replace(/\/\d+(?=\/|$)/g, '/:id');
    const action = `${method} ${routePath}`.slice(0, 64);
    const base = {
      path: req?.originalUrl || req?.url,
      params: sanitize(req?.params),
      body: sanitize(req?.body),
    };

    const write = (ok: boolean) => {
      this.db
        .query(`INSERT INTO action_logs (account_id, action, detail) VALUES ($1,$2,$3::jsonb)`, [
          accountId,
          action,
          JSON.stringify({ ...base, ok }),
        ])
        .catch((err) => this.logger.warn(`审计日志写入失败 ${action}: ${(err as Error).message}`));
    };

    return next.handle().pipe(
      tap({
        next: () => write(true),
        error: () => write(false),
      })
    );
  }
}
