/**
 * L3 语义判定测试报告（2026-11-20 23:24）线上复现的发货时效误判回归。
 *
 * 线上实测（attempt 315 / session 2984）：
 *   问题：「那一般什么时候可以发出呢？」
 *   回复：「一般当天就安排发出，最晚不超过48小时，您放心～」
 *   判定：pass=false / off-topic / 尚未明确发货时效（错误）
 *
 * 根因：线上引擎 automatic-reply.ts 的 SHIP_DURATION_RE 只认「阿拉伯数字+单位+发货动作」，
 *   - 「当天就安排发出」——「当天」是中文相对日，非 \d+，不匹配；
 *   - 「最晚不超过48小时」——数字后没有发货动作词（句子到此结束），不匹配。
 *   两类推断式时效表达都得不到证据 → unanswered → 判未确认解决、扣 17.5 分。
 *
 * 本测试先红后绿：修复前下表正例全部失败，负例全部通过；修复后应全绿。
 */
import { assessAutomaticReply } from '../../src/domain/automatic-reply';

const Q = '那一般什么时候可以发出呢？';
const assess = (reply: string, question = Q) =>
  assessAutomaticReply({ question, reply, keyPoints: [], buyerText: question }, 2);

describe('L3 发货时效推断表达：中文相对日 / 时长上限', () => {
  // ---- 正例：语义正确，应判通过 ----
  it('L3 原句：当天就安排发出 + 最晚不超过48小时', () => {
    const r = assess('一般当天就安排发出，最晚不超过48小时，您放心～');
    expect(r.intent).toBe('shipping-time');
    expect(r.pass).toBe(true);
    expect(r.status).toBe('resolved');
    expect(r.evidence && r.evidence.length).toBeGreaterThan(0);
  });

  it('中文相对日+动作：当天/今天/当日/次日就发出', () => {
    expect(assess('亲，当天就给您发出哦').pass).toBe(true);
    expect(assess('今天安排发货，请您放心').pass).toBe(true);
    expect(assess('当日出库，最快次日就发出了').pass).toBe(true);
  });

  it('时长上限式：最晚不超过48小时 / 最多3天 / 至多2天', () => {
    expect(assess('亲，最晚不超过48小时就给您发出').pass).toBe(true);
    expect(assess('亲，最多3天就给您发出').pass).toBe(true);
    expect(assess('至多2天内安排出库').pass).toBe(true);
  });

  it('孤立上限式时长（无发货动作）不放行——与跨句不误吞同口径', () => {
    expect(assess('最晚不超过48小时。').pass).toBe(false);
  });

  it('中英混合：当天安排发出，48小时内也能到', () => {
    expect(assess('一般当天安排发出，48小时内就能到您手上').pass).toBe(true);
  });

  it('带追问前缀的自然问句仍能判通过', () => {
    const q = '对了，我还想顺便问一下：那一般什么时候可以发出呢？';
    expect(assess('一般当天就安排发出，最晚不超过48小时，您放心～', q).pass).toBe(true);
  });

  // ---- 负例：无实质时效 / 否定 / 矛盾 / 答非所问，应拦截 ----
  it('仅相对日但无发货动作，不得放行', () => {
    expect(assess('当天给您处理一下').pass).toBe(false);
    expect(assess('今天就先这样').pass).toBe(false);
  });

  it('仅时长上限但指向到货，不得当作发货时效', () => {
    expect(assess('最晚不超过48小时就能收到').pass).toBe(false);
  });

  it('否定 / 不确定类推断仍被拦截', () => {
    expect(assess('当天不一定能发出').pass).toBe(false);
    expect(assess('最晚不超过48小时，但不敢保证').pass).toBe(false);
    expect(assess('具体看仓库安排').pass).toBe(false);
    expect(assess('尽快帮您核实').pass).toBe(false);
  });

  it('互相矛盾的发货时效仍判未解决', () => {
    expect(assess('当天发出，也可能会一周后发出').pass).toBe(false);
  });

  it('跨句不误吞：上一句时长不能为下一句发货作证', () => {
    expect(assess('最晚不超过48小时。我们会安排发货。').pass).toBe(false);
  });

  it('只答发货时效不能替代到货时效（方向不回归）', () => {
    const r = assess('一般当天就安排发出，最晚不超过48小时', '发出后多久能收到？');
    expect(r.pass).toBe(false);
  });
});
