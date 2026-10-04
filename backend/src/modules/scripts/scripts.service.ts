import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { BizError, ERR } from '../../common/errors';
import { normalizePage, pageResult, PageQuery } from '../../common/pagination';
import { allocateStyles, normalizeRatios } from '../../domain/style-ratio';
import { createRng } from '../../domain/rng';
import { checkRounds } from '../../domain/extraction';
import { buildQuestionSeq as buildSeq } from '../../domain/question-seq';
import { SettingsService } from '../settings/settings.service';
import { ScriptQuestion } from '../../domain/types';
import { BUILTIN_QA_BY_NAME } from '../../db/seed-content';
import { isProductCompatibleWithQuestions, questionCategoryRule } from '../../domain/product-consistency';

/** 案例回流统一使用的背景名（方案 F3-07）。 */
const CASE_BACKGROUND_NAME = '案例回流';

@Injectable()
export class ScriptsService {
  private readonly logger = new Logger(ScriptsService.name);

  constructor(
    private readonly db: DbService,
    private readonly settings: SettingsService
  ) {}

  async list(query: PageQuery & { keyword?: string; category?: string; stage?: string; status?: string; productId?: string }) {
    const { page, pageSize, offset, limit } = normalizePage(query);
    const where: string[] = ['1=1'];
    const args: unknown[] = [];
    if (query.keyword) {
      args.push(`%${query.keyword}%`);
      where.push(`(s.name ILIKE $${args.length} OR s.script_no ILIKE $${args.length})`);
    }
    if (query.category) {
      args.push(query.category);
      where.push(`s.category = $${args.length}`);
    }
    if (query.stage) {
      args.push(query.stage);
      where.push(`s.stage = $${args.length}`);
    }
    if (query.status !== undefined && query.status !== '') {
      args.push(Number(query.status));
      where.push(`s.status = $${args.length}`);
    }
    if (query.productId) {
      // JSONB 数组包含匹配，避免 LIKE '%id%' 把 id=1 误匹配到 [11]
      args.push(JSON.stringify([Number(query.productId)]));
      where.push(`s.product_ids @> $${args.length}::jsonb`);
    }
    const whereSql = where.join(' AND ');
    const total = await this.db.one<{ count: string }>(`SELECT count(*)::text AS count FROM scripts s WHERE ${whereSql}`, args);
    const rows = await this.db.many<any>(
      `SELECT s.id, s.script_no AS "scriptNo", s.name, s.category, s.stage, s.status,
              s.practiced_count AS "practicedCount", s.avg_score AS "avgScore",
              s.question_seq AS "questionSeq", s.product_ids AS "productIds",
              b.name AS "bgName", q.template_name AS "qaTemplate", st.name AS "styleName", st.code AS "styleCode"
       FROM scripts s
       LEFT JOIN buyer_bg b ON b.id = s.bg_id
       LEFT JOIN buyer_qa q ON q.id = s.qa_id
       LEFT JOIN styles st ON st.id = s.style_id
       WHERE ${whereSql}
       ORDER BY s.id DESC OFFSET $${args.length + 1} LIMIT $${args.length + 2}`,
      [...args, offset, limit]
    );
    const list = rows.map((row) => ({ ...row, rounds: Array.isArray(row.questionSeq) ? row.questionSeq.length : 0 }));
    return pageResult(list, Number(total.count), page, pageSize);
  }

