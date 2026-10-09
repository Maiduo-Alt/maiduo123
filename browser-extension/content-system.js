/**
 * 训练系统页面注入脚本：把插件暂存的采集结果写入页面 localStorage，
 * 并派发事件通知 React 应用读取（React 挂载可能早于本脚本执行，所以用事件兜底）。
 */
chrome.storage.local.get(['pendingQuickAdd', 'quickAddError'], (items) => {
  if (items.pendingQuickAdd) {
    try {
      window.localStorage.setItem('cs-training-quickadd', JSON.stringify(items.pendingQuickAdd));
    } catch {
      /* 存储不可用时忽略 */
    }
    chrome.storage.local.remove('pendingQuickAdd');
    window.dispatchEvent(new Event('cs-training-quickadd'));
  }
  if (items.quickAddError) {
    try {
      window.localStorage.setItem('cs-training-quickadd-error', String(items.quickAddError));
    } catch {
      /* 存储不可用时忽略 */
    }
    chrome.storage.local.remove('quickAddError');
    window.dispatchEvent(new Event('cs-training-quickadd'));
  }
  // 清理地址栏里的 quickadd 标记
  if (window.location.search.includes('quickadd=1')) {
    try {
      const u = new URL(window.location.href);
      u.searchParams.delete('quickadd');
      window.history.replaceState(null, '', u.pathname + u.search + u.hash);
    } catch {
      /* 忽略 */
    }
  }
});
