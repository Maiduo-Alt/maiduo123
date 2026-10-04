import {
  APPAREL_CATEGORIES,
  isProductCompatibleWithQuestions,
  isQuestionCompatibleWithCategory,
} from '../../src/domain/product-consistency';
import { ORDER_AFTERSALE_QUESTIONS, PRESALE_PRODUCT_QUESTIONS, PRODUCTS, QAS } from '../../src/db/seed-content';

/**
 * 客户 2026-10-03：「不可出现商品问题和实际商品需求进行的行为不一致的情况」。
 * 这一组用例把这条要求锁死：既验证判定函数，也**全量扫描内置内容库与商品库**。
 */
describe('商品与问题的一致性（客户 2026-10-03）', () => {
  const ALL_CATEGORIES = [...new Set(PRODUCTS.map((p) => p.category))];

  it('服饰专属的问题只能配服饰类商品，配数码/食品就不一致', () => {
    expect(isQuestionCompatibleWithCategory('我 165 体重 50 公斤，穿什么码合适？', '女装')).toBe(true);
    expect(isQuestionCompatibleWithCategory('我 165 体重 50 公斤，穿什么码合适？', '男装')).toBe(true);
    expect(isQuestionCompatibleWithCategory('我 165 体重 50 公斤，穿什么码合适？', '数码')).toBe(false);
    expect(isQuestionCompatibleWithCategory('面料会不会起球呀？', '食品')).toBe(false);
    expect(isQuestionCompatibleWithCategory('鞋码偏大还是偏小？', '女装')).toBe(false);
    expect(isQuestionCompatibleWithCategory('鞋码偏大还是偏小？', '鞋靴')).toBe(true);
    expect(isQuestionCompatibleWithCategory('这个保质期到什么时候？', '食品')).toBe(true);
    expect(isQuestionCompatibleWithCategory('这个保质期到什么时候？', '女装')).toBe(false);
  });

  it('与品类无关的问题（价格/优惠/物流/发票/订单）任何商品都能问', () => {
    const neutral = [
      '这款现在有活动吗，和会员价能一起用吗？',
      '可以开发票吗？',
      '大概什么时候能到呀？',
      '我地址填错了，能帮我改一下收货地址吗？',
      '都两天了怎么还没发货，能帮我催一下吗？',
    ];
    neutral.forEach((question) => {
      ALL_CATEGORIES.forEach((category) => {
        expect(isQuestionCompatibleWithCategory(question, category)).toBe(true);
      });
    });
  });

  /**
   * 不变量 1：**补进来的混合题库**（售前商品咨询 + 买完商品后的订单类问题）
   * 必须与所有品类兼容——它们会出现在任何品类的会话里。
   */
  it('混合题库（C14）与全部商品品类都兼容', () => {
    const pool = [...ORDER_AFTERSALE_QUESTIONS, ...PRESALE_PRODUCT_QUESTIONS];
    const conflicts: string[] = [];
    pool.forEach((item) => {
      ALL_CATEGORIES.forEach((category) => {
        if (!isQuestionCompatibleWithCategory(item.question, category)) {
          conflicts.push(`${item.question} × ${category}`);
        }
      });
    });
    expect(conflicts).toEqual([]);
  });

  /**
   * 不变量 2：**每条内置咨询内容都至少能匹配一个商品品类**。
   * 内容里带服饰词的，必须能落到服饰类商品上；否则 seed 会给它配到不合适的商品。
   */
  it('内置内容库里的每条内容都能找到兼容的商品品类', () => {
    const unmatched: string[] = [];
    QAS.forEach((qa) => {
      const questions = (qa.question_list as unknown as string[]) || [];
      const ok = ALL_CATEGORIES.some((category) => isProductCompatibleWithQuestions(category, questions));
      if (!ok) unmatched.push(`${qa.template_name}：${questions.join(' / ')}`);
    });
    expect(unmatched).toEqual([]);
  });

  it('服饰类词表覆盖男女装（剧本当前只挂这两类商品）', () => {
    expect(APPAREL_CATEGORIES).toEqual(expect.arrayContaining(['女装', '男装']));
  });
});
