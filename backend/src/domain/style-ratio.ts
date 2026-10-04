/**
 * 沟通风格占比分配（方案 3.7.4 / 4.6）。
 * 规则：占比总和不超 100%；未填写的行按剩余比例平均分配；
 * 按占比加权分配并保证小样本下的均匀性（最大余数法 + 随机打散）。
 */
export interface RatioInput {
  code: string;
  ratio: number | null | undefined;
}

export function normalizeRatios(inputs: RatioInput[]): { code: string; ratio: number }[] {
  const filled = inputs.filter((i) => typeof i.ratio === 'number' && i.ratio > 0);
  const blanks = inputs.filter((i) => !(typeof i.ratio === 'number' && i.ratio > 0));
  const sumFilled = filled.reduce((a, b) => a + (b.ratio as number), 0);
  if (sumFilled > 100) {
    throw new Error(`聊天占比总和超过 100%（当前 ${sumFilled}%），请调整后保存`);
  }
  const remaining = 100 - sumFilled;
  const per = blanks.length ? remaining / blanks.length : 0;
  return inputs.map((i) => ({
    code: i.code,
    ratio: typeof i.ratio === 'number' && i.ratio > 0 ? i.ratio : per,
  }));
}

/** 按占比计算 count 个名额的整数分配（最大余数法，保证总量精确且分布均匀）。 */
export function allocateCounts(ratios: { code: string; ratio: number }[], count: number): Record<string, number> {
  const total = ratios.reduce((a, b) => a + b.ratio, 0) || 1;
  const exact = ratios.map((r) => ({ code: r.code, exact: (r.ratio / total) * count }));
  const result: Record<string, number> = {};
  let assigned = 0;
  for (const e of exact) {
    const floor = Math.floor(e.exact);
    result[e.code] = floor;
    assigned += floor;
  }
  const remainders = exact
    .map((e) => ({ code: e.code, rem: e.exact - Math.floor(e.exact) }))
    .sort((a, b) => b.rem - a.rem);
  let i = 0;
  while (assigned < count && remainders.length) {
    result[remainders[i % remainders.length].code] += 1;
    assigned += 1;
    i += 1;
  }
  return result;
}

/** 生成风格分配序列（长度 = count），随机打散保证批次内分布接近理论值。 */
export function allocateStyles(
  ratios: { code: string; ratio: number }[],
  count: number,
  rng: () => number
): string[] {
  const counts = allocateCounts(ratios, count);
  const list: string[] = [];
  for (const r of ratios) {
    const c = counts[r.code] || 0;
    for (let i = 0; i < c; i += 1) list.push(r.code);
  }
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}
