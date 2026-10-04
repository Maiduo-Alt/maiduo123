/**
 * 训练任务的剧本范围限定（方案 F6-03）。
 *
 * 带教下发任务时可以用三种方式圈定训练内容：
 *   - category：按剧本分类，`{ categories: ['售后', ...] }`
 *   - product：按关联商品，`{ productIds: [1, 2] }`（剧本关联到其中任一商品即算命中）
 *   - product_category：按**商品种类**（客户 2026-10-03），`{ categories: ['男装','女装'] }`——
 *     剧本只要关联了其中任一分类的商品即算命中，推送的问题也就围绕这些品类
 *   - scripts_products：**剧本 + 商品同时多选**（客户 2026-10-03），
 *     `{ scriptIds: [10, 11], productIds: [1, 2] }`——两个条件都要满足（哪一侧留空就等于该侧不限制）
 *   - scripts：指定剧本清单，`{ scriptIds: [10, 11] }`
 *   - all / 未配置具体值：不限制
 *
 * 抽成纯函数是为了让「范围到底有没有生效」可以被单测锁住，
 * 而不是只能靠人工开局去猜。
 */
export interface TaskScope {
  type?: string;
  value?: any;
}

export interface ScopeTargetScript {
  id: number;
  category?: string | null;
  productIds?: any;
  /** 剧本关联商品的分类（按商品种类限定范围时用；由调用方从商品表取好） */
  productCategories?: string[];
}

export function isScriptInTaskScope(script: ScopeTargetScript, scope?: TaskScope | null): boolean {
  if (!scope || !scope.type || scope.type === 'all') return true;
  const value = scope.value || {};

  if (scope.type === 'category') {
    const wanted = (Array.isArray(value.categories) ? value.categories : []).map(String);
    if (!wanted.length) return true;
    return wanted.includes(String(script.category ?? ''));
  }

  if (scope.type === 'product') {
    const wanted = (Array.isArray(value.productIds) ? value.productIds : []).map(Number).filter(Number.isFinite);
    if (!wanted.length) return true;
    const owned = (Array.isArray(script.productIds) ? script.productIds : []).map(Number).filter(Number.isFinite);
    return owned.some((id) => wanted.includes(id));
  }

  if (scope.type === 'product_category') {
    const wanted = (Array.isArray(value.categories) ? value.categories : []).map(String);
    if (!wanted.length) return true;
    const owned = (Array.isArray(script.productCategories) ? script.productCategories : []).map(String);
    return owned.some((name) => wanted.includes(name));
  }

  if (scope.type === 'scripts_products') {
    const wantedScripts = (Array.isArray(value.scriptIds) ? value.scriptIds : []).map(Number).filter(Number.isFinite);
    const wantedProducts = (Array.isArray(value.productIds) ? value.productIds : []).map(Number).filter(Number.isFinite);
    // 任一侧留空 = 该维度不限制；两侧都空 = 全放行
    if (wantedScripts.length && !wantedScripts.includes(Number(script.id))) return false;
    if (wantedProducts.length) {
      const owned = (Array.isArray(script.productIds) ? script.productIds : []).map(Number).filter(Number.isFinite);
      if (!owned.some((id) => wantedProducts.includes(id))) return false;
    }
    return true;
  }

  if (scope.type === 'scripts') {
    const wanted = (Array.isArray(value.scriptIds) ? value.scriptIds : []).map(Number).filter(Number.isFinite);
    if (!wanted.length) return true;
    return wanted.includes(Number(script.id));
  }

  return true;
}

/** 任务允许的难度档位；空数组表示不限制。 */
export function isLevelAllowedByTask(level: string, taskLevels?: any): boolean {
  const list = Array.isArray(taskLevels) ? taskLevels.map(String) : [];
  return list.length === 0 || list.includes(level);
}