  /**
   * 剧本统计（方案 F3-12）：被练次数、平均得分、超时率，用来识别难点剧本。
   * 只把「已结束」的接待算进分母，进行中的会话不计入超时率。
   */
  async stats(limit = 100) {
    const rows = await this.db.many<any>(
      `SELECT s.id, s.script_no AS "scriptNo", s.name, s.category, s.stage, s.status,
              s.practiced_count AS "practicedCount", s.avg_score AS "avgScore",
              COALESCE(agg.sessionCount, 0) AS "sessionCount",
              COALESCE(agg.timeoutSessions, 0) AS "timeoutSessions"
       FROM scripts s
       LEFT JOIN (
         SELECT se.script_id AS script_id,
                count(*) AS sessionCount,
                sum(CASE WHEN se.timeout_count > 0 THEN 1 ELSE 0 END) AS timeoutSessions
         FROM sessions se JOIN attempts a ON a.id = se.attempt_id
         WHERE a.status <> 'running'
         GROUP BY se.script_id
       ) agg ON agg.script_id = s.id
       ORDER BY s.practiced_count DESC, s.id
       LIMIT $1`,
      [limit]
    );
    const withRate = rows.map((row) => {
      const sessionCount = Number(row.sessionCount || 0);
      const timeoutSessions = Number(row.timeoutSessions || 0);
      return {
        ...row,
        practicedCount: Number(row.practicedCount || 0),
        avgScore: row.avgScore === null || row.avgScore === undefined ? null : Number(row.avgScore),
        sessionCount,
        timeoutSessions,
        timeoutRate: sessionCount ? Math.round((timeoutSessions / sessionCount) * 1000) / 10 : 0,
      };
    });
    const practiced = withRate.filter((row) => row.sessionCount > 0);
    const totalSessions = practiced.reduce((sum, row) => sum + row.sessionCount, 0);
    const totalTimeouts = practiced.reduce((sum, row) => sum + row.timeoutSessions, 0);
    const scored = practiced.filter((row) => row.avgScore !== null);
    // rows 是按被练次数排序后的前 N 个，所以「剧本总数」要单独数，不能拿 rows.length 当总数
    const totalRow = await this.db.one<{ count: string }>(`SELECT count(*)::text AS count FROM scripts`);
    return {
      totals: {
        scripts: Number(totalRow?.count ?? withRate.length),
        listed: withRate.length,
        practicedScripts: practiced.length,
        sessions: totalSessions,
        timeoutRate: totalSessions ? Math.round((totalTimeouts / totalSessions) * 1000) / 10 : 0,
        avgScore: scored.length
          ? Math.round((scored.reduce((sum, row) => sum + (row.avgScore as number), 0) / scored.length) * 10) / 10
          : null,
      },
      // 难点剧本：练过且有超时记录的排在前面
      hardest: [...practiced]
        .sort((a, b) => b.timeoutRate - a.timeoutRate || (a.avgScore ?? 0) - (b.avgScore ?? 0))
        .slice(0, 10),
      rows: withRate,
    };
  }

  async detail(id: number) {
    const row = await this.db.one(
      `SELECT s.id, s.script_no AS "scriptNo", s.name, s.category, s.stage, s.status, s.style_manual AS "styleManual",
              s.question_seq AS "questionSeq", s.product_ids AS "productIds", s.practiced_count AS "practicedCount",
              s.avg_score AS "avgScore", b.name AS "bgName", b.description AS "bgDescription",
              q.template_name AS "qaTemplate", q.question AS "qaQuestion", q.accepted_answer AS "acceptedAnswer",
              st.name AS "styleName", st.code AS "styleCode", st.tone_sample AS "toneSample"
       FROM scripts s
       LEFT JOIN buyer_bg b ON b.id = s.bg_id
       LEFT JOIN buyer_qa q ON q.id = s.qa_id
       LEFT JOIN styles st ON st.id = s.style_id
       WHERE s.id = $1`,
      [id]
    );
    if (!row) throw new BizError(ERR.NOT_FOUND, '剧本不存在');
    const params = await this.settings.getParams();
    return { ...row, roundsWarning: checkRounds((row.questionSeq || []).length, params) };
  }

