import { Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { BizError, ERR } from '../../common/errors';
import { allocateCounts, normalizeRatios } from '../../domain/style-ratio';

@Injectable()
export class StylesService {
  constructor(private readonly db: DbService) {}

  async list() {
    const rows = await this.db.many(
      `SELECT id, code, name, description, tone_sample AS "toneSample", emotion_base AS "emotionBase",
              ratio, is_emotional AS "isEmotional", is_builtin AS "isBuiltin", sort, status
       FROM styles ORDER BY sort, id`
    );
    const ratios = normalizeRatios(rows.map((r: any) => ({ code: r.code, ratio: r.ratio === null ? null : Number(r.ratio) })));
    const preview = allocateCounts(ratios, 100);
    return rows.map((r: any) => ({ ...r, ratio: r.ratio === null ? null : Number(r.ratio), previewCount: preview[r.code] || 0 }));
  }

  /**
   * 风格效果统计（方案 F7-07）：每种风格被练了多少次、达标率多少，用来找出最难应对的买家类型。
   * 只统计已结束的接待；没有练过的风格达标率为 null，避免显示成 0% 误导。
   */
  async stats() {
    const rows = await this.db.many<any>(
      `SELECT st.code, st.name,
              count(a.id) AS "attemptCount",
              sum(CASE WHEN a.conclusion = 'pass' THEN 1 ELSE 0 END) AS "passCount"
       FROM styles st
       LEFT JOIN scripts sc ON sc.style_id = st.id
       LEFT JOIN sessions se ON se.script_id = sc.id
       LEFT JOIN attempts a ON a.id = se.attempt_id AND a.status <> 'running'
       GROUP BY st.code, st.name, st.sort
       ORDER BY st.sort`
    );
    const items = rows.map((row) => {
      const attemptCount = Number(row.attemptCount || 0);
      const passCount = Number(row.passCount || 0);
      return {
        code: row.code,
        name: row.name,
        attemptCount,
        passCount,
        passRate: attemptCount ? Math.round((passCount / attemptCount) * 1000) / 10 : null,
      };
    });
    const practiced = items.filter((item) => item.attemptCount > 0);
    return {
      items,
      practicedStyles: practiced.length,
      // 达标率最低的排前面；都没练过的风格不参与排序
      hardest: [...practiced].sort((a, b) => (a.passRate as number) - (b.passRate as number)).slice(0, 5),
    };
  }

  /** 批量保存占比：总和不得大于 100%，未填写的行按剩余比例平均分配。 */
  async saveRatios(items: { code: string; ratio: number | null }[]) {
    let normalized: { code: string; ratio: number }[];
    try {
      normalized = normalizeRatios(items);
    } catch (e) {
      throw new BizError(ERR.STYLE_RATIO, (e as Error).message);
    }
    for (const item of items) {
      const value = typeof item.ratio === 'number' && item.ratio > 0 ? item.ratio : null;
      await this.db.query(`UPDATE styles SET ratio = $2 WHERE code = $1`, [item.code, value]);
    }
    const preview = allocateCounts(normalized, 100);
    return { success: true, normalized, preview };
  }

  async create(body: { code: string; name: string; description?: string; toneSample?: string; emotionBase?: number; isEmotional?: boolean }) {
    if (!body.code || !body.name) throw new BizError(ERR.PARAM, '风格编码与名称为必填项');
    const exists = await this.db.one(`SELECT id FROM styles WHERE code = $1`, [body.code]);
    if (exists) throw new BizError(ERR.PARAM, '风格编码已存在');
    const maxSort = await this.db.one<{ max: number }>(`SELECT COALESCE(max(sort),0)::int AS max FROM styles`);
    const row = await this.db.one<{ id: number }>(
      `INSERT INTO styles (code, name, description, tone_sample, emotion_base, is_emotional, is_builtin, sort)
       VALUES ($1,$2,$3,$4,$5,$6,false,$7) RETURNING id`,
      [body.code, body.name, body.description || '', body.toneSample || '', body.emotionBase ?? 30, body.isEmotional ?? false, (maxSort?.max || 0) + 1]
    );
    return { id: row.id };
  }

  async update(id: number, body: any) {
    await this.db.query(
      `UPDATE styles SET name = COALESCE($2, name), description = COALESCE($3, description),
                         tone_sample = COALESCE($4, tone_sample), emotion_base = COALESCE($5, emotion_base),
                         is_emotional = COALESCE($6, is_emotional), status = COALESCE($7, status)
       WHERE id = $1`,
      [id, body.name ?? null, body.description ?? null, body.toneSample ?? null, body.emotionBase ?? null, body.isEmotional ?? null, body.status ?? null]
    );
    return { success: true };
  }

  async remove(id: number) {
    const style = await this.db.one<{ is_builtin: boolean }>(`SELECT is_builtin FROM styles WHERE id = $1`, [id]);
    if (!style) throw new BizError(ERR.NOT_FOUND, '风格不存在');
    if (style.is_builtin) throw new BizError(ERR.PARAM, '内置风格不可删除');
    const used = await this.db.one<{ count: string }>(`SELECT count(*)::text AS count FROM scripts WHERE style_id = $1`, [id]);
    if (Number(used.count) > 0) throw new BizError(ERR.MATERIAL_REFERENCED, '该风格已被剧本使用，无法删除');
    await this.db.query(`DELETE FROM styles WHERE id = $1`, [id]);
    return { success: true };
  }
}
