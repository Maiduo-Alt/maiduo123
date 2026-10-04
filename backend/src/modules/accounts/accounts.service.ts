import { Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { DbService } from '../../db/db.service';
import { BizError, ERR } from '../../common/errors';
import { maskMobile } from '../../common/mask';
import { normalizePage, pageResult, PageQuery } from '../../common/pagination';

@Injectable()
export class AccountsService {
  constructor(private readonly db: DbService) {}

  async list(query: PageQuery & { role?: string; groupId?: string; status?: string; keyword?: string }) {
    const { page, pageSize, offset, limit } = normalizePage(query);
    const where: string[] = ['1=1'];
    const args: unknown[] = [];
    if (query.role) {
      args.push(query.role);
      where.push(`a.role_code = $${args.length}`);
    }
    if (query.groupId) {
      args.push(Number(query.groupId));
      where.push(`a.group_id = $${args.length}`);
    }
    if (query.status !== undefined && query.status !== '') {
      args.push(Number(query.status));
      where.push(`a.status = $${args.length}`);
    }
    if (query.keyword) {
      args.push(`%${query.keyword}%`);
      where.push(`(a.username ILIKE $${args.length} OR a.display_name ILIKE $${args.length})`);
    }
    const whereSql = where.join(' AND ');
    const totalRow = await this.db.one<{ count: string }>(`SELECT count(*)::text AS count FROM accounts a WHERE ${whereSql}`, args);
    const rows = await this.db.many(
      `SELECT a.id, a.username, a.display_name AS "displayName", a.employee_no AS "employeeNo",
              a.role_code AS "roleCode", a.group_id AS "groupId", g.name AS "groupName",
              a.status, a.mobile, a.last_login_at AS "lastLoginAt"
       FROM accounts a LEFT JOIN groups g ON g.id = a.group_id
       WHERE ${whereSql}
       ORDER BY a.id
       OFFSET $${args.length + 1} LIMIT $${args.length + 2}`,
      [...args, offset, limit]
    );
    // 方案 5.11 安全：手机号属敏感字段，列表接口同样脱敏返回
    const masked = (rows as any[]).map((row) => ({ ...row, mobile: maskMobile(row.mobile) }));
    return pageResult(masked, Number(totalRow.count), page, pageSize);
  }

  async create(body: { username: string; password: string; displayName: string; roleCode: string; groupId?: number; employeeNo?: string; mobile?: string }) {
    if (!body.username || !body.displayName) throw new BizError(ERR.PARAM, '用户名与姓名为必填项');
    if (!body.password || body.password.length < 8) throw new BizError(ERR.PARAM, '密码长度至少 8 位');
    const exists = await this.db.one(`SELECT id FROM accounts WHERE username = $1`, [body.username]);
    if (exists) throw new BizError(ERR.PARAM, '用户名已存在');
    const row = await this.db.one<{ id: number }>(
      `INSERT INTO accounts (username, password_hash, display_name, role_code, group_id, employee_no, mobile)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        body.username,
        bcrypt.hashSync(body.password, 10),
        body.displayName,
        body.roleCode || 'agent',
        body.groupId ?? null,
        body.employeeNo ?? null,
        body.mobile ?? null,
      ]
    );
    return { id: row.id };
  }

  async update(id: number, body: any) {
    await this.db.query(
      `UPDATE accounts SET display_name = COALESCE($2, display_name),
                           role_code = COALESCE($3, role_code),
                           group_id = COALESCE($4, group_id),
                           employee_no = COALESCE($5, employee_no),
                           mobile = COALESCE($6, mobile),
                           status = COALESCE($7, status),
                           updated_at = now()
       WHERE id = $1`,
      [id, body.displayName ?? null, body.roleCode ?? null, body.groupId ?? null, body.employeeNo ?? null, body.mobile ?? null, body.status ?? null]
    );
    return { success: true };
  }

  async resetPassword(id: number, password: string) {
    if (!password || password.length < 8) throw new BizError(ERR.PARAM, '密码长度至少 8 位');
    // 方案 F8-10：管理员重置密码后，本人登录时必须先改密
    await this.db.query(
      `UPDATE accounts SET password_hash = $2, password_changed_at = now(), must_change_password = true,
                           login_fail_count = 0, locked_until = NULL, updated_at = now()
       WHERE id = $1`,
      [id, bcrypt.hashSync(password, 10)]
    );
    return { success: true };
  }

  async listGroups() {
    return this.db.many(`SELECT g.id, g.name, g.status, count(a.id)::int AS "memberCount"
                         FROM groups g LEFT JOIN accounts a ON a.group_id = g.id AND a.status = 1
                         GROUP BY g.id ORDER BY g.id`);
  }

  async createGroup(name: string) {
    if (!name) throw new BizError(ERR.PARAM, '小组名称不能为空');
    const row = await this.db.one<{ id: number }>(`INSERT INTO groups (name) VALUES ($1) RETURNING id`, [name]);
    return { id: row.id };
  }

  /** 更新小组（方案 7.2 小组 GET / POST / PUT）。 */
  async updateGroup(id: number, body: { name?: string; status?: number }) {
    const exists = await this.db.one(`SELECT id FROM groups WHERE id = $1`, [id]);
    if (!exists) throw new BizError(ERR.NOT_FOUND, '小组不存在');
    await this.db.query(`UPDATE groups SET name = COALESCE($2, name), status = COALESCE($3, status) WHERE id = $1`, [
      id,
      body.name ?? null,
      body.status ?? null,
    ]);
    return { success: true };
  }

  /**
   * 方案 4.4：管理员与带教可直接为客服开放指定难度（用于特殊安排）。
   * 带教只能操作本组客服。
   */
  async grantLevels(
    id: number,
    levels: string[],
    operator: { roleCode: string; groupId?: number | null }
  ): Promise<{ success: boolean; levels: string[] }> {
    const account = await this.db.one<{ group_id: number | null }>(`SELECT group_id FROM accounts WHERE id = $1`, [id]);
    if (!account) throw new BizError(ERR.NOT_FOUND, '账号不存在');
    if (operator.roleCode === 'leader' && operator.groupId && account.group_id !== operator.groupId) {
      throw new BizError(ERR.FORBIDDEN, '只能为本组客服开放难度');
    }

    const valid = (levels || []).filter((level) => ['L1', 'L2', 'L3', 'L4'].includes(level));
    if (!valid.length) throw new BizError(ERR.PARAM, '请至少选择一个难度档位');
    for (const level of valid) {
      const exists = await this.db.one<{ id: number }>(
        `SELECT id FROM unlock_progress WHERE account_id = $1 AND level = $2`,
        [id, level]
      );
      if (exists) {
        await this.db.query(`UPDATE unlock_progress SET unlocked = true, updated_at = now() WHERE id = $1`, [exists.id]);
      } else {
        await this.db.query(`INSERT INTO unlock_progress (account_id, level, streak, unlocked) VALUES ($1,$2,0,true)`, [id, level]);
      }
    }
    return { success: true, levels: valid };
  }
}
