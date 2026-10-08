/**
 * 商品分享链接无头浏览器抓取服务（2026-10-07 客户新增：一键添加商品要自动捕捉价格/图片）。
 *
 * 背景：抖音/淘宝/京东商品页对机房 IP 有风控，api 容器里的纯 HTTP 抓取拿不到数据；
 * 这里用真实 Chrome 渲染页面（与正常用户访问一致），再从 DOM / 页面数据脚本里提取
 * 标题、价格、主图、详情图，返回给 api 预填表单。
 *
 * 线上实测结论（2026-10-07，腾讯云轻量服务器机房 IP）：
 *   - 抖音：无头浏览器可完整渲染，标题 + 商品图（主图/详情）可拿到；
 *     价格在 Web 端对未登录用户遮罩（显示 ￥1??），拿不到；
 *   - 京东：桌面版频控页拦截，手机版 item.m.jd.com 可完整渲染，标题 + 图可拿；
 *     价格同样遮罩（未登录）；
 *   - 淘宝：H5 可渲染（X5 挑战可通过），详情 DOM 结构待真实商品链接补充。
 *
 * 仅监听内网（compose 里不映射端口）。单并发排队，逐次启动浏览器，抓完即关，
 * 控制 2C2G 服务器内存（容器上限 1G）。
 */
const http = require('http');
// 用 puppeteer-core + 华为云 Chromium 快照（构建快、国内可达），见 Dockerfile
const puppeteer = require('puppeteer-core');

const PORT = Number(process.env.PORT || 9090);
const BUDGET_MS = Number(process.env.SCRAPE_BUDGET_MS || 35_000);
const CHROME_PATH = process.env.CHROME_PATH || '/chrome/chrome-linux/chrome';

const UA = {
  douyin:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  taobao: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  jd: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
};