  /**
   * 按案例创建剧本（方案 F3-07）：从《案例收藏》挑一个真实会话作为剧本来源。
   * 做法是把案例的买家消息先沉淀成一条「买家咨询内容」（同名复用），
   * 再走标准建剧本流程 —— 这样后续的批量生成、风格占比对它同样生效。
   */
  async createFromCase(body: { caseId: number; productIds: number[]; styleId?: number; name?: string }, accountId: number) {
    const caseRow = await this.db.one<{ id: number; title: string; stage: string }>(
      `SELECT id, title, stage FROM cases WHERE id = $1`,
      [body.caseId]
    );
    if (!caseRow) throw new BizError(ERR.NOT_FOUND, '案例不存在');

    const messages = await this.db.many<{ sender: string; content: string }>(
      `SELECT sender, content FROM case_messages WHERE case_id = $1 ORDER BY seq`,
      [body.caseId]
    );
    const questionList = messages
      .filter((message) => message.sender === 'buyer')
      .map((message) => String(message.content || '').trim())
      .filter(Boolean)
      .slice(0, 10);
    if (!questionList.length) throw new BizError(ERR.PARAM, '该案例没有买家消息，无法生成剧本');

    // 背景统一挂在「案例回流」下，避免每条案例都新建一个背景把素材库撑爆
    let background = await this.db.one<{ id: number }>(`SELECT id FROM buyer_bg WHERE name = $1`, [CASE_BACKGROUND_NAME]);
    if (!background) {
      background = await this.db.one<{ id: number }>(
        `INSERT INTO buyer_bg (name, description, category, created_by) VALUES ($1,$2,'案例回流',$3) RETURNING id`,
        [CASE_BACKGROUND_NAME, '由《案例收藏》的真实会话回流而来', accountId]
      );
    }

    const templateName = `案例-${caseRow.title}`.slice(0, 60);
    let content = await this.db.one<{ id: number }>(`SELECT id FROM buyer_qa WHERE template_name = $1`, [templateName]);
    if (!content) {
      content = await this.db.one<{ id: number }>(
        `INSERT INTO buyer_qa (template_name, question, question_list, key_points, accepted_answer, stage, category)
         VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6,'案例回流') RETURNING id`,
        [
          templateName,
          questionList.join('；'),
          JSON.stringify(questionList),
          JSON.stringify(questionList.map(() => ['有效回应'])),
          '由案例收藏导入，请补充买家接受方案与要点',
          caseRow.stage === 'aftersale' ? 'aftersale' : 'presale',
        ]
      );
    }

    const styleRow =
      (body.styleId ? await this.db.one<{ id: number }>(`SELECT id FROM styles WHERE id = $1`, [body.styleId]) : null) ||
      (await this.db.one<{ id: number }>(`SELECT id FROM styles ORDER BY sort, id LIMIT 1`));
    if (!styleRow) throw new BizError(ERR.PARAM, '还没有可用的沟通风格');

    const created = await this.create(
      {
        bgId: background.id,
        qaId: content.id,
        styleId: styleRow.id,
        productIds: body.productIds,
        stage: caseRow.stage,
        category: '案例回流',
        name: body.name,
      },
      accountId
    );
    return { ...created, contentId: content.id };
  }

  async create(body: any, accountId: number) {
    if (!body.bgId || !body.qaId || !body.styleId) throw new BizError(ERR.PARAM, '买家咨询背景、内容与沟通风格为必填项');
    if (!Array.isArray(body.productIds) || !body.productIds.length) throw new BizError(ERR.PARAM, '请至少关联一个商品');
    const questionSeq = await this.buildQuestionSeq(body.qaId, body.questionSeq);
    const qa = await this.db.one<{ template_name: string }>(`SELECT template_name FROM buyer_qa WHERE id = $1`, [body.qaId]);
    const bg = await this.db.one<{ name: string }>(`SELECT name FROM buyer_bg WHERE id = $1`, [body.bgId]);
    if (!qa || !bg) throw new BizError(ERR.PARAM, '买家咨询背景或内容不存在');
    const stageName = body.stage === 'aftersale' ? '售后' : '售前';
    const name = body.name || `${stageName}-${bg.name.replace(/[：:].*$/, '')}-${qa.template_name}`;
    /**
     * 客户 2026-10-03「不可出现商品问题和实际商品需求不一致」：
     * 单个创建时直接拦下来（比批量生成更适合"立刻告诉带教哪里不对"）。
     */
    const createdProductRows = await this.db.many<{ id: number; category: string }>(
      `SELECT id, category FROM products WHERE id IN (${body.productIds.map((_, i: number) => `$${i + 1}`).join(',')})`,
      body.productIds
    );
    const createdCategoryById = new Map(createdProductRows.map((row) => [Number(row.id), String(row.category || '')]));
    for (const productId of body.productIds) {
      const category = createdCategoryById.get(Number(productId)) || '';
      if (!isProductCompatibleWithQuestions(category, questionSeq.map((q: any) => String(q.question)))) {
        const hit = questionSeq.find((q: any) => questionCategoryRule(String(q.question)))?.question || '';
        throw new BizError(
          ERR.PARAM,
          `商品与咨询内容不匹配：问题「${hit}」不适合商品分类「${category || '未分类'}」，请调整关联商品或换一条咨询内容`
        );
      }
    }
    const params = await this.settings.getParams();
    const [scriptNo] = await this.nextScriptNos(1);
    const row = await this.db.one<{ id: number }>(
      `INSERT INTO scripts (script_no, name, category, stage, bg_id, qa_id, style_id, style_manual, product_ids, question_seq, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,1,$11) RETURNING id`,
      [
        scriptNo,
        name,
        body.category || '培训',
        body.stage === 'aftersale' ? 'aftersale' : 'presale',
        body.bgId,
        body.qaId,
        body.styleId,
        !!body.styleManual,
        JSON.stringify(body.productIds),
        JSON.stringify(questionSeq),
        accountId,
      ]
    );
    return { id: row.id, roundsWarning: checkRounds(questionSeq.length, params) };
  }

