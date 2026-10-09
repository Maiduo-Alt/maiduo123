/**
 * CS-Training 商品采集助手 - 后台服务
 * 点击工具栏图标时：识别当前标签页是否为淘宝/天猫/京东商品页，
 * 是则注入提取函数采集商品信息，写入暂存后打开训练系统商品库并预填；
 * 否则直接打开训练系统。
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
  const imgs = [...document.querySelectorAll('img')]
    .map((i) => abs(i.getAttribute('src') || i.getAttribute('data-src') || i.getAttribute('data-lazy-src')))
    .filter(Boolean);

  if (host.endsWith('jd.com')) {
    r.platform = '京东';
    r.title = text('.sku-name') || text('div.sku-name') || meta('og:title');
    const priceText =
      text('.summary-price .p-price .price') ||
      text('.p-price .price') ||
      text('#jd-price') ||
      text('.summary-price') ||
      text('#price');
    r.price = num(priceText);
    r.coverUrl = abs((document.querySelector('#spec-img') || {}).getAttribute?.('src') || '') || meta('og:image');
    r.detailImages = uniq(
      imgs.filter((u) => u.includes('360buyimg.com') && !/icon|logo|sprite|blank|gif/i.test(u))
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
    r.coverUrl =
      meta('og:image') ||
      abs((document.querySelector('#J_ImgBooth') || document.querySelector('.tb-img img') || {}).getAttribute?.('src') || '');
    r.detailImages = uniq(
      imgs.filter((u) => u.includes('alicdn.com') && /imgextra|wwcdn/.test(u) && !/icon|logo|tfs|sprite|gif/i.test(u))
    ).slice(0, 5);
  }
  if (!r.coverUrl && r.detailImages.length) r.coverUrl = r.detailImages[0];
  return r;
}
