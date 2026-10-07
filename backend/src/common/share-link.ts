/**
 * 分享链接识别（2026-10-07 客户新增「一键添加商品」）。
 * 从店铺分享链接中提取商品信息（标题 / 价格 / 主图 / 详情图），供新建商品表单预填。
 *
 * 平台策略：抖音（v.douyin.com 短链与 haohuo.jinritemai.com 商品页）、
 * 淘宝/天猫（taobao.com/tmall.com/tb.cn）、京东（jd.com/3.cn）；
 * 其它平台先给出明确提示，后续按同样模式扩展。
 *
 * 纯函数 + 可注入 fetch，方便单测（不联网）。
 */

export type SharePlatform = 'douyin' | 'taobao' | 'jd' | 'unknown';

export interface ShareProductPreview {
  platform: SharePlatform;
  /** 识别出的商品标题 */
  title?: string;
  /** 销售价（元） */
  price?: number;
  /** 划线价/最高价（元），仅当与售价不同时给出 */
  originPrice?: number;
  /** 主图 */
  coverUrl?: string;
  /** 详情图 */
  detailImages?: string[];
  /** 最终落到的商品页地址（溯源用） */
  sourceUrl: string;
  /** 降级提示（如：页面有访问验证，仅预填了标题，价格/图片需手动补充） */
  notice?: string;
}