  async update(id: number, body: any) {
    const current = await this.db.one(`SELECT * FROM scripts WHERE id = $1`, [id]);
    if (!current) throw new BizError(ERR.NOT_FOUND, '剧本不存在');
    const questionSeq = body.questionSeq ? body.questionSeq : null;
    await this.db.query(
      `UPDATE scripts SET name = COALESCE($2, name), category = COALESCE($3, category), stage = COALESCE($4, stage),
                          style_id = COALESCE($5, style_id), style_manual = COALESCE($6, style_manual),
                          product_ids = COALESCE($7::jsonb, product_ids), question_seq = COALESCE($8::jsonb, question_seq),
                          status = COALESCE($9, status), updated_at = now()
       WHERE id = $1`,
      [
        id,
        body.name ?? null,
        body.category ?? null,
        body.stage ?? null,
        body.styleId ?? null,
        body.styleManual ?? null,
        body.productIds ? JSON.stringify(body.productIds) : null,
        questionSeq ? JSON.stringify(questionSeq) : null,
        body.status ?? null,
      ]
    );
    return { success: true };
  }

  async remove(id: number) {
    const used = await this.db.one<{ count: string }>(`SELECT count(*)::text AS count FROM sessions WHERE script_id = $1`, [id]);
    if (Number(used.count) > 0) {
      await this.db.query(`UPDATE scripts SET status = 0, updated_at = now() WHERE id = $1`, [id]);
      return { success: true, mode: 'disabled', message: '该剧本已有接待记录，已改为停用' };
    }
    await this.db.query(`DELETE FROM scripts WHERE id = $1`, [id]);
    return { success: true, mode: 'deleted' };
  }

