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
  const r = { platform: '', title: '', price: null, originPrice: null, coverUrl: '', detailImages: [], skus: [], attributes: [] };
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
  /**
   * 采集商品属性（详情页参数表，2026-10-09 客户新增）：
   * 表格行 th/td 两两成对（京东参数表/尺码表）、dl 的 dt/dd、
   * 「属性名: 值」形态的列表项（淘宝 attributes-list），去重后最多 40 项。
   */
  const parseAttrs = (roots, parseListItems) => {
    const out = [];
    const seen = new Set();
    const push = (k, v) => {
      k = String(k || '').replace(/[：:\s]+$/, '').trim();
      v = String(v || '').replace(/\s+/g, ' ').trim();
      if (!k || !v || k.length > 20 || v.length > 80) return;
      const key = k + '|' + v;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ name: k, value: v });
    };
    for (const root of roots) {
      if (!root) continue;
      root.querySelectorAll('tr').forEach((tr) => {
        const cells = [...tr.querySelectorAll('th,td')].map((c) => (c.textContent || '').trim()).filter(Boolean);
        if (cells.length >= 2) {
          for (let i = 0; i + 1 < cells.length; i += 2) push(cells[i], cells[i + 1]);
        }
      });
      root.querySelectorAll('dt').forEach((dt) => {
        const dd = dt.nextElementSibling;
        if (dd && dd.tagName === 'DD') push(dt.textContent, dd.textContent);
      });
      if (parseListItems) {
        root.querySelectorAll('li').forEach((li) => {
          const t = (li.textContent || '').trim();
          const m = t.match(/^([^：:]{1,20})[：:]\s*(\S.{0,79})$/);
          if (m) push(m[1], m[2]);
        });
      }
    }
    return out.slice(0, 40);
  };
  /**
   * 采集 SKU 规格选项：按规格组（颜色/尺码/版本…）抓选项名，
   * 输出结构化 {name, size}：第一组作规格名（通常是颜色/款式），尺码类组（组名含 码/尺寸/尺码）
   * 作尺码；多组笛卡尔组合，超过 30 个退化为全部选项平铺。价格/库存页面不直接暴露，留空由用户核对。
   */
  const pickOptionName = (el) => {
    const img = el.querySelector('img');
    return ((img && (img.alt || img.getAttribute('alt'))) || el.textContent || '').replace(/\s+/g, ' ').trim();
  };
  const buildSkus = (groupEls) => {
    const groups = [];
    for (const g of groupEls) {
      const labelEl = g.querySelector('.dt, .tb-property-type, dt');
      const gn = ((labelEl && labelEl.textContent) || '').replace(/[：:]/g, '').trim();
      const options = uniq([...g.querySelectorAll('.item, li')].map(pickOptionName).filter(Boolean));
      if (options.length) groups.push({ name: gn, options });
    }
    if (!groups.length) return [];
    const sizeLike = (g) => /码|尺寸|尺码/.test(g.name || '');
    let items = [];
    if (groups.length >= 2) {
      const [first, ...rest] = groups;
      const restCombos = rest.reduce(
        (acc, g) => acc.flatMap((a) => g.options.map((o) => (a ? `${a}/${o}` : o))),
        ['']
      );
      items = first.options.flatMap((n) => restCombos.map((s) => ({ name: n, size: s })));
      if (items.length > 30) {
        items = groups.flatMap((g) => g.options.map((o) => (sizeLike(g) ? { name: '', size: o } : { name: o, size: '' })));
      }
    } else if (sizeLike(groups[0])) {
      items = groups[0].options.map((o) => ({ name: '', size: o }));
    } else {
      items = groups[0].options.map((o) => ({ name: o, size: '' }));
    }
    const seen = new Set();
    return items
      .filter((it) => {
        const k = `${it.name}|${it.size}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, 30)
      .map((it) => ({ ...it, price: null, stock: null }));
  };
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
    // 商品描述区（详情页长图）优先：接待页详情展示要的是这些图；画廊图作为补充，合并去重最多 10 张
    const descEls = [
      ...document.querySelectorAll('#J-detail-content img, .detail-content img, .describe img'),
    ];
    const descImgs = uniq(
      descEls
        .map((i) => i.src || abs(i.getAttribute('data-src') || i.getAttribute('src')))
        .filter((u) => u && u.includes('360buyimg.com') && !/blank|icon|logo|spacer|gif|1x1/i.test(u))
    );
    r.detailImages = uniq([...descImgs, ...r.detailImages]).slice(0, 10);
    // SKU 规格组：新版页 #choose-attrs，旧版页 #choose/#choose-color/#choose-version 等
    r.skus = buildSkus(
      document.querySelectorAll(
        '#choose-attrs .p-choose-type, #choose .p-choose-type, #choose-color, #choose-version, #choose-attr-1, #choose-attr-2'
      )
    );
    // 商品属性：详情区参数表（Ptable/参数表格），新旧版容器都扫，去重
    r.attributes = parseAttrs(
      [
        document.querySelector('#J-detail'),
        document.querySelector('#J-detail-content'),
        document.querySelector('.detail-content'),
        document.querySelector('.describe'),
        document.querySelector('.Ptable'),
      ],
      false
    );
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
    // 商品描述区（详情页长图）优先，画廊图补充，合并去重最多 10 张
    const descEls = [...document.querySelectorAll('#J_DescContent img, .description img')];
    const descImgs = uniq(
      descEls
        .map((i) => i.src || abs(i.getAttribute('data-src') || i.getAttribute('src')))
        .filter(
          (u) => u && u.includes('alicdn.com') && /imgextra|uploaded/i.test(u) && !/blank|icon|logo|sprite|gif|1x1/i.test(u)
        )
    );
    r.detailImages = uniq([...descImgs, ...r.detailImages]).slice(0, 10);
    // SKU 规格组：淘宝 .J_Prop（.tb-property-type 组名 + li 选项），天猫 dl.tm-sale-prop
    r.skus = buildSkus(document.querySelectorAll('.tb-key .J_Prop, .tb-skin .J_Prop, dl.tm-sale-prop'));
    // 商品属性：淘宝/天猫属性列表（「属性名: 值」形态）+ 详情区表格
    r.attributes = parseAttrs(
      [
        document.querySelector('#J_AttrList'),
        document.querySelector('.attributes-list'),
        document.querySelector('dl.tm-attributes-box'),
        document.querySelector('#J_DescContent'),
      ],
      true
    );
  }
  if (!r.coverUrl && r.detailImages.length) r.coverUrl = r.detailImages[0];
  return r;
}
