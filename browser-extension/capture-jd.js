/** 京东新版商品页数据捕获（2026-10-09 v1.3.2）：
 * 关键修复：内容脚本运行在扩展「隔离世界」，直接挂钩 window.fetch/XHR 拦截不到页面主世界的请求。
 * 本脚本把挂钩代码以页内 <script> 注入主世界执行（京东页 CSP 实测不拦截内联脚本），
 * 捕获结果写 localStorage（'cs-training-jd-capture'，跨世界可读）+ window 快通道。
 */
(() => {
  const PAGE_HOOK = `(() => {
    if (window.__jdCaptureHooked) return;
    window.__jdCaptureHooked = true;
    try { localStorage.setItem('cs-training-jd-hook', String(Date.now())); } catch (e) {}
    const KEY = 'cs-training-jd-capture';
    const save = (j) => {
      try {
        // 兼容两种形态：裸 result 对象 或 {result: {...}} 包装（抓包实测两种都出现过）
        const rr = j && j.result && typeof j.result === 'object' ? j.result : j;
        if (rr && (rr.productAttributeVO || rr.colorSizeVO || rr.mainImageVO)) {
          const wrapped = { result: rr };
          window.__jdWareBusiness = wrapped;
          try {
            localStorage.setItem(KEY, JSON.stringify({ capturedAt: Date.now(), data: wrapped }));
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
    // 1) fetch 挂钩（页面主世界的 fetch，京东自己也包了一层，注意保留其返回值行为）
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
    // 3) JSONP（script 标签插入）挂钩：抓到 script URL 后自己 fetch 一份
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
  })();`;

  const inject = () => {
    try {
      const s = document.createElement('script');
      s.textContent = PAGE_HOOK;
      (document.documentElement || document.head || document.body).appendChild(s);
      s.remove();
    } catch (e) {
      /* 注入失败（如极端 CSP）静默：点击采集时走 DOM 兜底并给出提示 */
    }
  };
  // document_start 时 documentElement 可能尚不存在，挂 MutationObserver 等 <html> 出现即注入
  if (document.documentElement) inject();
  else {
    const mo = new MutationObserver(() => {
      if (document.documentElement) {
        mo.disconnect();
        inject();
      }
    });
    mo.observe(document, { childList: true });
  }
})();
