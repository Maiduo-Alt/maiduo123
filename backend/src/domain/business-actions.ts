/**
 * 订单卡片上的「平台侧操作」在训练环境里的落地方式（客户 2026-10-03 追加口径：
 * 「点击后记为一次业务动作」）。
 *
 * 真实抖店工作台里，催付 / 改价 / 去发货 这些是平台写操作，点了就真的改了平台数据。
 * 训练环境不接平台，所以改成：
 *   ① 点一下 = 给买家发一句对应的**标准话术**（对话里看得见，计入这一轮的回复）；
 *   ② 同时往 `session_actions` 写一条**业务动作记录**，复盘时能看到「这次接待点过哪些动作」；
 *   ③ 业务动作话术**不参与「无效 / 敷衍回复」判定**——连点两次催付是正常操作，不该被判敷衍。
 *
 * 动作按订单状态（三张参考图）分组：待支付 / 待发货 / 已发货 各有一套按钮。
 */
import { ORDER_STAGE_TEXT, OrderStage } from './order';

export interface BusinessActionDef {
  code: string;
  /** 按钮文案（与参考图一致） */
  name: string;
  /** 哪些订单状态下会出现这个按钮 */
  stages: OrderStage[];
  /** 点下去发给买家的标准话术，支持 {商品名} / {订单号} / {收货信息} / {快递} / {物流单号} */
  phrase: string;
  /** 悬停提示：这个动作在真实工作台里做什么 */
  note: string;
}

export const BUSINESS_ACTIONS: BusinessActionDef[] = [
  {
    code: 'verify_address',
    name: '核对地址',
    stages: ['unpaid', 'unshipped', 'shipped'],
    phrase: '亲，麻烦您核对一下收货信息：{收货信息}，如果地址有变，我这边马上帮您登记修改～',
    note: '和买家核对收货地址',
  },
  {
    code: 'urge_pay',
    name: '催付',
    stages: ['unpaid'],
    phrase: '亲，您的订单还没有付款哦，库存我帮您留着了，付款后我们会尽快安排发货～',
    note: '提醒买家尽快付款',
  },
  {
    code: 'change_price',
    name: '改价',
    stages: ['unpaid'],
    phrase: '亲，价格已经帮您申请好了，您刷新一下订单就能看到新的金额，记得在有效期内付款哦～',
    note: '按活动价改价（训练环境只发话术）',
  },
  {
    code: 'change_address',
    name: '改地址',
    stages: ['unpaid', 'unshipped', 'shipped'],
    phrase: '亲，地址修改需要您把新的收货信息发给我，发出前都可以改，我这边先帮您登记～',
    note: '登记收货地址修改',
  },
  {
    code: 'ship_goods',
    name: '去发货',
    stages: ['unshipped'],
    phrase: '亲，您的订单我已经安排进发货流程了，出库后第一时间把物流信息同步给您～',
    note: '把订单推进发货流程',
  },
  {
    code: 'ship_negotiate',
    name: '发货协商',
    stages: ['unshipped'],
    phrase: '亲，如果需要延迟发货或者指定到货时间，跟我说一声，我帮您和仓库协调～',
    note: '和买家协商发货时间',
  },
  {
    code: 'after_sale_proxy',
    name: '代客发起售后',
    stages: ['unshipped', 'shipped'],
    phrase: '亲，售后我帮您登记好了，处理进度会第一时间同步给您，您不用再单独申请啦～',
    note: '替买家发起售后',
  },
  {
    code: 'after_sale_card',
    name: '发售后卡',
    stages: ['unshipped'],
    phrase: '亲，我给您发一张售后保障卡，签收后 7 天内有问题都可以直接找我，我帮您处理～',
    note: '发售后保障卡',
  },
  {
    code: 'logistics_card',
    name: '发物流卡',
    stages: ['shipped'],
    phrase: '亲，您的包裹由{快递}配送，单号 {物流单号}，您可以在订单里查看实时进度～',
    note: '给买家发物流卡片',
  },
];

export function findBusinessAction(code: string): BusinessActionDef | undefined {
  return BUSINESS_ACTIONS.find((item) => item.code === code);
}

/** 某个订单状态下卡片上会出现的按钮（顺序与参考图一致） */
export function actionsForStage(stage: OrderStage): BusinessActionDef[] {
  return BUSINESS_ACTIONS.filter((item) => item.stages.includes(stage));
}

/** 话术里的变量替换；没给值的变量留成中性说法，不出现 `{xxx}` 这种占位符。 */
export function renderActionPhrase(
  action: BusinessActionDef,
  vars: { productTitle?: string | null; orderNo?: string | null; receiver?: string | null; address?: string | null; trackingCompany?: string | null; trackingNo?: string | null } = {}
): string {
  const address = vars.address ? `${vars.receiver || '买家'}，${vars.address}` : '您下单时填写的地址';
  return action.phrase
    .replace(/\{商品名\}/g, vars.productTitle || '这件商品')
    .replace(/\{订单号\}/g, vars.orderNo || '您的订单')
    .replace(/\{收货信息\}/g, address)
    .replace(/\{快递\}/g, vars.trackingCompany || '快递')
    .replace(/\{物流单号\}/g, vars.trackingNo || '以订单页为准');
}

/** 「催付」这类动作只在这些状态下可用；用于接口层的兜底校验与报错文案。 */
export function actionStageHint(action: BusinessActionDef): string {
  return action.stages.map((stage) => ORDER_STAGE_TEXT[stage]).join(' / ');
}
