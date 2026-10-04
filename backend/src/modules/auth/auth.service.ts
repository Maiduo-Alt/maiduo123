import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { DbService } from '../../db/db.service';
import { BizError, ERR } from '../../common/errors';
import { maskMobile } from '../../common/mask';
import { SettingsService } from '../settings/settings.service';

interface AccountRow {
  id: number;
  username: string;
  password_hash: string;
  display_name: string;
  role_code: string;
  group_id: number | null;
  status: number;
  mobile: string | null;
  employee_no: string | null;
  preference: any;
  login_fail_count: number;
  locked_until: string | null;
  password_changed_at: string | null;
  must_change_password: boolean;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DbService,
    private readonly jwt: JwtService,
    private readonly settings: SettingsService
  ) {}

  async login(username: string, password: string) {
    const account = await this.db.one<AccountRow>(`SELECT * FROM accounts WHERE username = $1`, [username]);
    if (!account) throw new BizError(ERR.UNAUTHORIZED, '用户名或密码错误');
    if (account.status !== 1) throw new BizError(ERR.FORBIDDEN, '账号已停用，请联系管理员');

    // 方案 F8-10：连续失败锁定
    const params = await this.settings.getParams();
    if (account.locked_until && Date.parse(account.locked_until) > Date.now()) {
      const minutes = Math.max(1, Math.ceil((Date.parse(account.locked_until) - Date.now()) / 60000));
      throw new BizError(ERR.FORBIDDEN, `账号已锁定，请 ${minutes} 分钟后再试`);
    }

    const matched = bcrypt.compareSync(password, account.password_hash);
    if (!matched) {
      const failures = Number(account.login_fail_count || 0) + 1;
      const shouldLock = params.loginMaxFailures > 0 && failures >= params.loginMaxFailures;
      const lockUntil = shouldLock ? new Date(Date.now() + params.loginLockMinutes * 60000).toISOString() : null;
      await this.db.query(
        `UPDATE accounts SET login_fail_count = $2, locked_until = $3 WHERE id = $1`,
        [account.id, shouldLock ? 0 : failures, lockUntil]
      );
      if (shouldLock) {
        throw new BizError(
          ERR.FORBIDDEN,
          `连续输错 ${params.loginMaxFailures} 次，账号已锁定 ${params.loginLockMinutes} 分钟`
        );
      }
      throw new BizError(ERR.UNAUTHORIZED, `用户名或密码错误（还可尝试 ${params.loginMaxFailures - failures} 次）`);
    }

    const token = await this.jwt.signAsync({
      sub: account.id,
      username: account.username,
      displayName: account.display_name,
      roleCode: account.role_code,
      groupId: account.group_id,
    });
    await this.db.query(
      `UPDATE accounts SET last_login_at = now(), login_fail_count = 0, locked_until = NULL WHERE id = $1`,
      [account.id]
    );

    // 方案 F8-10：密码有效期与强制首次改密
    const expiredDays = params.passwordMaxAgeDays;
    const changedAt = account.password_changed_at ? Date.parse(account.password_changed_at) : null;
    const passwordExpired = Boolean(
      expiredDays > 0 && changedAt && Date.now() - changedAt > expiredDays * 24 * 3600 * 1000
    );
    const mustChangePassword = Boolean(account.must_change_password) || passwordExpired;
    return {
      token,
      profile: this.toProfile(account),
      mustChangePassword,
      passwordExpired,
      notice: passwordExpired
        ? `密码已超过 ${expiredDays} 天有效期，请立即修改`
        : account.must_change_password
          ? '管理员已重置你的密码，请登录后立即修改'
          : null,
    };
  }

  async profile(accountId: number) {
    const account = await this.db.one<AccountRow>(`SELECT * FROM accounts WHERE id = $1`, [accountId]);
    if (!account) throw new BizError(ERR.NOT_FOUND, '账号不存在');
    return this.toProfile(account);
  }

  /**
   * 续签访问令牌（方案 7.2 `/api/auth/refresh`）。
   * 需要携带仍有效的令牌；账号被停用时拒绝续签，避免停用后旧令牌长期可用。
   */
  async refresh(accountId: number) {
    const account = await this.db.one<AccountRow>(`SELECT * FROM accounts WHERE id = $1`, [accountId]);
    if (!account) throw new BizError(ERR.UNAUTHORIZED, '账号不存在');
    if (account.status !== 1) throw new BizError(ERR.FORBIDDEN, '账号已停用，请联系管理员');
    const token = await this.jwt.signAsync({
      sub: account.id,
      username: account.username,
      displayName: account.display_name,
      roleCode: account.role_code,
      groupId: account.group_id,
    });
    return { token, profile: this.toProfile(account) };
  }

  async updateProfile(accountId: number, patch: { displayName?: string; mobile?: string; preference?: any }) {
    await this.db.query(
      `UPDATE accounts SET display_name = COALESCE($2, display_name),
                           mobile = COALESCE($3, mobile),
                           preference = COALESCE($4::jsonb, preference),
                           updated_at = now()
       WHERE id = $1`,
      [accountId, patch.displayName ?? null, patch.mobile ?? null, patch.preference ? JSON.stringify(patch.preference) : null]
    );
    return this.profile(accountId);
  }

  async changePassword(accountId: number, oldPassword: string, newPassword: string) {
    const account = await this.db.one<AccountRow>(`SELECT * FROM accounts WHERE id = $1`, [accountId]);
    if (!account) throw new BizError(ERR.NOT_FOUND, '账号不存在');
    if (!bcrypt.compareSync(oldPassword, account.password_hash)) {
      throw new BizError(ERR.PARAM, '原密码不正确');
    }
    this.assertPasswordStrength(newPassword);
    await this.db.query(
      `UPDATE accounts SET password_hash = $2, password_changed_at = now(), must_change_password = false, updated_at = now()
       WHERE id = $1`,
      [accountId, bcrypt.hashSync(newPassword, 10)]
    );
    return { success: true };
  }

  assertPasswordStrength(password: string): void {
    if (!password || password.length < 8) throw new BizError(ERR.PARAM, '密码长度至少 8 位');
    const hasLetter = /[A-Za-z]/.test(password);
    const hasDigit = /\d/.test(password);
    if (!hasLetter || !hasDigit) throw new BizError(ERR.PARAM, '密码需同时包含字母与数字');
  }

  private toProfile(account: AccountRow) {
    return {
      id: account.id,
      username: account.username,
      displayName: account.display_name,
      roleCode: account.role_code,
      groupId: account.group_id,
      employeeNo: account.employee_no,
      mobile: maskMobile(account.mobile),
      // 头像存 preference.avatarUrl（不新增列，避免对已有库做结构变更）
      preference: account.preference || {},
      avatarUrl: (account.preference || {}).avatarUrl || null,
    };
  }
}
