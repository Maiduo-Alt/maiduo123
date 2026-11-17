/** 判断一条发货时效答复是否覆盖目标问题明确提出的条件。无条件问法沿用当前对话上下文。 */
export function shippingConditionsCompatible(sourceQuestion: string, reply: string, targetQuestion: string): boolean {
  const groups: RegExp[][] = [
    [/现货/u, /预售|预定|预订/u],
    [/(?<!非)节假日|(?<!非)节日|(?<!非)假期|春节|国庆|五一/u, /非节假日|非节日|非假期/u],
    [/周末|星期六|星期日|星期天/u, /(?<!非)工作日|周一到周五/u, /非工作日/u],
    [/付款后|支付后/u, /付款前|支付前|未付款/u],
  ];
  const source = `${sourceQuestion} ${reply}`;
  return groups.every((group) => {
    const targetMatches = group.map((pattern) => pattern.test(targetQuestion));
    if (!targetMatches.some(Boolean)) return true;
    const sourceMatches = group.map((pattern) => pattern.test(source));
    return targetMatches.filter(Boolean).length === 1 && sourceMatches.filter(Boolean).length === 1 &&
      targetMatches.every((present, index) => present === sourceMatches[index]);
  });
}
