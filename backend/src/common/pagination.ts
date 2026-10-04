export interface PageQuery {
  page?: number | string;
  pageSize?: number | string;
}

export function normalizePage(query: PageQuery): { page: number; pageSize: number; offset: number; limit: number } {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(query.pageSize) || 20));
  return { page, pageSize, offset: (page - 1) * pageSize, limit: pageSize };
}

export function pageResult<T>(rows: T[], total: number, page: number, pageSize: number) {
  return { list: rows, total, page, pageSize };
}
