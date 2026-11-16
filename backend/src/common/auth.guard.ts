import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY, ROLES_KEY, AuthUser } from './decorators';
import { BizError, ERR } from './errors';
import { DbService } from '../db/db.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
    private readonly db: DbService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest();
    const header: string = req.headers?.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new BizError(ERR.UNAUTHORIZED, '未登录或登录状态已过期');

    let payload: any;
    try {
      payload = await this.jwtService.verifyAsync(token);
    } catch {
      throw new BizError(ERR.UNAUTHORIZED, '未登录或登录状态已过期');
    }
    const account = await this.db.one<{ id: number; username: string; display_name: string; role_code: string; group_id: number | null; status: number; must_change_password: boolean; token_version: number }>(
      `SELECT id, username, display_name, role_code, group_id, status, must_change_password, token_version FROM accounts WHERE id = $1 AND deleted_at IS NULL`, [payload.sub]
    );
    if (!account || account.status !== 1) throw new BizError(ERR.UNAUTHORIZED, '账号已停用或不存在');
    if (payload.tokenVersion !== account.token_version) throw new BizError(ERR.UNAUTHORIZED, '登录状态已失效，请重新登录');
    if (account.must_change_password && !['/api/auth/profile', '/api/auth/change-password', '/api/auth/logout'].includes(req.path)) {
      throw new BizError(ERR.FORBIDDEN, '请先修改密码');
    }
    const user: AuthUser = {
      id: account.id,
      username: account.username,
      displayName: account.display_name,
      roleCode: account.role_code,
      groupId: account.group_id,
    };
    req.user = user;

    const roles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (roles && roles.length && !roles.includes(user.roleCode)) {
      throw new BizError(ERR.FORBIDDEN, '无操作权限');
    }
    return true;
  }
}
