import { Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { BizError, ERR } from '../../common/errors';
import { normalizePage, pageResult, PageQuery } from '../../common/pagination';
import { base64ToBuffer, parseXlsx } from '../../common/xlsx';
import { parseCsv } from '../../common/csv';
import { pickCaseAdapter } from '../../domain/case-adapters';

@Injectable()
export class CasesService {
  constructor(private readonly db: DbService) {}

  /** 案例检索（方案 F5-08）：关键词、店铺、接待阶段、标签、导入时间范围。 */
  async list(query: PageQuery & { keyword?: string; shop?: string; stage?: string; tag?: string; from?: string; to?: string }) {
    const { page, pageSize, offset, limit } = normalizePage(query);
    const where: string[] = ['1=1'];
    const args: unknown[] = [];
    if (query.keyword) {
      args.push(`%${query.keyword}%`);
      where.push(`(title ILIKE $${args.length} OR shop ILIKE $${args.length})`);
    }
    if (query.shop) {
      args.push(`%${query.shop}%`);
      where.push(`shop ILIKE $${args.length}`);
    }
    if (query.stage) {
      args.push(query.stage);
      where.push(`stage = $${args.length}`);
    }
    if (query.tag) {
      // tags 是 JSONB 数组，用包含匹配；不用 LIKE，避免 id=1 命中 [11] 这类误匹配
      args.push(JSON.stringify([query.tag]));
      where.push(`tags @> $${args.length}::jsonb`);
    }
    if (query.from) {
      args.push(query.from);
      where.push(`created_at >= $${args.length}`);
    }
    if (query.to) {
      args.push(query.to);
      where.push(`created_at <= $${args.length}`);
    }
    const whereSql = where.join(' AND ');
    const total = await this.db.one<{ count: string }>(`SELECT count(*)::text AS count FROM cases WHERE ${whereSql}`, args);
    const rows = await this.db.many(
      `SELECT id, title, source_type AS "sourceType", shop, stage, tags, message_count AS "messageCount",
              duration_sec AS "durationSec", status, created_at AS "createdAt"
       FROM cases WHERE ${whereSql} ORDER BY id DESC OFFSET $${args.length + 1} LIMIT $${args.length + 2}`,
      [...args, offset, limit]
    );
    // 标签下拉的候选项：直接汇总现有标签（案例量级不大，避免依赖 jsonb 展开函数）
    const tagRows = await this.db.many<{ tags: any }>(`SELECT tags FROM cases`);
    const tags = [
      ...new Set(tagRows.flatMap((row) => (Array.isArray(row.tags) ? row.tags.map((t: any) => String(t)) : []))),
    ].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    return { ...pageResult(rows, Number(total.count), page, pageSize), tags };
  }

  async detail(id: number) {
    const row = await this.db.one(
      `SELECT id, title, source_type AS "sourceType", shop, stage, tags,
              message_count AS "messageCount", duration_sec AS "durationSec", status,
              created_by AS "createdById", created_at AS "createdAt"
       FROM cases WHERE id = $1`,
      [id]
    );
    if (!row) throw new BizError(ERR.NOT_FOUND, '案例不存在');
    const messages = await this.db.many(
      `SELECT id, seq, sender, content, is_excellent AS "isExcellent" FROM case_messages WHERE case_id = $1 ORDER BY seq`,
      [id]
    );
    return { ...row, messages };
  }

  /**
   * 文本导入：每行形如 "买家:内容" / "客服:内容" / "2026-10-01 10:00:00 买家 内容"。
   * 自动识别角色与顺序，生成结构化案例。
   */
  async importText(body: { title: string; text: string; shop?: string; stage?: string; tags?: string[] }, accountId: number) {
    if (!body.title) throw new BizError(ERR.PARAM, '案例标题不能为空');
    const tags = Array.isArray(body.tags) ? body.tags.map((tag) => String(tag).trim()).filter(Boolean) : [];
    const lines = String(body.text || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) throw new BizError(ERR.IMPORT_VALIDATE, '未解析到任何会话内容');

    const parsed: { sender: string; content: string }[] = [];
    const failed: { line: number; reason: string }[] = [];
    lines.forEach((line, index) => {
      const m = line.match(/^(?:\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?\s*)?(买家|客户|客服|我方|对方|我)\s*[:：]?\s*(.+)$/);
      if (!m) {
        failed.push({ line: index + 1, reason: '无法识别角色，请使用"买家:内容"或"客服:内容"格式' });
        return;
      }
      const rawRole = m[1];
      const sender = rawRole === '买家' || rawRole === '客户' || rawRole === '对方' ? 'buyer' : 'agent';
      parsed.push({ sender, content: m[2].trim() });
    });
    if (!parsed.length) throw new BizError(ERR.IMPORT_VALIDATE, '所有行均解析失败，请检查格式');

    const caseRow = await this.db.one<{ id: number }>(
      `INSERT INTO cases (title, source_type, shop, stage, tags, message_count, duration_sec, created_by)
       VALUES ($1,'paste',$2,$3,$4::jsonb,$5,0,$6) RETURNING id`,
      [
        body.title,
        body.shop ?? null,
        body.stage === 'aftersale' ? 'aftersale' : 'presale',
        JSON.stringify(tags),
        parsed.length,
        accountId,
      ]
    );
    for (let i = 0; i < parsed.length; i += 1) {
      await this.db.query(`INSERT INTO case_messages (case_id, seq, sender, content) VALUES ($1,$2,$3,$4)`, [
        caseRow.id,
        i + 1,
        parsed[i].sender,
        parsed[i].content,
      ]);
    }
    return { id: caseRow.id, imported: parsed.length, failed };
  }

  /** 由案例生成"买家咨询内容"草稿，供剧本模块引用。 */
  /**
   * 文件导入（方案 F5-01）：CSV 或 Excel，按适配器解析成结构化会话。
   * 解析不出来的行会带着行号与原因进失败清单，而不是静默丢掉。
   */
  async importFile(
    body: {
      title: string;
      fileName?: string;
      base64?: string;
      text?: string;
      shop?: string;
      stage?: string;
      tags?: string[];
      adapterCode?: string;
    },
    accountId: number
  ) {
    if (!body.title) throw new BizError(ERR.PARAM, '案例标题不能为空');
    const fileName = String(body.fileName || '');
    let rows: string[][];
    if (fileName.toLowerCase().endsWith('.csv')) {
      if (!body.text) throw new BizError(ERR.IMPORT_FORMAT, 'CSV 内容为空');
      rows = parseCsv(body.text);
    } else {
      if (!body.base64) throw new BizError(ERR.IMPORT_FORMAT, '请上传 .xlsx 或 .csv 文件');
      try {
        rows = parseXlsx(base64ToBuffer(body.base64)).filter((row) => row.some((cell) => String(cell ?? '').trim().length));
      } catch (e) {
        throw new BizError(ERR.IMPORT_FORMAT, `Excel 解析失败：${(e as Error).message}`);
      }
    }
    if (rows.length < 2) throw new BizError(ERR.IMPORT_FORMAT, '文件内容为空或缺少表头');

    const headers = rows[0].map((cell) => String(cell ?? '').trim());
    const adapter = pickCaseAdapter(headers, body.adapterCode);
    const { messages, failed } = adapter.parse(rows.slice(1), headers);
    if (!messages.length) throw new BizError(ERR.IMPORT_VALIDATE, '所有行都解析失败，请检查文件格式');

    const tags = Array.isArray(body.tags) ? body.tags.map((tag) => String(tag).trim()).filter(Boolean) : [];
    const caseRow = await this.db.one<{ id: number }>(
      `INSERT INTO cases (title, source_type, shop, stage, tags, message_count, duration_sec, status, created_by)
       VALUES ($1,'file',$2,$3,$4::jsonb,$5,0,'ready',$6) RETURNING id`,
      [
        body.title,
        body.shop ?? null,
        body.stage === 'aftersale' ? 'aftersale' : 'presale',
        JSON.stringify(tags),
        messages.length,
        accountId,
      ]
    );
    for (let index = 0; index < messages.length; index += 1) {
      await this.db.query(`INSERT INTO case_messages (case_id, seq, sender, content) VALUES ($1,$2,$3,$4)`, [
        caseRow.id,
        index + 1,
        messages[index].sender,
        messages[index].content,
      ]);
    }
    return { id: caseRow.id, imported: messages.length, failed, adapter: adapter.code };
  }

  async toContent(id: number) {
    const detail = await this.detail(id);
    const buyerMessages = (detail as any).messages.filter((m: any) => m.sender === 'buyer').map((m: any) => m.content);
    if (!buyerMessages.length) throw new BizError(ERR.PARAM, '该案例中没有买家消息，无法生成咨询内容');
    /**
     * 方案 F5-06「从案例中提取买家咨询内容**与买家接受方案**」+ F5-07「优秀回复作为参考答案话术」：
     * 客服话术优先取「被标记为优秀回复」的那些；一条都没标时退回该案例的全部客服话术；
     * 案例里连客服话术都没有才留占位提示（人工补充）。
     */
    const agentMessages = (detail as any).messages
      .filter((m: any) => m.sender === 'agent')
      .map((m: any) => ({ content: String(m.content || '').trim(), excellent: !!m.isExcellent }))
      .filter((m: any) => m.content);
    const excellent = agentMessages.filter((m: any) => m.excellent);
    const acceptedAnswer = (excellent.length ? excellent : agentMessages)
      .map((m: any) => m.content)
      .join(' ')
      .slice(0, 500);
    const question = buyerMessages.slice(0, 5).join('；');
    const questionList = buyerMessages.slice(0, 5);
    const row = await this.db.one<{ id: number }>(
      `INSERT INTO buyer_qa (template_name, question, question_list, key_points, accepted_answer, stage, category)
       VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6,'通用') RETURNING id`,
      [
        `案例导入-${detail.title}`.slice(0, 60),
        question,
        JSON.stringify(questionList),
        JSON.stringify(questionList.map(() => ['有效回应'])),
        acceptedAnswer || '由案例收藏导入，请补充买家接受方案与要点',
        detail.stage,
      ]
    );
    return {
      contentId: row.id,
      questionList,
      acceptedAnswer: acceptedAnswer || null,
      // 用了多少条「优秀回复」做参考答案（0 表示退回全部客服话术），界面上可以直接告诉带教
      excellentUsed: excellent.length,
      agentReplyCount: agentMessages.length,
    };
  }

  async markExcellent(messageId: number, isExcellent: boolean) {
    await this.db.query(`UPDATE case_messages SET is_excellent = $2 WHERE id = $1`, [messageId, isExcellent]);
    return { success: true };
  }

  /** 案例的标题 / 店铺 / 阶段 / 标签维护（方案 F5-05）。 */
  async update(id: number, body: { title?: string; shop?: string; stage?: string; tags?: string[] }) {
    const row = await this.db.one<any>(`SELECT * FROM cases WHERE id = $1`, [id]);
    if (!row) throw new BizError(ERR.NOT_FOUND, '案例不存在');
    const tags = Array.isArray(body.tags)
      ? body.tags.map((tag) => String(tag).trim()).filter(Boolean)
      : Array.isArray(row.tags)
        ? row.tags
        : [];
    await this.db.query(`UPDATE cases SET title = $2, shop = $3, stage = $4, tags = $5::jsonb WHERE id = $1`, [
      id,
      body.title ?? row.title,
      body.shop ?? row.shop,
      body.stage ?? row.stage,
      JSON.stringify(tags),
    ]);
    return { success: true };
  }

  /**
   * 把一次训练接待标记为典型案例推入案例库（方案 F5-09）。
   * 标题里带接待编号，天然按「这一次接待」去重，不需要额外加字段。
   */
  async fromAttempt(attemptId: number, accountId: number, highlight = false) {
    const attempt = await this.db.one<any>(
      `SELECT a.id, a.attempt_no AS "attemptNo", a.level, a.status, a.conclusion, g.name AS "groupName"
       FROM attempts a
       LEFT JOIN accounts ac ON ac.id = a.account_id
       LEFT JOIN groups g ON g.id = ac.group_id
       WHERE a.id = $1`,
      [attemptId]
    );
    if (!attempt) throw new BizError(ERR.NOT_FOUND, '接待记录不存在');
    if (attempt.status === 'running') throw new BizError(ERR.PARAM, '接待尚未结束，结束后才能转为案例');

    const title = `训练明细-${attempt.attemptNo}（${attempt.level}）`.slice(0, 160);
    const existing = await this.db.one<{ id: number }>(
      `SELECT id FROM cases WHERE source_type = 'attempt' AND title = $1`,
      [title]
    );
    if (existing) throw new BizError(ERR.PARAM, '这次接待已经转为案例了');

    const messages = await this.db.many<{ sender: string; content: string }>(
      `SELECT m.sender, m.content
       FROM messages m JOIN sessions s ON s.id = m.session_id
       WHERE s.attempt_id = $1 AND m.sender IN ('buyer','agent')
       ORDER BY m.session_id, m.id`,
      [attemptId]
    );
    if (!messages.length) throw new BizError(ERR.PARAM, '该接待没有可导入的对话消息');

    const stageRows = await this.db.many<{ stage: string | null }>(
      `SELECT DISTINCT sc.stage FROM sessions s LEFT JOIN scripts sc ON sc.id = s.script_id WHERE s.attempt_id = $1`,
      [attemptId]
    );
    const stage = stageRows.some((row) => row.stage === 'aftersale') ? 'aftersale' : 'presale';
    // 方案 F2-06：标记为「典型案例」时额外打标签，便于在案例库里筛出来当培训素材
    const tags = [
      '训练明细',
      attempt.level,
      attempt.conclusion === 'pass' ? '达标' : '未达标',
      ...(highlight ? ['典型案例'] : []),
    ];

    const caseRow = await this.db.one<{ id: number }>(
      `INSERT INTO cases (title, source_type, shop, stage, tags, message_count, duration_sec, status, created_by)
       VALUES ($1,'attempt',$2,$3,$4::jsonb,$5,0,'ready',$6) RETURNING id`,
      [title, attempt.groupName ?? null, stage, JSON.stringify(tags), messages.length, accountId]
    );
    for (let index = 0; index < messages.length; index += 1) {
      await this.db.query(`INSERT INTO case_messages (case_id, seq, sender, content) VALUES ($1,$2,$3,$4)`, [
        caseRow.id,
        index + 1,
        messages[index].sender === 'buyer' ? 'buyer' : 'agent',
        messages[index].content,
      ]);
    }
    return { caseId: caseRow.id, messageCount: messages.length, title };
  }

  async remove(id: number) {
    await this.db.query(`DELETE FROM case_messages WHERE case_id = $1`, [id]);
    await this.db.query(`DELETE FROM cases WHERE id = $1`, [id]);
    return { success: true };
  }
}
