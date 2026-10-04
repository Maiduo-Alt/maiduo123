export interface ApiResult<T> {
  code: number;
  message: string;
  data: T;
}

const TOKEN_KEY = 'cs-training-token';

/**
 * 接口根地址（部署用）：默认走同域相对路径 `/api`（nginx 反代）。
 * 前后端分开部署时（例如前端放 Cloudflare Pages、API 放 Render/Koyeb），
 * 构建时注入 `VITE_API_BASE=https://your-api.example.com` 即可，见 deploy/FREE.md。
 */
export const API_BASE = String((import.meta as any).env?.VITE_API_BASE || '').replace(/\/+$/, '');

/** 带根地址的完整接口 URL（导出给其它模块拼地址用） */
export const withApiBase = (path: string) => `${API_BASE}${path}`;

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    public code: number,
    message: string
  ) {
    super(message);
  }
}

export async function api<T = any>(
  path: string,
  options: { method?: string; body?: any; query?: Record<string, any> } = {}
): Promise<T> {
  const query = options.query
    ? '?' +
      Object.entries(options.query)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&')
    : '';
  const res = await fetch(withApiBase(`/api${path}${query}`), {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const json = (await res.json()) as ApiResult<T>;
  if (json.code !== 0) {
    if (json.code === 1002) {
      setToken(null);
      if (!location.pathname.startsWith('/login')) location.href = '/login';
    }
    throw new ApiError(json.code, json.message);
  }
  return json.data;
}

/**
 * 上传图片（商品主图/详情图、内容配图、头像），返回可直接访问的地址。
 * 注意：不要手动设置 Content-Type，浏览器会自动带 multipart 边界。
 */
export async function uploadImage(file: File): Promise<string> {
  const form = new FormData();
  form.append('file', file);
  const token = getToken();
  const res = await fetch(withApiBase('/api/uploads'), {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  });
  const json = (await res.json()) as ApiResult<{ url: string }>;
  if (json.code !== 0) throw new ApiError(json.code, json.message);
  return json.data.url;
}

/**
 * 带登录态下载文件（导出 Excel、导入模板等）。
 * 这类接口返回的是二进制流，不能用普通的 api()，也不能直接 <a href>（带不上 Authorization）。
 */
export async function download(path: string, query: Record<string, any> = {}, filename?: string): Promise<void> {
  const qs =
    '?' +
    Object.entries(query)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      .join('&');
  const token = getToken();
  const res = await fetch(withApiBase(`/api${path}${qs}`), {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`);
  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') || '';
  const matched = /filename="?([^";]+)"?/.exec(disposition);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename || matched?.[1] || 'download';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
