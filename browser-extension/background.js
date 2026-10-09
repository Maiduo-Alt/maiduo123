/**
 * CS-Training 商品采集助手 - 后台服务
 * 点击工具栏图标时：识别当前标签页是否为淘宝/天猫/京东商品页，
 * 先滚动页面触发懒加载模块渲染，等待后主注入提取函数采集商品信息，
 * 写入暂存后打开训练系统商品库并预填；否则直接打开训练系统。
 */
const SYSTEM_URL = 'http://1.14.102.186:8080';

chrome.action.onClicked.addListener(async (tab) => {
  let host = '';
  try {
    host = new URL(tab.url || '').hostname;
  } catch {
    return;
  }
  const isShopPage = /(^|\.)((item\.taobao\.com)|(detail\.tmall\.com)|(item\.jd\.com))$/.test(host);
  if (!isShopPage || !tab.id) {
    chrome.tabs.create({ url: `${SYSTEM_URL}/products` });
    return;
  }
  // 京东新版商品页主模块（标题/价格/主图）是滚动懒加载的骨架屏：
  // 先注入 scrollAndWait 阶梯滚动全页 + 轮询等待主图/价格就绪（最多 8 秒），再采集
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scrollAndWait });
  } catch {
    /* 滚动失败也继续，页面上可能已渲染 */
  }
  let payload = null;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractProduct,
    });
    payload = res && res.result ? res.result : null;
  } catch {
    payload = null;
  }
  if (payload) payload.extensionVersion = chrome.runtime.getManifest().version;
  if (!payload || (!payload.title && !payload.price)) {
    await chrome.storage.local.set({
      quickAddError: '未能从当前页面识别商品信息，请确认打开的是商品详情页、页面加载完成且已登录',
    });
    chrome.tabs.create({ url: `${SYSTEM_URL}/products?quickadd=1` });
    return;
  }
  payload.sourceUrl = tab.url;
  await chrome.storage.local.set({ pendingQuickAdd: payload });
  chrome.tabs.create({ url: `${SYSTEM_URL}/products?quickadd=1` });
});

