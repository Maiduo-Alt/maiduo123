let seq = 0;

/** 生成业务编号，形如 AT20261001-0001。 */
export function nextNo(prefix: string, date = new Date()): string {
  seq = (seq + 1) % 10000;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const rand = String(Math.floor(Math.random() * 9000) + 1000);
  return `${prefix}${y}${m}${d}-${rand}`;
}