function detectPlatform(url) {
  if (/douyin\.com|jinritemai\.com/i.test(url)) return 'douyin';
  if (/taobao\.com|tmall\.com|tb\.cn/i.test(url)) return 'taobao';
  if (/jd\.com|3\.cn/i.test(url)) return 'jd';
  return 'unknown';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 在页面上下文收集原始素材：og:meta、数据脚本、关键 DOM 文本、图片列表。 */
function collectInPage() {
  const meta = (n) =>
    document.querySelector(`meta[property="og:${n}"]`)?.content ||
    document.querySelector(`meta[name="${n}"]`)?.content ||
    null;
  return {
    finalUrl: location.href,
    title: document.title || null,
    ogTitle: meta('title'),
    ogImage: meta('image'),
    renderData: document.getElementById('RENDER_DATA')?.textContent || null,
    ssrData: window._SSR_DATA ? JSON.stringify(window._SSR_DATA) : null,
    initData: window.__INIT_DATA__ ? JSON.stringify(window.__INIT_DATA__) : null,
    skuName: document.querySelector('.sku-name')?.textContent?.trim() || null,
    jdPrice: document.querySelector('.price')?.textContent?.trim() || null,
    // 渲染后的可见文本，抖音标题要从这里提取
    bodyText: document.body?.innerText?.replace(/\s+/g, ' ').slice(0, 2000) || '',
    images: Array.from(document.querySelectorAll('img'))
      .map((i) => i.currentSrc || i.src)
      .filter((s) => typeof s === 'string' && /^https?:/.test(s))
      .slice(0, 60),
  };
}

/** 数字清洗：从「¥89.00」「89元起」等文本里提取价格；
 *  平台遮罩价（￥1??、6??9）含问号，一律拒绝——宁缺毋滥，避免填错价格。 */
function parsePriceText(text) {
  if (!text) return undefined;
  const raw = String(text);
  if (/[?？]/.test(raw)) return undefined;
  const m = raw.replace(/,/g, '').match(/(\d+(?:\.\d{1,2})?)/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** 图片协议补全 + 基础去重去小图/图标。 */
function cleanImages(list, max) {
  const seen = new Set();
  const out = [];
  for (let raw of list || []) {
    if (!raw) continue;
    let url = String(raw).trim();
    if (url.startsWith('//')) url = `https:${url}`;
    if (!/^https?:\/\//i.test(url)) continue;
    if (/1x1|blank|spacer|logo|avatar|icon/i.test(url)) continue;
    const key = url.split('?')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
    if (out.length >= max) break;
  }
  return out;
}

/** 深度优先找「标题+价格」商品节点（数据脚本里字段最全时走这里）。 */
function deepFindProduct(root, depth = 0) {
  if (!root || typeof root !== 'object' || depth > 12) return null;
  if (Array.isArray(root)) {
    for (const item of root) {
      const hit = deepFindProduct(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  const title = typeof root.title === 'string' ? root.title.trim() : '';
  const priceKeys = ['minPrice', 'maxPrice', 'price', 'salePrice', 'marketPrice', 'reservePrice', 'priceWap'];
  const hasPrice = priceKeys.some((k) => Number(root[k]) > 0);
  if (title.length >= 4 && hasPrice) {
    const images = [];
    const pushImgs = (v) => {
      if (Array.isArray(v)) {
        for (const it of v) {
          const u = typeof it === 'string' ? it : it && (it.url || it.src || it.uri);
          if (u) images.push(u);
        }
      }
    };
    pushImgs(root.imgs || root.images || root.mainImages || root.pics || root.picArray);
    pushImgs(root.detailImgs || root.descImgs || root.detailImages);
    return { title, node: root, images };
  }
  for (const key of Object.keys(root)) {
    const hit = deepFindProduct(root[key], depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** 把收集到的素材整理成统一预览结构；识别不出返回 null（api 继续走降级）。 */
function buildPreview(platform, raw) {
  // 1) 页面数据脚本（RENDER_DATA / _SSR_DATA / __INIT_DATA__）优先，字段最全
  for (const payload of [raw.renderData, raw.ssrData, raw.initData]) {
    if (!payload) continue;
    try {
      const text = payload.startsWith('{') || payload.startsWith('[') ? payload : decodeURIComponent(payload);
      const found = deepFindProduct(JSON.parse(text));
      if (found) {
        const node = found.node;
        const convert = (v) => {
          const n = Number(v);
          if (!Number.isFinite(n) || n <= 0) return undefined;
          // 价格可能是分（抖音）也可能是元（淘宝部分接口），启发式：大于 1000 视为分
          return n > 1000 ? Math.round((n / 100) * 100) / 100 : n;
        };
        const price = convert(node.minPrice ?? node.price ?? node.salePrice ?? node.priceWap ?? node.reservePrice);
        const maxPrice = convert(node.maxPrice ?? node.marketPrice);
        const images = cleanImages(found.images, 6);
        return {
          title: found.title,
          price,
          originPrice: maxPrice !== undefined && maxPrice !== price ? maxPrice : undefined,
          coverUrl: images[0],
          detailImages: images.slice(1),
          sourceUrl: raw.finalUrl,
        };
      }
    } catch {
      /* 解析失败尝试下一种 */
    }
  }

  const images = cleanImages([raw.ogImage, ...(raw.images || [])], 8);

  // 2) 抖音：标题在渲染文本里 —— 【店铺名】商品标题 保障/物流 之前
  if (platform === 'douyin') {
    const m = (raw.bodyText || '').match(/【[^】]*】\s*([^【】]{4,80}?)\s*(?:保障|物流|活动|产品参数)/);
    const title = (m?.[1] || raw.ogTitle || '').trim();
    // 商品图：ecombdimg 店铺素材图（过滤 UI 图标/头图）
    const productImgs = (raw.images || []).filter((u) => /ecombdimg\.com\/(?:img\/)?ecom-shop-material/.test(u));
    const gallery = cleanImages(productImgs.length ? productImgs : images, 6);
    if (title.length >= 4) {
      return { title, coverUrl: gallery[0], detailImages: gallery.slice(1), sourceUrl: raw.finalUrl };
    }
    return null;
  }

  // 3) 京东（手机版可渲染）：标题 = sku-name 或 <title> 去后缀；价格未登录遮罩，能拿到就用
  if (platform === 'jd') {
    const title = (
      raw.skuName ||
      raw.ogTitle ||
      (raw.title || '').split('【')[0].replace(/[_-]?\s*[-—]?\s*京东.*$/i, '').trim() ||
      ''
    ).trim();
    if (title && title.length >= 4 && !/京东\(JD\.COM\)|正品低价|轻松购物|频控/.test(title)) {
      // 过滤引流/营销图，只留商品图
      const jdImgs = (raw.images || []).filter(
        (u) => /360buyimg\.com|jdimg\.com/.test(u) && !/unionfe|yinliu|\/mkt\/|icon|logo|app\/|joy\.png/i.test(u)
      );
      const gallery = cleanImages(jdImgs.length ? jdImgs : images, 6);
      return {
        title,
        price: parsePriceText(raw.jdPrice),
        coverUrl: gallery[0],
        detailImages: gallery.slice(1),
        sourceUrl: raw.finalUrl,
      };
    }
    return null;
  }

  // 4) 淘宝/天猫：H5 详情对未登录用户不渲染，但分享跳转落地 URL 自带 price 参数；
  //    标题留给 api 从分享文案「」补齐，这里尽量把价格/图抓到。
  if (platform === 'taobao') {
    const urlPrice = Number((raw.finalUrl.match(/[?&]price=([\d.]+)/) || [])[1]);
    const title = (raw.ogTitle || '').trim();
    // 商品图只信 alicdn 商品域名；tfs/200x200 之类的是 UI 图标，不能当商品图
    const tbImgs = (raw.images || []).filter((u) => /alicdn\.com/.test(u) && /imgextra|wwcdn/.test(u) && !/icon|logo|sprite/i.test(u));
    const gallery = cleanImages(tbImgs, 6);
    if (title && title.length >= 4 && !/登录|淘宝网|商品详情页/.test(title)) {
      return { title, price: Number.isFinite(urlPrice) && urlPrice > 0 ? urlPrice : undefined, coverUrl: gallery[0], detailImages: gallery.slice(1), sourceUrl: raw.finalUrl };
    }
    // 页面没渲染出标题：只要有价格或图也返回（api 会用分享文案标题补齐）
    if ((Number.isFinite(urlPrice) && urlPrice > 0) || gallery.length) {
      return {
        title: '',
        price: Number.isFinite(urlPrice) && urlPrice > 0 ? urlPrice : undefined,
        coverUrl: gallery[0],
        detailImages: gallery.slice(1),
        sourceUrl: raw.finalUrl,
      };
    }
    return null;
  }

  return null;
}

/** 串行队列：2C2G 小机器一次只渲染一个页面。 */
let queue = Promise.resolve();
function enqueue(job) {
  const next = queue.then(job, job);
  queue = next.catch(() => {});
  return next;
}

/** 整体超时兜底：页面脚本卡死时（X5 挑战等）evaluate 可能永远不返回，
 *  Promise.race 强制收尾，并 SIGKILL 浏览器进程，保证队列不被堵死。 */
async function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    sleep(ms).then(() => {
      const err = new Error('scrape timeout');
      err.code = 'TIMEOUT';
      throw err;
    }),
  ]);
}

async function scrape(url) {
  const platform = detectPlatform(url);
  if (platform === 'unknown') return { error: '暂不支持该平台链接，目前支持抖音、淘宝、京东' };
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--single-process',
      '--disable-blink-features=AutomationControlled',
      '--lang=zh-CN',
      '--window-size=390,844',
    ],
  });
  try {
    return await withTimeout(scrapeInner(platform, url, browser), BUDGET_MS + 25_000);
  } catch (e) {
    if (e && e.code === 'TIMEOUT') return { error: '页面脚本无响应，抓取超时' };
    throw e;
  } finally {
    // close 也可能挂：限时 5s，超时就地 SIGKILL
    try {
      await Promise.race([browser.close(), sleep(5000)]);
    } catch {
      /* ignore */
    }
    try {
      if (browser.process() && browser.process().connected) browser.process().kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

async function scrapeInner(platform, url, browser) {
    const page = await browser.newPage();
    await page.setUserAgent(UA[platform]);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9' });
    // 京东桌面版对机房 IP 直接频控，强制用手机版域名
    let target = url;
    if (platform === 'jd') {
      target = url
        .replace(/^https?:\/\/item\.jd\.com\//, 'https://item.m.jd.com/product/')
        .replace(/^https?:\/\/www\.jd\.com\//, 'https://item.m.jd.com/product/');
    }
    const deadline = Date.now() + BUDGET_MS;
    await page.goto(target, {
      waitUntil: 'domcontentloaded',
      timeout: 25_000,
      referer: platform === 'taobao' ? 'https://h5.m.taobao.com/' : undefined,
    });
    // 轮询：页面数据脚本/DOM 就绪就提前结束，最长等到预算耗尽
    let raw = null;
    for (let i = 0; i < 24; i += 1) {
      await sleep(2000);
      raw = await page.evaluate(collectInPage).catch(() => null);
      if (!raw) continue;
      const ready =
        raw.renderData ||
        raw.ssrData ||
        raw.initData ||
        raw.skuName ||
        // 淘宝：跳转落地 URL 带 id+price 就够了（详情 DOM 对未登录用户不渲染，等也没用）
        (platform === 'taobao' && /detail\.htm\?id=\d+/.test(raw.finalUrl) && /[?&]price=/.test(raw.finalUrl)) ||
        (raw.images || []).some((u) => /ecom-shop-material|360buyimg|alicdn\.com\/imgextra/.test(u)) ||
        /频控/.test(raw.title || '');
      if (ready) {
        // 再等一拍让图片/价格渲染完整
        await sleep(1500);
        raw = await page.evaluate(collectInPage).catch(() => raw);
        break;
      }
      if (Date.now() > deadline) break;
    }
    if (!raw) return { error: '页面加载超时' };
    const preview = buildPreview(platform, raw);
    // 部分结果也算成功：标题缺失时 api 会用分享文案标题补齐
    if (!preview || (!preview.title && !preview.price && !preview.coverUrl)) {
      return { error: '未能从渲染后的页面识别出商品信息' };
    }
    return { preview };
}

const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  if (req.method !== 'POST' || req.url !== '/scrape') {
    if (req.method === 'GET' && req.url === '/health') {
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > 4096) req.destroy();
  });
  req.on('end', () => {
    let url;
    try {
      url = JSON.parse(body || '{}').url;
    } catch {
      url = undefined;
    }
    if (!url || !/^https?:\/\//.test(url)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: '缺少有效的 url 参数' }));
      return;
    }
    enqueue(() => scrape(String(url)))
      .then((result) => res.end(JSON.stringify(result)))
      .catch((err) => res.end(JSON.stringify({ error: String((err && err.message) || err) })));
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`scraper listening on :${PORT}`);
});
