import { Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { BizError, ERR } from '../../common/errors';
import { extractVariables } from '../../domain/phrase-vars';

@Injectable()
export class PhrasesService {
  constructor(private readonly db: DbService) {}

  /**
   * 短语列表（方案 3.8 F8-08）。
   * @param category 按分类过滤
   * @param includeDisabled 维护页需要看到已停用的短语；接待页只看启用的
   */
  async list(category?: string, includeDisabled = false) {
    const args: unknown[] = [];
    const where = includeDisabled ? [] : ['status = 1'];
    let sql = `SELECT id, category, title, content, variables, used_count AS "usedCount", status FROM phrases`;
    if (category) {
      args.push(category);
      where.push(`category = $${args.length}`);
    }
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ` ORDER BY category, id`;
    const list = await this.db.many(sql, args);
    const categorySql = `SELECT category AS name, count(*)::int AS count FROM phrases${
      includeDisabled ? '' : ' WHERE status = 1'
    } GROUP BY category ORDER BY category`;
    const categories = await this.db.many<{ name: string; count: number }>(categorySql);
    return {
      list,
      categories: categories.map((c) => c.name),
      categoryStats: categories.map((c) => ({ name: c.name, count: Number(c.count) })),
    };
  }

  async create(body: { category?: string; title: string; content: string; variables?: string[]; status?: number }) {
    if (!body.title || !body.content) throw new BizError(ERR.PARAM, '短语标题与内容为必填项');
    const variables = this.resolveVariables(body.variables, body.content);
    const row = await this.db.one<{ id: number }>(
      `INSERT INTO phrases (category, title, content, variables, status) VALUES ($1,$2,$3,$4::jsonb,$5) RETURNING id`,
      [body.category || '通用', body.title, body.content, JSON.stringify(variables), this.normalizeStatus(body.status)]
    );
    return { id: row.id };
  }

  async update(id: number, body: any) {
    const row = await this.db.one<any>(`SELECT * FROM phrases WHERE id = $1`, [id]);
    if (!row) throw new BizError(ERR.NOT_FOUND, '短语不存在');
    const content: string = body.content ?? row.content;
    // 改过内容就重新抽取变量；否则保留库里已有的（允许人工改写变量而不动内容）
    const variables = Array.isArray(body.variables)
      ? body.variables
      : body.content !== undefined
        ? extractVariables(content)
        : Array.isArray(row.variables)
          ? row.variables
          : [];
    await this.db.query(
      `UPDATE phrases SET category = $2, title = $3, content = $4, variables = $5::jsonb, status = $6 WHERE id = $1`,
      [
        id,
        body.category ?? row.category,
        body.title ?? row.title,
        content,
        JSON.stringify(variables),
        this.normalizeStatus(body.status ?? row.status),
      ]
    );
    return { success: true };
  }

  /** 接待页插入短语时累加使用次数（方案 3.8：短语列表展示使用次数）。 */
  async markUsed(id: number) {
    const row = await this.db.one<any>(`SELECT id FROM phrases WHERE id = $1`, [id]);
    if (!row) throw new BizError(ERR.NOT_FOUND, '短语不存在');
    await this.db.query(`UPDATE phrases SET used_count = used_count + 1 WHERE id = $1`, [id]);
    const after = await this.db.one<any>(`SELECT used_count AS "usedCount" FROM phrases WHERE id = $1`, [id]);
    return { usedCount: Number(after?.usedCount ?? 0) };
  }

  async remove(id: number) {
    const row = await this.db.one<any>(`SELECT id FROM phrases WHERE id = $1`, [id]);
    if (!row) throw new BizError(ERR.NOT_FOUND, '短语不存在');
    await this.db.query(`DELETE FROM phrases WHERE id = $1`, [id]);
    return { success: true };
  }

  private resolveVariables(input: unknown, content: string): string[] {
    if (Array.isArray(input) && input.length) {
      return input.map((item) => String(item)).filter((item) => item.trim().length > 0);
    }
    return extractVariables(content);
  }

  private normalizeStatus(input: unknown): number {
    if (input === undefined || input === null) return 1;
    return Number(input) === 0 ? 0 : 1;
  }
}
