import { Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { DEFAULT_PARAMS, SystemParams } from '../../domain/types';
import { mergeParams, validateWeights } from '../../domain/params';
import { BizError, ERR } from '../../common/errors';

@Injectable()
export class SettingsService {
  private cache: { params: SystemParams; version: number } | null = null;

  constructor(private readonly db: DbService) {}

  async getParams(useCache = true): Promise<SystemParams> {
    if (useCache && this.cache) return this.cache.params;
    const row = await this.db.one<{ value: SystemParams; version: number }>(
      `SELECT value, version FROM app_params ORDER BY id LIMIT 1`
    );
    const params = mergeParams(row?.value || DEFAULT_PARAMS);
    this.cache = { params, version: row?.version || 1 };
    return params;
  }

  async updateParams(patch: Partial<SystemParams>, updatedBy: number): Promise<SystemParams> {
    const current = await this.getParams(false);
    const next = mergeParams({ ...current, ...patch });
    try {
      validateWeights(next);
    } catch (e) {
      throw new BizError(ERR.PARAM, (e as Error).message);
    }
    if (next.passLine < 0 || next.passLine > 100) throw new BizError(ERR.PARAM, '达标线取值范围为 0～100');
    if (next.maxConcurrent < 1 || next.maxConcurrent > 4) throw new BizError(ERR.PARAM, '并发接待上限取值范围为 1～4');
    if (next.levelRounds[0] > next.levelRounds[1]) throw new BizError(ERR.PARAM, '问题轮数下限不能大于上限');
    // 客户新增需求：各难度接入人数在 1～4 之间。
    // 与全局上限的关系是 min(本档人数, maxConcurrent)，所以这里不因为超过上限而拒绝，
    // 否则「先把上限调小」这种正常操作会被挡住。
    for (const [code, value] of Object.entries(next.levelConcurrent || {})) {
      const count = Number(value);
      if (!Number.isFinite(count) || count < 1 || count > 4) {
        throw new BizError(ERR.PARAM, `${code} 的接入人数取值范围为 1～4`);
      }
    }
    // 客户新增需求 C5：本次模拟的总接待人数（含尚未接入的排队买家），取值范围 1～20。
    // 与接入人数相反，这里允许总量小于同时在线——此时总量就是硬上限。
    for (const [code, value] of Object.entries(next.levelTotal || {})) {
      // 置空（null）表示「未配置」，回落到默认的 10 人（客户 2026-10-03）
      const raw = value as unknown as number | string | null | undefined;
      if (raw === null || raw === undefined || String(raw).trim() === '') continue;
      const total = Number(raw);
      if (!Number.isFinite(total) || total < 1 || total > 20) {
        throw new BizError(ERR.PARAM, `${code} 的总接待人数取值范围为 1～20`);
      }
    }
    // 客户新增需求 C6：无效 / 敷衍回复判定的阈值范围
    if (next.invalidReplyDuplicateStreak < 2 || next.invalidReplyDuplicateStreak > 10) {
      throw new BizError(ERR.PARAM, '连续重复判定次数取值范围为 2～10');
    }
    if (next.invalidReplyUnresolvedStreak < 2 || next.invalidReplyUnresolvedStreak > 10) {
      throw new BizError(ERR.PARAM, '连续未命中轮数取值范围为 2～10');
    }
    // 客户 2026-10-03：一次接待里「买完商品后的订单类问题」占比，0～80（默认 20），
    // 其余问题都是「还没有订单、只咨询商品信息」的售前问题。
    const aftersaleRatio = Number(next.aftersaleQuestionRatio);
    if (!Number.isFinite(aftersaleRatio) || aftersaleRatio < 0 || aftersaleRatio > 80) {
      throw new BizError(ERR.PARAM, '售后问题占比取值范围为 0～80');
    }
    next.aftersaleQuestionRatio = Math.round(aftersaleRatio);

    const row = await this.db.one<{ id: number; version: number }>(`SELECT id, version FROM app_params ORDER BY id LIMIT 1`);
    if (!row) {
      await this.db.query(`INSERT INTO app_params (value, version, updated_by) VALUES ($1::jsonb, 1, $2)`, [
        JSON.stringify(next),
        updatedBy,
      ]);
    } else {
      await this.db.query(`UPDATE app_params SET value = $2::jsonb, version = version + 1, updated_by = $3, updated_at = now() WHERE id = $1`, [
        row.id,
        JSON.stringify(next),
        updatedBy,
      ]);
      await this.db.query(`INSERT INTO action_logs (account_id, action, detail) VALUES ($1,'settings.update',$2::jsonb)`, [
        updatedBy,
        JSON.stringify({ before: current.weights, after: next.weights }),
      ]);
    }
    this.cache = null;
    return this.getParams(false);
  }
}
