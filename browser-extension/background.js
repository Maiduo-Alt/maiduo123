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
  // 京东：PC 页骨架化导致规格/参数经常抓不到；后台直连移动版商品页（带登录态 Cookie），
  // 内嵌 _itemInfo.skuPro 有完整规格组（propName+propSeq），登录后参数表也可能服务端渲染（2026-10-09 v1.2.0）
  if (payload && payload.platform === '京东') {
    const m = (tab.url || '').match(/item\.jd\.com\/(\d+)\.html/);
    if (m) {
      try {
        const resp = await fetch(`https://item.m.jd.com/product/${m[1]}.html`, { credentials: 'include' });
        if (resp.ok) {
          const html = await resp.text();
          if (!payload.skus || !payload.skus.length) {
            payload.skus = parseJdMobileSkus(html);
          }
          if (!payload.attributes || !payload.attributes.length) {
            payload.attributes = parseJdMobileAttrs(html);
          }
        }
      } catch {
        /* 移动页拿不到就退回 PC 页已采集的数据 */
      }
    }
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
 * 从京东移动版商品页 HTML 内嵌数据解析 SKU 规格组（沙箱已验证结构：window._itemInfo 静态 JSON 里的
 * "saleProp":{"1":"颜色","2":"尺码"} + "salePropSeq":{"1":[...],"2":[...]}，无需登录；
 * skuPro 是运行时 JS 拼的，静态 HTML 里没有，不能用它）。
 * 第一组作规格名，组名含「码/尺寸」的作尺码；笛卡尔组合，最多 30 个。
 */
function parseJdMobileSkus(html) {
  try {
    const pName = html.match(/"saleProp":(\{[^{}]*\})/);
    const pSeq = html.match(/"salePropSeq":(\{[^{}]*\})/);
    if (!pName || !pSeq) return [];
    const nameMap = JSON.parse(pName[1]);
    const seq = JSON.parse(pSeq[1]);
    const groups = Object.keys(nameMap)
      .map((k) => ({ name: String(nameMap[k] || ''), options: (seq[k] || []).map(String) }))
      .filter((g) => g.options.length);
    if (!groups.length) return [];
    const sizeIdx = groups.findIndex((g) => /码|尺寸|尺码/.test(g.name));
    const nameIdx = sizeIdx === 0 ? (groups.length > 1 ? 1 : 0) : 0;
    const gName = groups[nameIdx];
    const gSize = sizeIdx >= 0 && sizeIdx !== nameIdx ? groups[sizeIdx] : null;
    let items = [];
    if (gSize) items = gName.options.flatMap((n) => gSize.options.map((s) => ({ name: n, size: s })));
    else items = gName.options.map((n) => ({ name: n, size: '' }));
    const seen = new Set();
    return items
      .filter((it) => {
        const k = it.name + '|' + it.size;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, 30)
      .map((it) => ({ ...it, price: null, stock: null }));
  } catch {
    return [];
  }
}

/**
 * 从京东移动版商品页 HTML 解析服务端渲染的商品参数（登录后解锁「商品参数」）。
 * 只扫参数容器（.Ptable/.p-parameter/.parameter2 等），绝不做全文档扫描——
 * cd.jd.com 描述接口的教训：全 body 扫会把页脚导航（购物指南/配送方式…）当属性（2026-10-09）。
 */
function parseJdMobileAttrs(html) {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const roots = ['.Ptable', '.p-parameter', '.p-parameter-list', '.parameter2', '#J-detail-pop']
      .map((s) => doc.querySelector(s))
      .filter(Boolean);
    if (!roots.length) return [];
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
      root.querySelectorAll('tr').forEach((tr) => {
        const cells = [...tr.querySelectorAll('th,td')].map((c) => (c.textContent || '').trim()).filter(Boolean);
        if (cells.length >= 2) for (let i = 0; i + 1 < cells.length; i += 2) push(cells[i], cells[i + 1]);
      });
      root.querySelectorAll('dt').forEach((dt) => {
        const dd = dt.nextElementSibling;
        if (dd && dd.tagName === 'DD') push(dt.textContent, dd.textContent);
      });
      root.querySelectorAll('li').forEach((li) => {
        const t = (li.textContent || '').trim();
        const m = t.match(/^([^：:]{1,20})[：:]\s*(\S.{0,79})$/);
        if (m) push(m[1], m[2]);
      });
    }
    return out.slice(0, 40);
  } catch {
    return [];
  }
}

/**
 * 在商品页上下文执行的提取函数（必须自包含，不能使用外部变量）。
 * 用户在浏览器已登录，所以能拿到登录后的完整价格与图片。
 */
