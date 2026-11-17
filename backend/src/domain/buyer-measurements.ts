/** 每个模拟会话独立生成稳定的身高、体重；优先沿用买家已经说过的数据。 */
export function buyerMeasurements(sessionId: number, buyerTexts: string[]): { heightCm: number; weightJin: number } {
  const text = buyerTexts.join(' ');
  const pair = text.match(/(?<!\d)(1[4-9]\d|200)\s*[/／]\s*(\d{2,3})(?!\d)\s*(公斤|kg|斤)?/iu);
  const height = text.match(/(?:身高\s*)?(\d{2,3})\s*(?:厘米|cm)/iu) || text.match(/身高\s*(\d{2,3})(?!\d)/u);
  const meters = text.match(/(?:身高\s*)?1\s*米\s*(\d{2})(?!\d)/u);
  const weight = text.match(/(?:体重\s*)?(\d{2,3})\s*(斤|公斤|kg)/iu) || text.match(/体重\s*(\d{2,3})(?!\d)/u);
  const pairs = [
    { heightCm: 156, weightJin: 96 }, { heightCm: 160, weightJin: 104 },
    { heightCm: 164, weightJin: 112 }, { heightCm: 168, weightJin: 120 },
    { heightCm: 172, weightJin: 128 }, { heightCm: 162, weightJin: 100 },
    { heightCm: 166, weightJin: 108 }, { heightCm: 170, weightJin: 116 },
  ];
  const generated = pairs[Math.abs(sessionId) % pairs.length];
  const parsedHeight = pair ? Number(pair[1]) : height ? Number(height[1]) : meters ? 100 + Number(meters[1]) : undefined;
  const parsedWeight = pair ? Number(pair[2]) * (/公斤|kg/iu.test(pair[3] || '') ? 2 : 1) : weight ? Number(weight[1]) * (/公斤|kg/iu.test(weight[2] || '') ? 2 : 1) : undefined;
  return { heightCm: parsedHeight ?? generated.heightCm, weightJin: parsedWeight ?? generated.weightJin };
}
