import { Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { BizError, ERR } from '../../common/errors';
import { BUILTIN_QA_BY_NAME } from '../../db/seed-content';
import { normalizePage, pageResult, PageQuery } from '../../common/pagination';

@Injectable()
export class MaterialsService {
  constructor(private readonly db: DbService) {}

  /* ---------------- 买家咨询背景 ---------------- */

  async listBackgrounds(query: PageQuery & { keyword?: string; category?: string; creatorId?: number | string }) {
    const { page, pageSize, offset, limit } = normalizePage(query);
    const where: string[] = ['1=1'];
    const args: unknown[] = [];
    if (query.keyword) {
      args.push(`%${query.keyword}%`);
      where.push(`(b.name ILIKE $${args.length} OR b.description ILIKE $${args.length})`);
    }
    if (query.category) {
      args.push(query.category);
      where.push(`b.category = $${args.length}`);
    }
    if (query.creatorId) {
      args.push(Number(query.creatorId));
      where.push(`b.created_by = $${args.length}`);
    }
    const whereSql = where.join(' AND ');
    const total = await this.db.one<{ count: string }>(`SELECT count(*)::text AS count FROM buyer_bg b WHERE ${whereSql}`, args);
    const rows = await this.db.many(
      `SELECT b.id, b.name, b.description, b.category, b.created_by AS "createdById",
              a.display_name AS "createdByName", b.updated_at AS "updatedAt"
       FROM buyer_bg b LEFT JOIN accounts a ON a.id = b.created_by
       WHERE ${whereSql} ORDER BY b.id DESC OFFSET $${args.length + 1} LIMIT $${args.length + 2}`,
      [...args, offset, limit]
    );
    return pageResult(rows, Number(total.count), page, pageSize);
  }

  async createBackground(body: { name: string; description: string; category?: string }, accountId: number) {
    if (!body.name) throw new BizError(ERR.PARAM, '背景名称为必填项');
    const row = await this.db.one<{ id: number }>(
      `INSERT INTO buyer_bg (name, description, category, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
      [body.name, body.description || '', body.category || '通用', accountId]
    );
    return { id: row.id };
  }

  async updateBackground(id: number, body: any) {
    await this.db.query(
      `UPDATE buyer_bg SET name = COALESCE($2, name), description = COALESCE($3, description),
                           category = COALESCE($4, category), updated_at = now()
       WHERE id = $1`,
      [id, body.name ?? null, body.description ?? null, body.category ?? null]
    );
    return { success: true };
  }

  async removeBackgrounds(ids: number[]) {
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    // 注意：参数要按位置逐个展开（ids），不能写成 [ids]——那会把整个数组塞进 $1，
    // 生成 `bg_id IN (ARRAY['32'])`，在 PostgreSQL 与 pg-mem 上都会直接报类型错误。
    const referenced = await this.db.many<{ id: number; name: string }>(
      `SELECT DISTINCT bg_id AS id, '' AS name FROM scripts WHERE bg_id IN (${placeholders})`,
      ids
    );
    if (referenced.length) throw new BizError(ERR.MATERIAL_REFERENCED, `有 ${referenced.length} 条背景已被剧本引用，无法删除`);
    await this.db.query(`DELETE FROM buyer_bg WHERE id IN (${placeholders})`, ids);
    return { success: true, deleted: ids.length };
  }

  /* ---------------- 买家咨询内容 ---------------- */

  async listContents(query: PageQuery & { keyword?: string; category?: string; stage?: string; creatorId?: number | string }) {
    const { page, pageSize, offset, limit } = normalizePage(query);
    const where: string[] = ['1=1'];
    const args: unknown[] = [];
    if (query.keyword) {
      args.push(`%${query.keyword}%`);
      where.push(
        `(q.template_name ILIKE $${args.length} OR q.question ILIKE $${args.length} OR q.accepted_answer ILIKE $${args.length})`
      );
    }
    if (query.category) {
      args.push(query.category);
      where.push(`q.category = $${args.length}`);
    }
    if (query.stage) {
      args.push(query.stage);
      where.push(`q.stage = $${args.length}`);
    }
    if (query.creatorId) {
      args.push(Number(query.creatorId));
      where.push(`q.created_by = $${args.length}`);
    }
    const whereSql = where.join(' AND ');
    const total = await this.db.one<{ count: string }>(`SELECT count(*)::text AS count FROM buyer_qa q WHERE ${whereSql}`, args);
    const rows = await this.db.many(
      `SELECT q.id, q.template_name AS "templateName", q.question, q.question_list AS "questionList",
              q.image_url AS "imageUrl", q.accepted_answer AS "acceptedAnswer", q.key_points AS "keyPoints",
              q.stage, q.category, q.created_by AS "createdById", a.display_name AS "createdByName",
              q.updated_at AS "updatedAt"
       FROM buyer_qa q LEFT JOIN accounts a ON a.id = q.created_by
       WHERE ${whereSql} ORDER BY q.id DESC OFFSET $${args.length + 1} LIMIT $${args.length + 2}`,
      [...args, offset, limit]
    );
    // 「内置」标记：内容来自内置内容库（seed-content.ts），前端用官方徽标区分
    const withBuiltin = rows.map((row: any) => ({
      ...row,
      builtin: BUILTIN_QA_BY_NAME.has(row.templateName),
    }));
    return pageResult(withBuiltin, Number(total.count), page, pageSize);
  }

  async createContent(body: any, accountId: number) {
    if (!body.templateName) throw new BizError(ERR.PARAM, '模板名称为必填项');
    if (!body.question) throw new BizError(ERR.PARAM, '买家咨询问题为必填项');
    const questionList = this.splitQuestions(body.question);
    const keyPoints = Array.isArray(body.keyPoints) && body.keyPoints.length ? body.keyPoints : questionList.map(() => ['有效回应']);
    const row = await this.db.one<{ id: number }>(
      `INSERT INTO buyer_qa (template_name, question, question_list, image_url, accepted_answer, key_points, stage, category, created_by)
       VALUES ($1,$2,$3::jsonb,$4,$5,$6::jsonb,$7,$8,$9) RETURNING id`,
      [
        body.templateName,
        body.question,
        JSON.stringify(questionList),
        body.imageUrl || null,
        body.acceptedAnswer || null,
        JSON.stringify(keyPoints),
        body.stage === 'aftersale' ? 'aftersale' : 'presale',
        body.category || '通用',
        accountId,
      ]
    );
    return { id: row.id, questionList };
  }

  async updateContent(id: number, body: any) {
    let questionList: string[] | null = null;
    if (body.question) questionList = this.splitQuestions(body.question);
    await this.db.query(
      `UPDATE buyer_qa SET template_name = COALESCE($2, template_name),
                           question = COALESCE($3, question),
                           question_list = COALESCE($4::jsonb, question_list),
                           image_url = COALESCE($5, image_url),
                           accepted_answer = COALESCE($6, accepted_answer),
                           key_points = COALESCE($7::jsonb, key_points),
                           stage = COALESCE($8, stage),
                           category = COALESCE($9, category),
                           updated_at = now()
       WHERE id = $1`,
      [
        id,
        body.templateName ?? null,
        body.question ?? null,
        questionList ? JSON.stringify(questionList) : null,
        body.imageUrl ?? null,
        body.acceptedAnswer ?? null,
        body.keyPoints ? JSON.stringify(body.keyPoints) : null,
        body.stage ?? null,
        body.category ?? null,
      ]
    );
    return { success: true };
  }

  async removeContents(ids: number[]) {
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    const referenced = await this.db.one<{ count: string }>(
      `SELECT count(*)::text AS count FROM scripts WHERE qa_id IN (${placeholders})`,
      ids
    );
    if (Number(referenced.count) > 0) throw new BizError(ERR.MATERIAL_REFERENCED, `有 ${referenced.count} 个剧本引用了所选内容，无法删除`);
    await this.db.query(`DELETE FROM buyer_qa WHERE id IN (${placeholders})`, ids);
    return { success: true, deleted: ids.length };
  }

  splitQuestions(question: string): string[] {
    return String(question || '')
      .split(/[；;]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /* ---------------- 分类 ---------------- */

  async listCategories(type: string) {
    // 场景标签没有独立的维护入口，实际就写在商品的 scenes 里。
    // 打开「商品场景标签」字典时把已在用的标签补登成字典项（幂等），
    // 这样页面拿到的是「实际在用的标签」，改名/删除也能级联回商品。
    if (type === 'tag') {
      const productRows = await this.db.many<any>(`SELECT scenes FROM products WHERE deleted_at IS NULL`);
      const used = new Set<string>();
      for (const row of productRows) {
        for (const scene of Array.isArray(row.scenes) ? row.scenes : []) {
          const name = String(scene).trim();
          if (name) used.add(name);
        }
      }
      const registered = await this.db.many<{ name: string }>(`SELECT name FROM categories WHERE type = 'tag'`);
      const existing = new Set(registered.map((row) => row.name));
      let sort = existing.size;
      for (const name of used) {
        if (existing.has(name)) continue;
        sort += 1;
        await this.db.query(`INSERT INTO categories (type, name, parent_id, sort) VALUES ('tag',$1,NULL,$2)`, [
          name,
          sort,
        ]);
      }
    }
    const rows = await this.db.many<any>(
      `SELECT c.id, c.name, c.parent_id AS "parentId", c.sort
       FROM categories c WHERE c.type = $1 ORDER BY c.sort, c.id`,
      [type]
    );
    // 分类下挂的素材数量：bg → 背景数、qa → 内容数、script → 剧本数、product/tag → 商品数
    const countMap = new Map<string, number>();
    const countSource: Record<string, { sql: string; key: string }> = {
      bg: { sql: `SELECT category AS name, count(*)::int AS "count" FROM buyer_bg GROUP BY category`, key: 'name' },
      qa: { sql: `SELECT category AS name, count(*)::int AS "count" FROM buyer_qa GROUP BY category`, key: 'name' },
      script: { sql: `SELECT category AS name, count(*)::int AS "count" FROM scripts GROUP BY category`, key: 'name' },
      product: {
        sql: `SELECT category AS name, count(*)::int AS "count" FROM products WHERE deleted_at IS NULL GROUP BY category`,
        key: 'name',
      },
    };
    if (countSource[type]) {
      const counts = await this.db.many<any>(countSource[type].sql);
      for (const row of counts) countMap.set(String(row[countSource[type].key]), Number(row.count));
    }
    if (type === 'tag') {
      // 场景标签存在商品的 scenes 数组里，展开统计（数据量小，直接在内存里算）
      const productRows = await this.db.many<any>(`SELECT scenes FROM products WHERE deleted_at IS NULL`);
      for (const row of productRows) {
        const scenes = Array.isArray(row.scenes) ? row.scenes : [];
        for (const scene of scenes) countMap.set(String(scene), (countMap.get(String(scene)) || 0) + 1);
      }
    }
    const scriptCounts = await this.db.many<any>(`SELECT category, count(*)::int AS "count" FROM scripts GROUP BY category`);
    const scriptMap = new Map(scriptCounts.map((c) => [c.category, Number(c.count)]));
    return rows.map((r) => ({
      ...r,
      count: countMap.get(r.name) || 0,
      scriptCount: scriptMap.get(r.name) || 0,
    }));
  }

  /**
   * 字典项改名（方案 F8-11）：字典是「改一处、全局生效」，所以改名要级联到已引用它的素材。
   * 不级联的话，改完分类名所有素材都会变成「分类不存在」的状态。
   */
  async updateCategory(id: number, body: { name?: string }) {
    const category = await this.db.one<{ id: number; type: string; name: string }>(
      `SELECT id, type, name FROM categories WHERE id = $1`,
      [id]
    );
    if (!category) throw new BizError(ERR.NOT_FOUND, '字典项不存在');
    const name = String(body.name || '').trim();
    if (!name) throw new BizError(ERR.PARAM, '字典项名称不能为空');
    if (name === category.name) return { success: true, renamed: 0 };
    const duplicated = await this.db.one<{ id: number }>(
      `SELECT id FROM categories WHERE type = $1 AND name = $2 AND id <> $3`,
      [category.type, name, id]
    );
    if (duplicated) throw new BizError(ERR.PARAM, '同类型下已存在同名分类');

    await this.db.query(`UPDATE categories SET name = $2 WHERE id = $1`, [id, name]);

    let renamed = 0;
    const tables: Record<string, string> = { bg: 'buyer_bg', qa: 'buyer_qa', script: 'scripts', product: 'products' };
    if (tables[category.type]) {
      const rows = await this.db.many<{ id: number }>(`SELECT id FROM ${tables[category.type]} WHERE category = $1`, [
        category.name,
      ]);
      await this.db.query(`UPDATE ${tables[category.type]} SET category = $2 WHERE category = $1`, [category.name, name]);
      renamed = rows.length;
    } else if (category.type === 'tag') {
      const productRows = await this.db.many<{ id: number; scenes: any }>(
        `SELECT id, scenes FROM products WHERE deleted_at IS NULL`
      );
      for (const row of productRows) {
        const scenes = Array.isArray(row.scenes) ? row.scenes.map(String) : [];
        if (!scenes.includes(category.name)) continue;
        const next = scenes.map((scene) => (scene === category.name ? name : scene));
        await this.db.query(`UPDATE products SET scenes = $2::jsonb WHERE id = $1`, [row.id, JSON.stringify(next)]);
        renamed += 1;
      }
    }
    return { success: true, renamed };
  }

  async createCategory(body: { type: string; name: string; parentId?: number }) {
    if (!body.type || !body.name) throw new BizError(ERR.PARAM, '分类类型与名称为必填项');
    const maxSort = await this.db.one<{ max: number }>(`SELECT COALESCE(max(sort),0)::int AS max FROM categories WHERE type = $1`, [body.type]);
    const row = await this.db.one<{ id: number }>(
      `INSERT INTO categories (type, name, parent_id, sort) VALUES ($1,$2,$3,$4) RETURNING id`,
      [body.type, body.name, body.parentId ?? null, (maxSort?.max || 0) + 1]
    );
    return { id: row.id };
  }

  async reorderCategories(items: { id: number; sort: number }[]) {
    for (const item of items) {
      await this.db.query(`UPDATE categories SET sort = $2 WHERE id = $1`, [item.id, item.sort]);
    }
    return { success: true };
  }

  /**
   * 分类被引用次数（方案 F8-11）。
   * 数据字典页面向用户承诺「删除前会检查是否还有引用」，但此前只查了剧本表，
   * 背景/内容/商品都漏了——删完会留下「数据里在用、字典里没有」的分类。
   */
  private async categoryUsage(type: string, name: string): Promise<number> {
    if (type === 'tag') {
      const rows = await this.db.many<{ scenes: unknown }>(`SELECT scenes FROM products WHERE deleted_at IS NULL`);
      return rows.filter((row) => (Array.isArray(row.scenes) ? row.scenes : []).map(String).includes(name)).length;
    }
    const tableByType: Record<string, string> = { bg: 'buyer_bg', qa: 'buyer_qa', script: 'scripts', product: 'products' };
    const table = tableByType[type];
    if (!table) return 0;
    const softDelete = table === 'products' ? ' AND deleted_at IS NULL' : '';
    const row = await this.db.one<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table} WHERE category = $1${softDelete}`,
      [name]
    );
    return Number(row?.count || 0);
  }

  async removeCategory(id: number) {
    const category = await this.db.one<{ name: string; type: string }>(`SELECT name, type FROM categories WHERE id = $1`, [id]);
    if (!category) throw new BizError(ERR.NOT_FOUND, '分类不存在');
    const used = await this.categoryUsage(category.type, category.name);
    if (used > 0) throw new BizError(ERR.MATERIAL_REFERENCED, `该分类下还有 ${used} 条内容在用，无法删除`);
    await this.db.query(`DELETE FROM categories WHERE id = $1`, [id]);
    return { success: true };
  }
}