async function extractProduct() {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
      [...document.querySelectorAll('img')]
        .filter((i) => {
          // 排除页头/页脚/服务/推荐/悬浮区的图标（公共购物车、企、JD logo 等都从这里混入，2026-10-09 沙箱确认）
          if (
            i.closest &&
            i.closest(
              '[class*=footer],[id*=footer],[class*=header],[id*=header],[class*=service],[id*=service],[class*=recommend],[id*=recommend],[class*=toolbar],[class*=suspend],[class*=copyright],[class*=popover],[class*=qrcode]'
            )
          )
            return false;
          const u = i.src || i.getAttribute('data-src') || i.getAttribute('data-lazy-src') || i.getAttribute('src') || '';
          if (!u.includes('360buyimg.com') || !/jfs|\/n1\//.test(u) || /pcpubliccms|icon|logo|sprite|gif|blank/i.test(u)) return false;
          const w = i.naturalWidth || 0;
          return !w || w >= 150;
        })
        .map((i) => i.src || abs(i.getAttribute('data-src') || i.getAttribute('data-lazy-src') || i.getAttribute('src') || ''))
    ).slice(0, 5);
    // 商品描述区（详情页长图）优先：接待页详情展示要的是这些图；画廊图作为补充，合并去重最多 10 张
    const descEls = [
      ...document.querySelectorAll('#J-detail-content img, .detail-content img, .describe img'),
    ];
    const descImgs = uniq(
      descEls
        // 过滤明显的小图标（箭头/logo/角标）：已加载的图用真实尺寸判断，尺寸未知的保留
        .filter((i) => {
          const w = i.naturalWidth || 0;
          return !w || w >= 150;
        })
        .map((i) => i.src || abs(i.getAttribute('data-src') || i.getAttribute('src')))
        // pcpubliccms 是京东 UI 素材库（企业购 logo、公共图标都在这里），不作为商品图
        .filter((u) => u && u.includes('360buyimg.com') && !/pcpubliccms/i.test(u) && !/blank|icon|logo|spacer|gif|1x1/i.test(u))
    );
    r.detailImages = uniq([...descImgs, ...r.detailImages]).slice(0, 10);
    // SKU 规格组：新版页 #choose-attrs，旧版页 #choose/#choose-color/#choose-version 等
    r.skus = buildSkus(
      document.querySelectorAll(
        '#choose-attrs .p-choose-type, #choose .p-choose-type, #choose-color, #choose-version, #choose-attr-1, #choose-attr-2'
      )
    );
    // 商品属性：cd.jd.com 描述接口已废弃（对第三方商品只返回页脚导航垃圾，2026-10-09 沙箱验证），
    // 改由后台直连移动版商品页解析（见 parseJdMobileAttrs）；这里只保留 PC 页 DOM 采集：
    // 「规格与包装」tab 内容点击后才渲染——程序化激活该 tab，等参数内容就绪（最多 4 秒）。
    if (!r.attributes.length) {
      // 「规格与包装」tab 的内容是点击后才异步渲染进 DOM 的：先程序化激活该 tab，再等参数内容就绪（最多 4 秒）
      try {
        const tabEl = [...document.querySelectorAll('.tab-main li, .tab-main div, [data-anchor]')].find(
          (el) =>
            /规格|参数/.test((el.textContent || '').trim()) &&
            /detail/i.test(el.getAttribute('data-anchor') || el.getAttribute('data-href') || el.getAttribute('href') || '')
        );
        if (tabEl && !/curr|active|current|on/i.test(String(tabEl.className || ''))) tabEl.click();
      } catch (e) {
        /* 找不到 tab 就按已渲染处理 */
      }
      for (let i = 0; i < 10; i++) {
        if (document.querySelector('#J-detail-pop .Ptable, .Ptable dt, .p-parameter-list li, .parameter2 li')) break;
        await sleep(400);
      }
      r.attributes = parseAttrs(
        [
          document.querySelector('#J-detail-pop'),
          document.querySelector('#J-detail'),
          document.querySelector('#J-detail-content'),
          document.querySelector('.detail-content'),
          document.querySelector('.describe'),
          document.querySelector('.Ptable'),
          document.querySelector('.p-parameter'),
          document.querySelector('.p-parameter-list'),
          document.querySelector('.parameter2'),
        ],
        true
      );
    }
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
        // 过滤明显的小图标（箭头/logo/角标）：已加载的图用真实尺寸判断，尺寸未知的保留
        .filter((i) => {
          const w = i.naturalWidth || 0;
          return !w || w >= 150;
        })
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
  // 兜底：属性仍为空时，在详情区（#J-detail）内扫「含 ≥2 个 dt」的 dl 参数块；
  // 必须在详情区内——全文档扫会把页脚导航 dl（购物指南/配送方式…）当属性
  if (!r.attributes.length) {
    const scope = document.querySelector('#J-detail') || document.querySelector('.detail') || document.body;
    const dls = [...scope.querySelectorAll('dl')].filter((dl) => dl.querySelectorAll('dt').length >= 2).slice(0, 30);
    r.attributes = parseAttrs(dls, false);
  }
  if (!r.coverUrl && r.detailImages.length) r.coverUrl = r.detailImages[0];
  return r;
}
