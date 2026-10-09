/** 京东新版商品页数据捕获（2026-10-09 v1.3.0）：
 * 新版 item.jd.com 是完全重构的页面（旧选择器 #J-detail/.Ptable/#spec-img 全部不存在），
 * 但页面加载时会调用 api.m.jd.com 的 pc_detailpage_wareBusiness 接口，
 * 其响应包含完整结构化商品数据（标题/价格/主图/画廊/规格组/商品属性，WebBridge 实地验证）。
 * 本脚本在 document_start 挂钩 fetch/XHR，把该接口响应存到 window.__jdWareBusiness；
 * 与点击图标时注入的提取函数共享同一隔离世界的 window。
 */
(() => {
  if (window.__jdCaptureHooked) return;
  window.__jdCaptureHooked = true;
  const grab = (text) => {
    try {
      const j = JSON.parse(text);
      if (j && j.result && (j.result.productAttributeVO || j.result.colorSizeVO || j.result.mainImageVO)) {
        window.__jdWareBusiness = j;
      }
    } catch (e) {
      /* 非 JSON 响应忽略 */
    }
  };
  // fetch 挂钩
  try {
    const origFetch = window.fetch;
    window.fetch = function (...args) {
      const url = String((args[0] && args[0].url) || args[0] || '');
      return origFetch.apply(this, args).then((res) => {
        if (res && /pc_detailpage_wareBusiness/.test(url) && res.clone) {
          res.clone().text().then(grab).catch(() => {});
        }
        return res;
      });
    };
  } catch (e) {
    /* ignore */
  }
  // XHR 挂钩
  try {
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__jdCaptureUrl = String(url || '');
      return origOpen.call(this, method, url, ...rest);
    };
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...args) {
      if (/pc_detailpage_wareBusiness/.test(this.__jdCaptureUrl || '')) {
        this.addEventListener('load', function () {
          try {
            grab(this.responseText);
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
})();