/** 阶梯式滚动全页触发懒加载，并轮询等待主图与价格就绪（最多 8 秒），就绪即返回 */
async function scrollAndWait() {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  document
    .querySelectorAll(
      '.continuous-skeleton-item--price, .continuous-skeleton-item--title, #spec-img, .summary-price, .tb-img, #J_ImgBooth'
    )
    .forEach((e) => e.scrollIntoView({ block: 'center' }));
  await sleep(400);
  const h = document.body.scrollHeight || document.documentElement.scrollHeight || 1;
  for (const p of [0.15, 0.35, 0.55, 0.75, 0.95]) {
    window.scrollTo({ top: h * p, behavior: 'instant' });
    await sleep(600);
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
  const ready = () => {
    const spec = document.querySelector('#spec-img');
    const specOk = !!spec && /360buyimg|alicdn/.test(spec.src || spec.getAttribute('src') || '');
    const priceOk = [...document.querySelectorAll('[class*=price], [id*=price]')].some(
      (e) => /¥?\d+\.\d{2}/.test((e.textContent || '').trim()) && !/skeleton/i.test(String(e.className || ''))
    );
    return specOk && priceOk;
  };
  for (let i = 0; i < 16 && !ready(); i++) await sleep(500);
  return ready();
}

/**
 * 在商品页上下文执行的提取函数（必须自包含，不能使用外部变量）。
 * 用户在浏览器已登录，所以能拿到登录后的完整价格与图片。
 */
function extractProduct() {
  const host = location.hostname;
  const r = { platform: '', title: '', price: null, originPrice: null, coverUrl: '', detailImages: [] };
  const meta = (prop) =>
    ((document.querySelector(`meta[property="${prop}"], meta[name="${prop}"]`) || {}).getAttribute?.('content') || '').trim();
  const text = (sel) => {
    const el = document.querySelector(sel);
    return ((el && el.textContent) || '').trim();
  };
  const num = (s) => {
    const m = String(s || '').replace(/,/g, '').match(/(\d+\.\d{1,2})/);
    return m ? Number(m[1]) : null;
  };
  const abs = (src) => {
    if (!src) return '';
    if (src.startsWith('//')) return 'https:' + src;
    if (src.startsWith('http')) return src;
    return '';
  };
  const uniq = (arr) => [...new Set(arr.filter(Boolean))];
  // img.src 属性反映懒加载后的真实地址；getAttribute 可能拿到占位图，所以优先属性
  const imgs = [...document.querySelectorAll('img')]
    .map((i) => i.src || abs(i.getAttribute('data-src') || i.getAttribute('data-lazy-src') || i.getAttribute('src')))
    .filter((u) => u && !/blank\.(png|gif)/i.test(u));

  if (host.endsWith('jd.com')) {
    r.platform = '京东';
    // 新版京东页标题主要在 document.title：「名称【行情 报价...】-京东」，需清理后缀
    const docTitle = (document.title || '').replace(/【.*$/, '').replace(/[-_]?京东\s*$/, '').trim();
    r.title = text('.sku-name') || text('div.sku-name') || docTitle || meta('og:title');
    // 主价格区渲染后是 [class*=price] 里第一个「¥数字.两位小数」形态的非占位文本；
    // 排除推荐区/活动区/悬浮工具栏等位置的干扰价
    const badArea = (e) => {
      let n = e;
      for (let i = 0; i < 4 && n; i++) {
        if (/recommend|activity|coupon|promotion|toolbar|suspend|float/i.test(String(n.className || ''))) return true;
        n = n.parentElement;
      }
      return false;
    };
    const priceTexts = [...document.querySelectorAll('[class*=price], [id*=price]')]
      .filter((e) => !badArea(e))
      .map((e) => (e.textContent || '').trim())
      .filter((x) => /^\s*¥?\d+\.\d{2}/.test(x) && !/到手价|skeleton|预估/i.test(x));
    r.price = num(priceTexts[0] || '');
    const specImg = document.querySelector('#spec-img') || document.querySelector('.main-img img');
    r.coverUrl = (specImg && specImg.src) || abs(specImg?.getAttribute?.('src') || '') || meta('og:image');
    r.detailImages = uniq(
      imgs.filter(
        (u) => u.includes('360buyimg.com') && /jfs|\/n1\//.test(u) && !/icon|logo|sprite|gif/i.test(u)
      )
    ).slice(0, 5);
  } else if (host.endsWith('taobao.com') || host.endsWith('tmall.com')) {
    r.platform = host.endsWith('tmall.com') ? '天猫' : '淘宝';
    const rawTitle = text('.tb-main-title') || text('.tb-detail-hd h1') || meta('og:title') || document.title || '';
    r.title = rawTitle.replace(/[-_].{0,4}(淘宝网|天猫|淘宝).*$/, '').trim();
    const promo =
      text('.tb-promo-price .tb-rmb-num') || text('#J_PromoPriceNum') || text('.tm-promo-price .tm-price') || '';
    const normal =
      text('#J_StrPrice .tb-rmb-num') ||
      text('.tb-rmb-num') ||
      text('.tm-price') ||
      text('[class*="Price"]') ||
      text('[class*="price"]') ||
      '';
    r.price = num(promo) !== null ? num(promo) : num(normal);
    r.originPrice = promo && num(normal) !== null && num(normal) !== r.price ? num(normal) : null;
    const boothImg = document.querySelector('#J_ImgBooth') || document.querySelector('.tb-img img');
    r.coverUrl =
      meta('og:image') || (boothImg && boothImg.src) || abs(boothImg?.getAttribute?.('src') || '');
    r.detailImages = uniq(
      imgs.filter((u) => u.includes('alicdn.com') && /imgextra|wwcdn/.test(u) && !/icon|logo|tfs|sprite|gif/i.test(u))
    ).slice(0, 5);
  }
  if (!r.coverUrl && r.detailImages.length) r.coverUrl = r.detailImages[0];
  return r;
}
