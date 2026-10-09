/** 京东新版商品页数据捕获（2026-10-09 v1.3.1）：
 * 新版 item.jd.com 全面重构，页面数据来自 api.m.jd.com 的 pc_detailpage_wareBusiness 接口。
 * 本脚本在 document_start 挂钩 fetch / XHR / script 插入三种通道捕获响应，
 * 数据经 localStorage（'cs-training-jd-capture'）传递——localStorage 不按 JS 世界隔离，
 * 点击图标时注入的提取函数（隔离世界）和外部验证都能读到；window.__jdWareBusiness 作为同世界快速通道。
 */
(() => {
  if (window.__jdCaptureHooked) return;
  window.__jdCaptureHooked = true;
  const KEY = 'cs-training-jd-capture';
  const save = (j) => {
    try {
      if (j && j.result && (j.result.productAttributeVO || j.result.colorSizeVO || j.result.mainImageVO)) {
        window.__jdWareBusiness = j;
        try {
          localStorage.setItem(KEY, JSON.stringify({ capturedAt: Date.now(), data: j }));
        } catch (e) {
          /* 存储超限时仅保留 window 通道 */
        }
      }
    } catch (e) {
      /* ignore */
    }
  };
  const grabText = (text) => {
    try {
      save(JSON.parse(text));
    } catch (e) {
      /* 非 JSON（如 JSONP 回调包裹）忽略 */
    }
  };
  const API_RE = /pc_detailpage_wareBusiness/;
  // 1) fetch 挂钩
  try {
    const origFetch = window.fetch;
    window.fetch = function (...args) {
      const url = String((args[0] && args[0].url) || args[0] || '');
      return origFetch.apply(this, args).then((res) => {
        if (res && API_RE.test(url) && res.clone) {
          res.clone().text().then(grabText).catch(() => {});
        }
        return res;
      });
    };
  } catch (e) {
    /* ignore */
  }
  // 2) XHR 挂钩
  try {
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__jdCaptureUrl = String(url || '');
      return origOpen.call(this, method, url, ...rest);
    };
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...args) {
      if (API_RE.test(this.__jdCaptureUrl || '')) {
        this.addEventListener('load', function () {
          try {
            grabText(this.responseText);
          } catch (e) {
            /* ignore */
          }
        });
      }
      return origSend.apply(this, args);
    };
  } catch (e) {
    /* ignore */
  }
  // 3) JSONP（script 标签插入）挂钩：页面若用 JSONP 拿数据，抓到 script URL 后自己 fetch 一份
  //    （api.m.jd.com 对该接口开启了 CORS，参考页面自身 XHR 成功）
  try {
    const hookAppend = (orig) =>
      function (node, ...rest) {
        try {
          const src = node && node.src ? String(node.src) : '';
          if (API_RE.test(src)) {
            fetch(src, { credentials: 'include' }).then((r) => r.text()).then(grabText).catch(() => {});
          }
        } catch (e) {
          /* ignore */
        }
        return orig.call(this, node, ...rest);
      };
    Element.prototype.appendChild = hookAppend(Element.prototype.appendChild);
    Element.prototype.insertBefore = hookAppend(Element.prototype.insertBefore);
  } catch (e) {
    /* ignore */
  }
})();