  /** 批量生成：背景 × 内容 交叉组合，风格按占比分配。 */
  async batchGenerate(
    accountId: number,
    body: { bgIds: number[]; qaIds: number[]; productIds: number[]; stage?: string; category?: string; seed?: number }
  ) {
    if (!body.bgIds?.length) throw new BizError(ERR.PARAM, '请至少选择一个买家咨询背景');
    if (!body.qaIds?.length) throw new BizError(ERR.PARAM, '请至少选择一个买家咨询内容');
    if (!body.productIds?.length) throw new BizError(ERR.PARAM, '请至少关联一个商品');
    // 方案 9.1：下架商品不参与新剧本（批量生成与单个创建共用该校验）
    const sellableCount = await this.db.one<{ count: string }>(
      `SELECT count(*)::text AS count FROM products WHERE id IN (${body.productIds.map((_, i) => `$${i + 1}`).join(',')})
         AND status = 1 AND deleted_at IS NULL`,
      body.productIds
    );
    if (Number(sellableCount?.count || 0) !== body.productIds.length) {
      throw new BizError(ERR.PARAM, '所选商品中包含已下架商品，请重新选择');
    }
    const params = await this.settings.getParams();

    const bgPlaceholders = body.bgIds.map((_, i) => `$${i + 1}`).join(',');
    const bgs = await this.db.many<{ id: number; name: string }>(
      `SELECT id, name FROM buyer_bg WHERE id IN (${bgPlaceholders})`,
      body.bgIds
    );
    const qaPlaceholders = body.qaIds.map((_, i) => `$${i + 1}`).join(',');
    const qas = await this.db.many<{ id: number; template_name: string; stage: string; question_list: string[]; key_points: string[][] }>(
      `SELECT id, template_name, stage, question_list, key_points FROM buyer_qa WHERE id IN (${qaPlaceholders})`,
      body.qaIds
    );
    if (!bgs.length || !qas.length) throw new BizError(ERR.PARAM, '所选素材不存在');

    // 商品 id → 分类：用于「问题与商品必须匹配」的生成前校验（客户 2026-10-03）
    const productRows = await this.db.many<{ id: number; category: string }>(
      `SELECT id, category FROM products WHERE id IN (${body.productIds.map((_, i) => `$${i + 1}`).join(',')})`,
      body.productIds
    );
    const productCategoryById = new Map(productRows.map((row) => [Number(row.id), String(row.category || '')]));

    const styles = await this.db.many<{ id: number; code: string; ratio: string; is_emotional: boolean }>(
      `SELECT id, code, ratio, is_emotional FROM styles WHERE status = 1 ORDER BY sort, id`
    );
    const ratios = normalizeRatios(styles.map((s) => ({ code: s.code, ratio: Number(s.ratio) })));
    const styleMap = new Map(styles.map((s) => [s.code, s]));

    /**
     * 组合口径保持「买家咨询背景 × 买家咨询内容」，商品按序轮转分配给每条剧本
     * （多选商品时，同一内容的剧本会分散到不同商品上，便于覆盖）。
     * 生成前先做**一致性预检**：所选商品与所选内容必须两两匹配，
     * 否则轮转下去一定会生出「问题与商品不一致」的剧本（客户 2026-10-03 的硬要求）。
     */
    const productIds = [...new Set(body.productIds.map((id) => Number(id)))];
    /**
     * 每条咨询内容只从「与它兼容的已选商品」里分配（客户 2026-10-03 的「不可出现不一致」）：
     * 例如内容里问「鞋码」，就只用所选商品里的鞋靴来配；一条兼容商品都没有时跳过这条内容，
     * 并把原因带回给前端（而不是硬失败，也不是硬塞一个不匹配的商品）。
     */
    const skippedContents: { templateName: string; reason: string }[] = [];
    const pairs: { bg: { id: number; name: string }; qa: typeof qas[number]; productId: number }[] = [];
    for (const bg of bgs) {
      for (const qa of qas) {
        const questions = (qa.question_list as unknown as string[]) || [];
        const compatible = productIds.filter((productId) =>
          isProductCompatibleWithQuestions(productCategoryById.get(Number(productId)) || '', questions)
        );
        if (!compatible.length) {
          const sample = questions[0] || '';
          skippedContents.push({
            templateName: qa.template_name,
            reason: `所选商品与内容里的问题「${sample}」不匹配（${productIds
              .map((id) => productCategoryById.get(Number(id)) || '未分类')
              .join(' / ')}），已跳过`,
          });
          continue;
        }
        pairs.push({ bg, qa, productId: compatible[pairs.length % compatible.length] });
      }
    }
    if (!pairs.length) {
      throw new BizError(
        ERR.PARAM,
        `所选商品与所选咨询内容都不匹配（例：${skippedContents[0]?.reason || '请检查商品品类'}），请调整选择`
      );
    }

    const styleSeq = allocateStyles(ratios, pairs.length, createRng(body.seed || Date.now() % 2147483647));
    const created: { id: number; name: string; scriptNo: string; styleCode: string; rounds: number }[] = [];
    const scriptNos = await this.nextScriptNos(pairs.length);

    // 方案 5.7：生成超过异步阈值时改为后台任务，返回任务 ID 供前端展示进度与取消
    const threshold = params.batchAsyncThreshold ?? 100;
    if (pairs.length > threshold) {
      const task = await this.db.one<{ id: number }>(
        `INSERT INTO script_gen_tasks (status, total, created_by) VALUES ('running',$1,$2) RETURNING id`,
        [pairs.length, accountId ?? null]
      );
      const taskId = task!.id;
      void this.runBatchTask(taskId, { bgs, qas, pairs, styleMap, styleSeq, scriptNos, rounds: params.levelRounds, body });
      return { async: true, taskId, total: pairs.length, threshold };
    }

    await this.db.tx(async (client) => {
      for (let i = 0; i < pairs.length; i += 1) {
        created.push(await this.insertScript(client, pairs[i], styleMap, styleSeq, scriptNos, i, body, params.levelRounds));
      }
    });

    const distribution: Record<string, number> = {};
    for (const c of created) distribution[c.styleCode] = (distribution[c.styleCode] || 0) + 1;
    return {
      total: created.length,
      distribution,
      preview: created.slice(0, 50),
      // 因「商品与内容不匹配」被跳过的内容（客户 2026-10-03），前端会提示给带教
      skipped: skippedContents,
    };
  }

