/** 手机号脱敏：保留前 3 位与后 4 位（方案 5.11 安全要求）。 */
export function maskMobile(mobile: string | null | undefined): string | null {
  const value = String(mobile ?? '').trim();
  if (!value) return null;
  if (value.length <= 4) return '****';
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}
