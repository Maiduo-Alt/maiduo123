/** 极简 CSV 解析：支持双引号包裹、引号内逗号与 "" 转义（导入商品 / 案例共用）。 */
export function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (ch === '"') inQuotes = false;
      else current += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      result.push(current);
      current = '';
    } else current += ch;
  }
  result.push(current);
  return result;
}

/** 整段 CSV 文本 → 二维数组；跳过空行，并去掉 UTF-8 BOM。 */
export function parseCsv(text: string): string[][] {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => parseCsvLine(line));
}