  /**
   * 生成当天不重复的剧本编号。
   *
   * 内置剧本占用了 SC<日期>-0001 起的连续号段，若沿用「随机 4 位数」编号，
   * 随机值落进已占用区间就会撞号并导致生成失败。这里改为按当天已占用的最大序号递增。
   */
  private async nextScriptNos(count: number): Promise<string[]> {
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const rows = await this.db.many<{ script_no: string }>(
      `SELECT script_no FROM scripts WHERE script_no LIKE $1`,
      [`SC${stamp}-%`]
    );
    const used = new Set(rows.map((r) => r.script_no));
    let cursor = 0;
    for (const no of used) {
      const value = Number(String(no).split('-')[1]);
      if (Number.isFinite(value) && value > cursor) cursor = value;
    }
    const list: string[] = [];
    while (list.length < count) {
      cursor += 1;
      const candidate = `SC${stamp}-${String(cursor).padStart(4, '0')}`;
      if (used.has(candidate)) continue;
      used.add(candidate);
      list.push(candidate);
    }
    return list;
  }

  private async buildQuestionSeq(qaId: number, provided?: ScriptQuestion[]): Promise<ScriptQuestion[]> {
    if (Array.isArray(provided) && provided.length) return provided;
    const qa = await this.db.one<{ template_name: string; stage: string; question_list: string[]; key_points: string[][] }>(
      `SELECT template_name, stage, question_list, key_points FROM buyer_qa WHERE id = $1`,
      [qaId]
    );
    if (!qa) throw new BizError(ERR.PARAM, '买家咨询内容不存在');
    const params = await this.settings.getParams();
    return this.buildSeqFromQa(qa, params.levelRounds);
  }

  /**
   * 插入一个剧本（同步路径传事务 client，异步路径逐条提交，保证已生成的成果保留）。
   */
  private async insertScript(
    client: { query: (text: string, params?: any[]) => Promise<any> } | null,
    pair: { bg: { id: number; name: string }; qa: any; productId?: number },
    styleMap: Map<string, any>,
    styleSeq: string[],
    scriptNos: string[],
    index: number,
    body: { productIds: number[]; stage?: string; category?: string },
    rounds: [number, number]
  ): Promise<{ id: number; name: string; scriptNo: string; styleCode: string; rounds: number }> {
    const styleCode = styleSeq[index];
    const style = styleMap.get(styleCode);
    const questionSeq = this.buildSeqFromQa(pair.qa, rounds);
    const stageName = (body.stage || pair.qa.stage) === 'aftersale' ? '售后' : '售前';
    // 取背景名冒号之后的部分，避免同前缀背景（如多条「使用场景：」）产生重名剧本。
    const name = `${stageName}-${pair.bg.name.replace(/^[^：:]*[：:]/, '')}-${pair.qa.template_name}`;
    const scriptNo = scriptNos[index];
    /**
     * 客户 2026-10-03：商品参与组合后，每个剧本关联它自己那一个商品；
     * 没带 productId 的调用（例如按「背景 × 内容」的旧路径）才回退到轮转分配。
     */
    const productId = pair.productId ?? body.productIds[index % body.productIds.length];
    const sql = `INSERT INTO scripts (script_no, name, category, stage, bg_id, qa_id, style_id, product_ids, question_seq, status, created_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,1,1) RETURNING id`;
    const args = [
      scriptNo,
      name,
      body.category || '培训',
      body.stage || pair.qa.stage,
      pair.bg.id,
      pair.qa.id,
      style?.id ?? null,
      JSON.stringify([productId]),
      JSON.stringify(questionSeq),
    ];
    const id = client ? (await client.query(sql, args)).rows[0].id : (await this.db.one<{ id: number }>(sql, args))!.id;
    return { id, name, scriptNo, styleCode, rounds: questionSeq.length };
  }

