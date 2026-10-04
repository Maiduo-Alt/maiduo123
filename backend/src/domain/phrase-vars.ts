/**
 * 快捷短语的变量口径（方案 3.8 F8-08 / 数据字典 phrase.variables）。
 *
 * 短语内容里用 `{变量名}` 声明占位符，接待页插入时会按当前会话替换
 * （商品名、价格、订单号）。这里把「从内容抽取变量」做成纯函数，
 * 保证内容库、维护页与接待页三处口径一致。
 */
const PLACEHOLDER = /\{([^{}\s]{1,32})\}/g;

/** 抽取内容里的 {变量}，按出现顺序去重。 */
export function extractVariables(content: string): string[] {
  if (!content) return [];
  const found: string[] = [];
  PLACEHOLDER.lastIndex = 0;
  let match = PLACEHOLDER.exec(content);
  while (match) {
    if (!found.includes(match[1])) found.push(match[1]);
    match = PLACEHOLDER.exec(content);
  }
  return found;
}
