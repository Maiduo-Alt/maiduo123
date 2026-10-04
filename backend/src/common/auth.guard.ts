import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY, ROLES_KEY, AuthUser } from './decorators';
import { BizError, ERR } from './errors';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService
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
    const user: AuthUser = {
      id: payload.sub,
      username: payload.username,
      displayName: payload.displayName,
      roleCode: payload.roleCode,
      groupId: payload.groupId ?? null,
    };
    req.user = user;

    const roles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (roles && roles.length && !roles.includes(user.roleCode)) {
      throw new BizError(ERR.FORBIDDEN, '无操作权限');
    }
    return true;
  }
}