  /** 后台执行批量生成：分块更新进度，并响应取消（已生成的剧本保留）。 */
  private async runBatchTask(
    taskId: number,
    ctx: {
      bgs: any[];
      qas: any[];
      /** 与同步路径同一份「背景 × 内容 × 商品」组合，保证异步与同步生成结果一致 */
      pairs: { bg: { id: number; name: string }; qa: any; productId: number }[];
      styleMap: Map<string, any>;
      styleSeq: string[];
      scriptNos: string[];
      rounds: [number, number];
      body: { productIds: number[]; stage?: string; category?: string };
    }
  ): Promise<void> {
    const pairs = ctx.pairs;

    let createdCount = 0;
    let failedCount = 0;
    const failures: string[] = [];
    let status = 'done';
    try {
      for (let i = 0; i < pairs.length; i += 1) {
        const current = await this.db.one<{ status: string }>(`SELECT status FROM script_gen_tasks WHERE id = $1`, [taskId]);
        if (current?.status === 'cancelled') {
          status = 'cancelled';
          break;
        }
        try {
          await this.insertScript(null, pairs[i], ctx.styleMap, ctx.styleSeq, ctx.scriptNos, i, ctx.body, ctx.rounds);
          createdCount += 1;
        } catch (err) {
          failedCount += 1;
          if (failures.length < 5) failures.push((err as Error).message);
        }
        // 每 20 条刷新一次进度，避免过于频繁写库
        if (i % 20 === 19 || i === pairs.length - 1) {
          await this.db.query(
            `UPDATE script_gen_tasks SET created_count = $2, failed_count = $3, updated_at = now() WHERE id = $1`,
            [taskId, createdCount, failedCount]
          );
        }
      }
    } catch (err) {
      status = 'failed';
      failures.push((err as Error).message);
      this.logger.error(`批量生成任务 ${taskId} 异常：${(err as Error).message}`);
    }

    await this.db.query(
      `UPDATE script_gen_tasks SET status = $2, created_count = $3, failed_count = $4, message = $5, updated_at = now() WHERE id = $1`,
      [taskId, status, createdCount, failedCount, failures.join('；').slice(0, 300) || null]
    );
  }

  /** 查询批量生成任务进度。 */
  async genTask(taskId: number) {
    const task = await this.db.one<any>(
      `SELECT id, status, total, created_count AS "createdCount", failed_count AS "failedCount",
              message, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM script_gen_tasks WHERE id = $1`,
      [taskId]
    );
    if (!task) throw new BizError(ERR.NOT_FOUND, '批量生成任务不存在');
    return task;
  }

  /** 取消批量生成任务：已生成的剧本保留（方案 3.3）。 */
  async cancelGenTask(taskId: number) {
    const task = await this.db.one<{ status: string }>(`SELECT status FROM script_gen_tasks WHERE id = $1`, [taskId]);
    if (!task) throw new BizError(ERR.NOT_FOUND, '批量生成任务不存在');
    if (task.status === 'running') {
      await this.db.query(`UPDATE script_gen_tasks SET status = 'cancelled', updated_at = now() WHERE id = $1`, [taskId]);
    }
    return { success: true };
  }

  /**
   * 由咨询内容构建提问序列（方案 4.5 兜底规则）。
   * 与内置剧本共用 domain/question-seq.ts 的同一套口径：按接待阶段补追问、支持转接题。
   */
  buildSeqFromQa(
    qa: { template_name?: string; stage?: string | null; question_list: string[]; key_points: string[][] },
    rounds: [number, number]
  ): ScriptQuestion[] {
    // 内置内容带「转接题」标记，按模板名继承，保证界面批量生成的剧本与内置剧本一致。
    const builtin = qa.template_name ? BUILTIN_QA_BY_NAME.get(qa.template_name) : undefined;
    return buildSeq(
      {
        question_list: qa.question_list,
        key_points: qa.key_points,
        stage: qa.stage,
        transferIdxs: builtin?.transferIdxs,
      },
      rounds
    );
  }
}
