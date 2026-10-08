import { Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { BizError, ERR } from '../../common/errors';
import { normalizePage, pageResult, PageQuery } from '../../common/pagination';
import { base64ToBuffer, parseXlsx } from '../../common/xlsx';
import { buildXlsx } from '../../common/xlsx-writer';
import { parseCsvLine } from '../../common/csv';
import { importFromShareLink } from '../../common/share-link';

export interface ProductInput {
  productNo: string;
  title: string;
  coverUrl?: string;
  detailImages?: string[];
  price: number;
  originPrice?: number;
  stock?: number;
  skus?: any[];
  services?: string[];
  scenes?: string[];
  category?: string;
  status?: number;
}

@Injectable()
export class ProductsService {
  constructor(private readonly db: DbService) {}

  /** 统一把 product_ids 转成数字数组（pg-mem 可能以字符串返回 JSONB）。 */
  private toIdArray(value: any): number[] {
    let parsed = value;
    if (typeof value === 'string') {
      try {
        parsed = JSON.parse(value);
      } catch {
        parsed = [];
      }
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => Number(item)).filter((item) => Number.isFinite(item));
  }

  /** 每个商品被多少个剧本关联（按数组元素精确统计，避免 LIKE 的误匹配）。 */
  private async scriptCountsByProduct(): Promise<Map<number, number>> {
    const rows = await this.db.many<{ product_ids: any }>(`SELECT product_ids FROM scripts`);
    const counts = new Map<number, number>();
    for (const row of rows) {
      for (const id of this.toIdArray(row.product_ids)) counts.set(id, (counts.get(id) || 0) + 1);
    }
    return counts;
  }

  async list(
    query: PageQuery & { keyword?: string; category?: string; status?: string; minPrice?: string; maxPrice?: string }
  ) {
    const { page, pageSize, offset, limit } = normalizePage(query);
    const { whereSql, args } = this.buildFilters(query);
    const total = await this.db.one<{ count: string }>(`SELECT count(*)::text AS count FROM products p WHERE ${whereSql}`, args);
    const rows = await this.db.many<any>(
      `SELECT p.id, p.product_no AS "productNo", p.title, p.cover_url AS "coverUrl", p.price, p.origin_price AS "originPrice",
              p.stock, p.skus, p.services, p.scenes, p.category, p.status
       FROM products p WHERE ${whereSql}
       ORDER BY p.id DESC OFFSET $${args.length + 1} LIMIT $${args.length + 2}`,
      [...args, offset, limit]
    );
    // 关联剧本数量：按 JSONB 数组元素精确统计
    // （此前用 LIKE '%id%' 会把 id=1 误算到 [11]、[21] 上）
    const scriptCountMap = await this.scriptCountsByProduct();
    const categories = await this.db.many<{ category: string }>(
      `SELECT DISTINCT category FROM products WHERE deleted_at IS NULL AND category IS NOT NULL ORDER BY category`
    );
    const list = rows.map((row) => ({ ...row, scriptCount: scriptCountMap.get(Number(row.id)) || 0 }));
    return { ...pageResult(list, Number(total.count), page, pageSize), categories: categories.map((c) => c.category) };
  }

  /** 列表与导出共用的过滤条件（方案 F4-05），避免「导出比看到的多」。 */
  private buildFilters(query: {
    keyword?: string;
    category?: string;
    status?: string;
    minPrice?: string;
    maxPrice?: string;
  }): { whereSql: string; args: unknown[] } {
    const where: string[] = ['p.deleted_at IS NULL'];
    const args: unknown[] = [];
    if (query.keyword) {
      args.push(`%${query.keyword}%`);
      where.push(`(p.title ILIKE $${args.length} OR p.product_no ILIKE $${args.length})`);
    }
    if (query.category) {
      args.push(query.category);
      where.push(`p.category = $${args.length}`);
    }
    if (query.status !== undefined && query.status !== '') {
      args.push(Number(query.status));
      where.push(`p.status = $${args.length}`);
    }
    // 方案 F4-05：按价格区间筛选
    if (query.minPrice !== undefined && query.minPrice !== '') {
      args.push(Number(query.minPrice));
      where.push(`p.price >= $${args.length}`);
    }
    if (query.maxPrice !== undefined && query.maxPrice !== '') {
      args.push(Number(query.maxPrice));
      where.push(`p.price <= $${args.length}`);
    }
    return { whereSql: where.join(' AND '), args };
  }

  /** 导出商品清单为 Excel（方案 F4-07）；列头与导入模板一致，改完能直接导回来。 */
  async exportXlsx(query: { keyword?: string; category?: string; status?: string; minPrice?: string; maxPrice?: string }) {
    const { whereSql, args } = this.buildFilters(query);
    const rows = await this.db.many<any>(
      `SELECT p.product_no AS "productNo", p.title, p.price, p.origin_price AS "originPrice", p.stock,
              p.category, p.services, p.scenes, p.status
       FROM products p WHERE ${whereSql} ORDER BY p.id DESC`,
      args
    );
    const asText = (value: any) => (Array.isArray(value) ? value.join(';') : value || '');
    return buildXlsx([
      {
        name: '商品清单',
        rows: [
          ['product_no', 'title', 'price', 'origin_price', 'stock', 'category', 'services', 'scenes', 'status'],
          ...rows.map((row) => [
            row.productNo,
            row.title,
            Number(row.price ?? 0),
            row.originPrice === null || row.originPrice === undefined ? '' : Number(row.originPrice),
            Number(row.stock ?? 0),
            row.category ?? '',
            asText(row.services),
            asText(row.scenes),
            Number(row.status) === 1 ? '在售' : '已下架',
          ]),
        ],
      },
    ]);
  }

  async detail(id: number) {
    const row = await this.db.one(
      `SELECT p.id, p.product_no AS "productNo", p.title, p.cover_url AS "coverUrl", p.detail_images AS "detailImages",
              p.price, p.origin_price AS "originPrice", p.stock, p.skus, p.services, p.scenes, p.category, p.status
       FROM products p WHERE p.id = $1 AND p.deleted_at IS NULL`,
      [id]
    );
    if (!row) throw new BizError(ERR.NOT_FOUND, '商品不存在');
    const scripts = await this.db.many(
      `SELECT s.id, s.name, s.stage, s.script_no AS "scriptNo"
       FROM scripts s WHERE s.product_ids @> $1::jsonb ORDER BY s.id`,
      [JSON.stringify([id])]
    );
    return { ...row, scripts };
  }

  async create(input: ProductInput) {
    this.validate(input);
    const exists = await this.db.one(`SELECT id FROM products WHERE product_no = $1`, [input.productNo]);
    if (exists) throw new BizError(ERR.PARAM, '商品ID已存在');
    const row = await this.db.one<{ id: number }>(
      `INSERT INTO products (product_no, title, cover_url, detail_images, price, origin_price, stock, skus, services, scenes, category, status)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12) RETURNING id`,
      [
        input.productNo,
        input.title,
        input.coverUrl || '',
        JSON.stringify(input.detailImages || []),
        input.price,
        input.originPrice ?? null,
        input.stock ?? 0,
        JSON.stringify(input.skus || []),
        JSON.stringify(input.services || []),
        JSON.stringify(input.scenes || []),
        input.category || '未分类',
        input.status ?? 1,
      ]
    );
    return { id: row.id };
  }

  async update(id: number, input: Partial<ProductInput>) {
    const current = await this.db.one(`SELECT * FROM products WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!current) throw new BizError(ERR.NOT_FOUND, '商品不存在');
    await this.db.query(
      `UPDATE products SET title = COALESCE($2, title), cover_url = COALESCE($3, cover_url),
                           detail_images = COALESCE($4::jsonb, detail_images),
                           price = COALESCE($5, price), origin_price = COALESCE($6, origin_price),
                           stock = COALESCE($7, stock), skus = COALESCE($8::jsonb, skus),
                           services = COALESCE($9::jsonb, services), scenes = COALESCE($10::jsonb, scenes),
                           category = COALESCE($11, category), status = COALESCE($12, status)
       WHERE id = $1`,
      [
        id,
        input.title ?? null,
        input.coverUrl ?? null,
        input.detailImages ? JSON.stringify(input.detailImages) : null,
        input.price ?? null,
        input.originPrice ?? null,
        input.stock ?? null,
        input.skus ? JSON.stringify(input.skus) : null,
        input.services ? JSON.stringify(input.services) : null,
        input.scenes ? JSON.stringify(input.scenes) : null,
        input.category ?? null,
        input.status ?? null,
      ]
    );
    return { success: true };
  }

  async remove(id: number) {
    const refs = await this.db.one<{ count: string }>(
      `SELECT count(*)::text AS count FROM scripts WHERE product_ids @> $1::jsonb`,
      [JSON.stringify([id])]
    );
    if (Number(refs.count) > 0) throw new BizError(ERR.MATERIAL_REFERENCED, `该商品被 ${refs.count} 个剧本引用，无法删除，可改为下架`);
    await this.db.query(`UPDATE products SET deleted_at = now() WHERE id = $1`, [id]);
    return { success: true };
  }

  /**
   * 批量删除商品（2026-10-07 客户新增）：与单个删除同一口径——软删除（deleted_at），   * 被剧本引用的商品不删（删了会让剧本关联悬空），逐个跳过并在 blocked 里回报
   * 引用数，前端据此提示「可先在剧本库删除相关剧本」。
   */
  async removeMany(ids: number[]) {
    const unique = [...new Set(ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
    if (!unique.length) throw new BizError(ERR.PARAM, '请先选择要删除的商品');
    if (unique.length > 500) throw new BizError(ERR.PARAM, '单次最多删除 500 个商品，请分批操作');
    const placeholders = unique.map((_, i) => `$${i + 1}`).join(',');
    // 参数按位置逐个展开；只处理真实存在且未删除的（deleted_at IS NULL），已删的不重复计数
    const existingRows = await this.db.many<{ id: number; title: string }>(
      `SELECT id, title FROM products WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
      unique
    );
    const existing = existingRows || [];
    if (!existing.length) return { success: true, deleted: 0, blocked: [], total: 0 };
    const blocked: { id: number; title: string; scriptCount: number }[] = [];
    const deletable: number[] = [];
    for (const product of existing) {
      const refs = await this.db.one<{ count: string }>(
        `SELECT count(*)::text AS count FROM scripts WHERE product_ids @> $1::jsonb`,
        [JSON.stringify([product.id])]
      );
      const scriptCount = Number(refs.count);
      if (scriptCount > 0) blocked.push({ id: product.id, title: product.title, scriptCount });
      else deletable.push(product.id);
    }
    if (deletable.length) {
      await this.db.query(
        `UPDATE products SET deleted_at = now() WHERE id IN (${deletable.map((_, i) => `$${i + 1}`).join(',')})`,
        deletable
      );
    }
    return { success: true, deleted: deletable.length, blocked, total: unique.length };
  }

  /**
   * 一键添加商品（2026-10-07 客户新增）：识别店铺商品分享链接，返回预填信息（不落库）。
   * 识别顺序：无头浏览器抓取服务（deploy/scraper，能拿到价格/图片）→ 纯 HTTP 解析 → 分享文案标题兜底。
   * 识别失败给出明确原因，前端回退到手动新建。
   */
  async importFromLink(text: string) {
    try {
      return await importFromShareLink(text, fetch, (url) => this.scrapeWithBrowser(url));
    } catch (err) {
      throw new BizError(ERR.IMPORT_VALIDATE, (err as Error).message || '链接识别失败，请手动新建商品');
    }
  }

  /**
   * 调用无头浏览器抓取服务（同一 compose 网络里的 scraper 容器）。
   * 任何失败（服务未部署/超时/对方风控）都返回 null，由上层回退，不影响主流程。
   */
  private async scrapeWithBrowser(url: string) {
    const base = process.env.SCRAPER_URL || 'http://scraper:9090';
    try {
      const res = await fetch(`${base}/scrape`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(75_000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as any;
      const preview = body?.preview;
      // 部分结果也算数：淘宝经常只有价格（标题由分享文案补齐）
      if (body?.error || !preview || (!preview.title && !preview.price && !preview.coverUrl)) return null;
      return preview as {
        title?: string;
        price?: number;
        originPrice?: number;
        coverUrl?: string;
        detailImages?: string[];
        sourceUrl?: string;
      };
    } catch {
      return null;
    }
  }

  /** CSV 导入：首行为表头。 */
  async importCsv(csv: string) {
    const rows = csv
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => this.parseCsvLine(line));
    if (rows.length < 2) throw new BizError(ERR.IMPORT_FORMAT, 'CSV 内容为空或缺少表头');
    return this.importRows(rows);
  }

  /** Excel(.xlsx) 导入：与 CSV 共用同一套表头校验与落库逻辑。 */
  async importXlsx(base64: string) {
    let rows: string[][];
    try {
      rows = parseXlsx(base64ToBuffer(base64)).filter((row) => row.some((cell) => String(cell ?? '').trim().length));
    } catch (e) {
      throw new BizError(ERR.IMPORT_FORMAT, `Excel 解析失败：${(e as Error).message}`);
    }
    if (rows.length < 2) throw new BizError(ERR.IMPORT_FORMAT, 'Excel 内容为空或缺少表头');
    return this.importRows(rows);
  }

  /**
   * 统一的按行导入：首行为表头，
   * 支持 product_no/title/price/stock/category/services/scenes。
   */
  async importRows(rows: string[][]) {
    const header = rows[0].map((h) => String(h ?? '').trim());
    const requiredCols = ['product_no', 'title', 'price'];
    for (const col of requiredCols) {
      if (!header.includes(col)) throw new BizError(ERR.IMPORT_FORMAT, `导入内容缺少必填列：${col}`);
    }
    const failed: { row: number; reason: string }[] = [];
    let success = 0;
    // 方案 9.2 场景七：分类不存在应计入失败清单
    const categoryRows = await this.db.many<{ name: string }>(`SELECT name FROM categories WHERE type = 'product'`);
    const validCategories = new Set(categoryRows.map((row) => row.name));
    for (let i = 1; i < rows.length; i += 1) {
      const cells = rows[i];
      const record: Record<string, string> = {};
      header.forEach((h, idx) => (record[h] = String(cells[idx] ?? '').trim()));
      try {
        if (!record.product_no || !record.title) throw new Error('商品ID与标题为必填');
        const price = Number(record.price);
        if (!Number.isFinite(price) || price <= 0) throw new Error('价格必须为正数');
        const exists = await this.db.one(`SELECT id FROM products WHERE product_no = $1`, [record.product_no]);
        if (exists) throw new Error('商品ID已存在，已跳过');
        if (record.category && validCategories.size && !validCategories.has(record.category)) {
          throw new Error(`分类不存在：${record.category}`);
        }
        await this.create({
          productNo: record.product_no,
          title: record.title,
          price,
          stock: record.stock ? Number(record.stock) : 0,
          category: record.category || '未分类',
          services: record.services ? record.services.split(/[，,;；]/).filter(Boolean) : [],
          scenes: record.scenes ? record.scenes.split(/[，,;；]/).filter(Boolean) : [],
        });
        success += 1;
      } catch (e) {
        failed.push({ row: i + 1, reason: (e as Error).message });
      }
    }
    return { success, failed, total: rows.length - 1 };
  }

  private parseCsvLine(line: string): string[] {
    // 与案例导入共用 common/csv.ts，避免两套 CSV 解析规则慢慢跑偏
    return parseCsvLine(line);
  }

  private validate(input: ProductInput) {
    if (!input.productNo) throw new BizError(ERR.PARAM, '商品ID为必填项');
    if (!input.title) throw new BizError(ERR.PARAM, '商品标题为必填项');
    if (!(input.price > 0)) throw new BizError(ERR.PARAM, '价格必须为正数');
    if (input.stock !== undefined && input.stock < 0) throw new BizError(ERR.PARAM, '库存不能为负数');
  }
}