/** 从用户粘贴的分享文本里抽出第一个 http(s) 链接（分享文案常带「复制此链接」等前后文）。 */
export function extractUrl(text: string): string {
  const match = String(text || '').match(/https?:\/\/[^\s"'<>，。；）)】\]]+/);
  if (!match) throw new Error('没有从内容里找到链接，请粘贴商品分享链接');
  let url = match[0].replace(/[.,;!?，。；！？]+$/, '');
  // 短链结尾多余斜杠不影响解析，但去掉尾巴标点后的裸域名要补回路径分隔
  return url;
}

/** 从分享文案本身提取商品标题。
 *  淘宝/京东分享格式：…「商品标题」点击链接直接打开（标题在直角引号里，最可靠）；
 *  抖音分享格式：【抖音商城】<链接> 【店铺名】商品标题…（换行）长按复制此条消息…
 *  不依赖访问商品页，属于兜底手段。 */
export function extractTitleFromShareText(text: string): string | null {
  const raw = String(text || '');
  const corner = raw.match(/「([^」]{4,80})」/);
  if (corner) return corner[1].trim();
  const urlMatch = raw.match(/https?:\/\/[^\s"'<>，。；）)】\]]+/);
  let tail = urlMatch ? raw.slice((urlMatch.index ?? 0) + urlMatch[0].length) : raw;
  tail = tail.split(/\r?\n/)[0];
  tail = tail.replace(/^\s*【[^】]*】\s*/, ''); // 去掉店铺名标签
  tail = tail.replace(/(长按复制.*|复制此条消息.*|打开抖音.*|查看商品详情.*|:\s*[a-z0-9]{2,4}\s*)$/i, '').trim();
  return tail.length >= 4 ? tail : null;
}

/** 识别平台。抖音系：v.douyin.com / douyin.com / jinritemai.com；
 *  淘宝系：taobao.com / tmall.com / tb.cn；京东：jd.com / 3.cn。 */
export function detectPlatform(url: string): SharePlatform {
  if (/douyin\.com|jinritemai\.com/i.test(url)) return 'douyin';
  if (/taobao\.com|tmall\.com|tb\.cn/i.test(url)) return 'taobao';
  if (/jd\.com|3\.cn/i.test(url)) return 'jd';
  return 'unknown';
}

/** 图片地址补全：协议相对地址 //host/path → https://host/path */
function fixImageUrl(url: unknown): string | null {
  if (typeof url !== 'string' || !url.trim()) return null;
  const value = url.trim();
  if (value.startsWith('//')) return `https:${value}`;
  if (/^https?:\/\//i.test(value)) return value;
  return null;
}

/** 详情图字段既可能是字符串数组，也可能是 [{url:...}] 对象数组，统一收敛成字符串数组。 */
function toImageList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const url = fixImageUrl(typeof item === 'string' ? item : (item as any)?.url ?? (item as any)?.src ?? (item as any)?.uri);
    if (url) out.push(url);
  }
  return out;
}

/** 抖音价格以「分」为单位存储，转成元；异常值原样返回（交给人工核对）。 */
function centsToYuan(value: unknown): number | undefined {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return undefined;
  return Math.round((num / 100) * 100) / 100;
}

interface ProductCandidate {
  node: Record<string, unknown>;
  score: number;
}

/** 深度优先找「长得像商品信息」的节点：有标题 + 价格字段，图片越多分越高。 */
export function deepFindProduct(root: unknown): Record<string, unknown> | null {
  let best: ProductCandidate | null = null;
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    const title = typeof obj.title === 'string' ? obj.title.trim() : '';
    const hasPrice = ['minPrice', 'maxPrice', 'price', 'salePrice', 'marketPrice'].some((key) => Number(obj[key]) > 0);
    if (title.length >= 4 && hasPrice) {
      const images = toImageList(obj.imgs ?? obj.images ?? obj.mainImages ?? obj.productImgs).length;
      const details = toImageList(obj.detailImgs ?? obj.descImgs ?? obj.detailImages).length;
      const score = images * 2 + details + (typeof obj.productId === 'string' || typeof obj.productId === 'number' ? 2 : 0);
      if (!best || score > best.score) best = { node: obj, score };
    }
    for (const key of Object.keys(obj)) visit(obj[key]);
  };
  visit(root);
  return best ? best.node : null;
}

/** 从抖音商品页 HTML 提取商品信息：优先 RENDER_DATA（URL 编码 JSON），其次 _SSR_DATA，最后 og:meta。 */
export function extractDouyinProduct(html: string): Omit<ShareProductPreview, 'platform' | 'sourceUrl'> | null {
  // 1) <script id="RENDER_DATA" type="application/json">（URL 编码的 JSON）
  const renderDataMatch = html.match(/<script[^>]*id=["']RENDER_DATA["'][^>]*>([\s\S]*?)<\/script>/i);
  if (renderDataMatch) {
    try {
      const parsed = JSON.parse(decodeURIComponent(renderDataMatch[1]));
      const found = deepFindProduct(parsed);
      if (found) return mapDouyinNode(found);
    } catch {
      /* 解析失败继续尝试下一种 */
    }
  }
  // 2) window._SSR_DATA = {...};
  const ssrMatch = html.match(/window\._SSR_DATA\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i);
  if (ssrMatch) {
    try {
      const found = deepFindProduct(JSON.parse(ssrMatch[1]));
      if (found) return mapDouyinNode(found);
    } catch {
      /* 解析失败继续尝试下一种 */
    }
  }
  // 3) og:meta 兜底（只有标题和一张图）
  const title = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i)?.[1];
  const image = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)?.[1];
  if (title) {
    return { title: title.trim(), coverUrl: fixImageUrl(image) || undefined };
  }
  return null;
}

/** 把抖音商品节点映射成预览结构（价格为分→元）。 */
function mapDouyinNode(node: Record<string, unknown>) {
  const mainImages = toImageList(node.imgs ?? node.images ?? node.mainImages ?? node.productImgs);
  const detailImages = toImageList(node.detailImgs ?? node.descImgs ?? node.detailImages);
  const price = centsToYuan(node.minPrice ?? node.price ?? node.salePrice);
  const maxPrice = centsToYuan(node.maxPrice ?? node.marketPrice);
  return {
    title: String(node.title || '').trim() || undefined,
    price,
    originPrice: maxPrice !== undefined && maxPrice !== price ? maxPrice : undefined,
    coverUrl: mainImages[0],
    detailImages: [...mainImages.slice(1), ...detailImages].slice(0, 5),
  };
}

/** 手动跟随跳转（短链 → 商品页），最多 5 次；有的链路会带着跟踪参数多次 302。 */
async function resolveRedirects(url: string, fetchImpl: typeof fetch, userAgent: string): Promise<string> {
  let current = url;
  for (let i = 0; i < 5; i += 1) {
    const res = await fetchImpl(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      headers: { 'User-Agent': userAgent },
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new Error('链接跳转异常（缺少目标地址）');
      current = new URL(location, current).toString();
      continue;
    }
    // 2xx/4xx/5xx 都按落地页处理（4xx 由后续解析报错）
    return current;
  }
  throw new Error('链接跳转次数过多，请直接粘贴商品页链接');
}

/** 命中这些字样说明拿到的是门户首页（被平台软拦截重定向了），不是商品页。 */
function looksLikePortal(title: string): boolean {
  return /京东\(JD\.COM\)|正品低价|轻松购物|淘宝网|淘！我喜欢|天猫Tmall\.com|抖音电商/i.test(title);
}

/** 京东商品页解析：标题取 sku-name → og:title → <title>（去「店铺/京东」后缀），价格走公开的 p.3.cn 接口。
 *  机房 IP 常被京东软拦截到首页，门户标题一律拒绝，交给文案兜底。 */
export function extractJdProduct(html: string): Omit<ShareProductPreview, 'platform' | 'sourceUrl'> | null {
  const candidates: Array<string | undefined> = [
    html.match(/<div[^>]*class=["'][^"']*sku-name[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1]
      ?.replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
    html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i)?.[1],
    html.match(/<title>([^<]+)<\/title>/i)?.[1]?.split('【')[0].replace(/[_-]?\s*[-—]?\s*京东.*$/i, '').trim(),
  ];
  const title = candidates.find((t) => t && t.length >= 4 && !looksLikePortal(t)) || '';
  if (!title) return null;
  const cover = html.match(/<img[^>]*id=["']spec-img["'][^>]*src=["']([^"']+)["']/i)?.[1]
    ?? html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)?.[1];
  return { title, coverUrl: fixImageUrl(cover) || undefined };
}

/** 从京东商品页地址取 skuId（item.jd.com/123.html 或 ?skuId=123），供价格接口用。 */
export function extractJdSkuId(url: string): string | null {
  return url.match(/\/(\d{5,})\.html/)?.[1] || url.match(/[?&]skuId=(\d+)/i)?.[1] || null;
}

/** 淘宝商品页解析：能打开时取 og:title（常被登录页/门户页拦截，取不到就走文案兜底）。 */
export function extractTaobaoProduct(html: string): Omit<ShareProductPreview, 'platform' | 'sourceUrl'> | null {
  const title = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i)?.[1]?.trim();
  if (title && title.length >= 4 && !/登录|login/i.test(title) && !looksLikePortal(title)) return { title };
  return null;
}

/** 各平台抓取用的 UA：抖音用 iPhone（和分享场景一致），淘宝/京东用桌面 Chrome。 */
function userAgentFor(platform: SharePlatform): string {
  if (platform === 'douyin') {
    return 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  }
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
}

const PLATFORM_NAMES: Record<Exclude<SharePlatform, 'unknown'>, string> = { douyin: '抖音', taobao: '淘宝', jd: '京东' };

/** 一键识别的入口：粘贴文本 → 抽链接 → 跳转到商品页按平台解析；
 *  页面被风控/纯 JS 渲染时降级为「分享文案标题 + 人工补充价格图片」。 */
export async function importFromShareLink(text: string, fetchImpl: typeof fetch = fetch): Promise<ShareProductPreview> {
  const url = extractUrl(text);
  const platform = detectPlatform(url);
  if (platform === 'unknown') {
    throw new Error('暂不支持该平台链接，目前支持抖音、淘宝、京东的商品分享链接（也可手动新建商品）');
  }
  const textTitle = extractTitleFromShareText(text);
  let sourceUrl = url;
  let data: Omit<ShareProductPreview, 'platform' | 'sourceUrl'> | null = null;
  let jdPrice: { price?: number; originPrice?: number } = {};
  const ua = userAgentFor(platform);
  try {
    sourceUrl = await resolveRedirects(url, fetchImpl, ua);
    const res = await fetchImpl(sourceUrl, { signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': ua } });
    if (res.ok) {
      const length = Number(res.headers.get('content-length') || 0);
      if (length <= 5 * 1024 * 1024) {
        const html = await res.text();
        if (platform === 'jd') {
          data = extractJdProduct(html);
          const skuId = extractJdSkuId(sourceUrl);
          if (skuId) {
            try {
              const pres = await fetchImpl(`https://p.3.cn/prices/mgets?skuIds=J_${skuId}`, {
                signal: AbortSignal.timeout(8_000),
                headers: { 'User-Agent': ua },
              });
              if (pres.ok) {
                const plist = JSON.parse(await pres.text());
                const price = Number(plist?.[0]?.p);
                const origin = Number(plist?.[0]?.op);
                if (price > 0) jdPrice = { price, originPrice: origin > price ? origin : undefined };
              }
            } catch {
              /* 价格接口失败不阻断，标题已拿到 */
            }
          }
        } else if (platform === 'taobao') {
          data = extractTaobaoProduct(html);
        } else {
          data = extractDouyinProduct(html);
        }
      }
    }
  } catch {
    /* 网络失败/被风控：走文案兜底，不直接报错 */
  }
  const merged = { ...data, ...jdPrice };
  const title = merged.title || textTitle;
  if (!title) {
    throw new Error('未能识别出商品信息（链接无法访问，且分享文案里没有标题），请手动新建商品');
  }
  const notice =
    merged.price && merged.coverUrl
      ? undefined
      : `${PLATFORM_NAMES[platform]}商品页未能完整读取，已预填标题；价格、图片请手动补充（也可直接手动新建商品）`;
  return { platform, sourceUrl, ...merged, title, notice };
}
