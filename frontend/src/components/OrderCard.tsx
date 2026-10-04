import { Button, Divider, Space, Tag, Tooltip, Typography } from 'antd';
import {
  CopyOutlined,
  EnvironmentOutlined,
  FileTextOutlined,
  FormOutlined,
  MoreOutlined,
  ShoppingOutlined,
  UpOutlined,
} from '@ant-design/icons';

/**
 * 抖店工作台的订单卡片（客户 2026-10-03 提供三张参考图）。
 *
 * 三态字段与操作不同：
 * - 待支付：订单金额 / 下单时间，操作「核对地址、催付、改价、改地址」；
 * - 待发货：实付金额 / 付款时间 / 承诺发货，操作「核对地址、改地址、去发货、发货协商」；
 * - 已发货：实付金额 / 付款时间 / 物流信息（快递+单号+签收）/ 发货时间与方式，操作「发物流卡、改地址」。
 *
 * 训练环境里：
 * - 每行右侧的「发送」把该行内容插入输入框（真行为，由学员自己发）；
 * - 平台侧操作（催付 / 改价 / 去发货…）点击后**记为一次业务动作**——由上层调接口，
 *   落一条动作记录 + 给买家发一句标准话术（不假装能改平台数据，但动作真的被记下来）。
 */
export interface OrderView {
  orderNo: string;
  stage: 'unpaid' | 'unshipped' | 'shipped';
  statusText: string;
  quantity: number;
  spec: string;
  amount: number;
  placedAt: string;
  paidAt: string | null;
  promisedShipAt: string | null;
  shippedAt: string | null;
  shippingMethod: string | null;
  trackingCompany: string | null;
  trackingNo: string | null;
  signedAt: string | null;
  receiver: string;
  address: string;
}

interface Props {
  order: OrderView;
  product?: { title?: string; productNo?: string; price?: number | string; coverUrl?: string } | null;
  /** 把某一行内容插入聊天输入框 */
  onSend?: (text: string) => void;
  /**
   * 客户 2026-10-03：平台侧操作「点击后记为一次业务动作」——由上层调接口，
   * 训练环境里会落一条动作记录 + 给买家发一句标准话术（不接平台写操作）。
   */
  onAction?: (code: string, name: string) => void;
  /** 动作请求进行中：避免连点重复记录 */
  actionPending?: boolean;
}

const STAGE_COLOR: Record<string, string> = { unpaid: 'orange', unshipped: 'blue', shipped: 'green' };

/** 参考图里的时间戳格式：2026/10/03 12:39:28（月/日补零） */
const timeText = (value: string | null) => {
  if (!value) return '—';
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const relativeToNow = (value: string | null) => {
  if (!value) return '';
  const diff = Date.parse(value) - Date.now();
  if (diff <= 0) return '已到期';
  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  return `${Math.floor(hours / 24)}天${hours % 24}小时${minutes}分内发货`;
};

/** 一行「标签 + 值 +（可选）发送按钮」 */
function Row({ label, children, onSend }: { label: string; children: any; onSend?: () => void }) {
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 12, lineHeight: '22px', marginTop: 6 }}>
      <span style={{ color: '#8c8c8c', flex: 'none', width: 56 }}>{label}</span>
      <span style={{ flex: 1, minWidth: 0, color: '#262626', wordBreak: 'break-all' }}>{children}</span>
      {onSend ? (
        <Typography.Link style={{ flex: 'none', fontSize: 12 }} onClick={onSend}>
          发送
        </Typography.Link>
      ) : null}
    </div>
  );
}

/** 平台侧动作按钮：点了记一次业务动作（不再是死按钮）。 */
function ActionButton({
  code,
  name,
  note,
  onAction,
  pending,
}: {
  code: string;
  name: string;
  note: string;
  onAction?: (code: string, name: string) => void;
  pending?: boolean;
}) {
  return (
    <Tooltip title={`${note}（训练环境不接平台写操作，点击记为一次业务动作并发标准话术）`}>
      {/* autoInsertSpace=false：AntD 默认会在两个汉字之间插一个空格（「催 付」），参考图里是没有的 */}
      <Button
        size="small"
        autoInsertSpace={false}
        disabled={!onAction || pending}
        onClick={() => onAction?.(code, name)}
      >
        {name}
      </Button>
    </Tooltip>
  );
}

export default function OrderCard({ order, product, onSend, onAction, actionPending }: Props) {
  const isUnpaid = order.stage === 'unpaid';
  const isShipped = order.stage === 'shipped';
  const title = product?.title || '关联商品';
  const spec = order.spec;

  return (
    <div className="order-card">
      {/* 状态标签 + 右上角图标组（参考图：备注 / 详情 / 更多 / 折叠） */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Tag color={STAGE_COLOR[order.stage]} style={{ marginInlineEnd: 0 }}>
          {order.statusText}
        </Tag>
        {order.stage === 'unshipped' ? <Tag style={{ marginInlineEnd: 0 }}>已改价</Tag> : null}
        {isShipped ? <Tag style={{ marginInlineEnd: 0 }}>承诺送达</Tag> : null}
        {isShipped ? <Tag style={{ marginInlineEnd: 0 }}>4PL</Tag> : null}
        <span style={{ flex: 1 }} />
        <Tooltip title="备注（训练环境暂未开放）">
          <Button type="text" size="small" icon={<FormOutlined />} disabled />
        </Tooltip>
        <Tooltip title="订单详情（训练环境暂未开放）">
          <Button type="text" size="small" icon={<FileTextOutlined />} disabled />
        </Tooltip>
        <Tooltip title="更多（训练环境暂未开放）">
          <Button type="text" size="small" icon={<MoreOutlined />} disabled />
        </Tooltip>
        <Button type="text" size="small" icon={<UpOutlined />} onClick={() => undefined} />
      </div>

      {/* 订单号 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
        <span style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>{order.orderNo}</span>
        <CopyOutlined
          style={{ color: '#bfbfbf', fontSize: 12, cursor: 'pointer' }}
          onClick={() => onSend?.(`订单号：${order.orderNo}`)}
        />
      </div>

      {/* 商品：缩略图 + 标题 + [N件] + 标签行 + 规格 */}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <div className="order-thumb">
          {product?.coverUrl ? <img src={product.coverUrl} alt="" /> : <ShoppingOutlined />}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, lineHeight: '18px' }}>
            {title} <span style={{ color: '#8c8c8c' }}>[{order.quantity}件]</span>
          </div>
          <div style={{ marginTop: 4 }}>
            <Tag style={{ marginInlineEnd: 4 }}>源头好货 ›</Tag>
            <Tag style={{ marginInlineEnd: 4 }}>7天 ›</Tag>
            <Tag style={{ marginInlineEnd: 4 }}>极速退 ›</Tag>
            <Tag>+1</Tag>
          </div>
          <Row label="规格" onSend={() => onSend?.(`规格：${spec}`)}>
            {spec}
          </Row>
          {/* 参考图 2 / 3：售后的两个入口就放在规格下面，而不是压到按钮行 */}
          {order.stage !== 'unpaid' ? (
            <Space size={6} style={{ marginTop: 8 }}>
              <ActionButton
                code="after_sale_proxy"
                name="代客发起售后"
                note="替买家登记售后"
                onAction={onAction}
                pending={actionPending}
              />
              {order.stage === 'unshipped' ? (
                <ActionButton
                  code="after_sale_card"
                  name="发售后卡"
                  note="已付款未发货时给买家发售后保障卡"
                  onAction={onAction}
                  pending={actionPending}
                />
              ) : null}
            </Space>
          ) : null}
        </div>
      </div>

      <Divider style={{ margin: '10px 0' }} />

      {/* 金额：待支付看订单金额，其余看实付金额 */}
      <Row label={isUnpaid ? '订单金额' : '实付金额'}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>¥{Number(order.amount).toFixed(2)}</span>
        <span style={{ color: '#8c8c8c' }}>（含运费 ¥0.00）</span>
        {isUnpaid ? null : <span style={{ color: '#8c8c8c' }}> 优惠 ¥{Math.min(998, Math.round(order.amount * 0.3)).toFixed(2)}</span>}
      </Row>

      <Row label="付款时间">
        {isUnpaid ? `下单: ${timeText(order.placedAt)}` : `${timeText(order.paidAt)}（抖音支付）`}
      </Row>

      {order.stage === 'unshipped' ? (
        <Row label="承诺发货" onSend={() => onSend?.(`亲，您的订单我们会在 48 小时内为您发出～`)}>
          {relativeToNow(order.promisedShipAt)}
        </Row>
      ) : null}

      {isShipped ? (
        <>
          <Row label="承诺送达">
            {timeText(order.promisedShipAt || order.shippedAt)} 前
          </Row>
          <Row label="发货方式">{order.shippingMethod || '现货仓发货'}</Row>
          <Row label="物流信息" onSend={() => onSend?.(`亲，您的包裹由${order.trackingCompany}配送，单号 ${order.trackingNo}，请注意查收～`)}>
            {order.trackingCompany} {order.trackingNo}
            <div style={{ color: '#8c8c8c' }}>
              <Tag color="green" style={{ marginInlineEnd: 4 }}>
                已签收
              </Tag>
              {timeText(order.signedAt)} ›
            </div>
          </Row>
          <Row label="发货时间" onSend={() => onSend?.(`亲，您的订单已于 ${timeText(order.shippedAt)} 发出～`)}>
            {timeText(order.shippedAt)} ⌄
          </Row>
        </>
      ) : null}

      {/* 收货信息（脱敏） */}
      <Row label="收货信息" onSend={() => onSend?.(`收货信息：${order.receiver}，${order.address}`)}>
        <Space size={4}>
          <EnvironmentOutlined style={{ color: '#8c8c8c' }} />
          <span>
            {order.receiver}，{order.address}
          </span>
        </Space>
        <Space size={8} style={{ marginLeft: 8, fontSize: 12 }}>
          <Typography.Link style={{ fontSize: 12 }} onClick={() => onSend?.(`亲，麻烦您核对一下收货地址：${order.receiver}，${order.address}`)}>
            发送
          </Typography.Link>
          <ActionButton
            code="change_address"
            name="修改"
            note="登记收货地址修改"
            onAction={onAction}
            pending={actionPending}
          />
        </Space>
      </Row>

      {/* 状态相关操作（参考图 1/2/3 的底部按钮组） */}
      <Space size={6} wrap style={{ marginTop: 10 }}>
        <ActionButton
          code="verify_address"
          name="核对地址"
          note="和买家核对收货地址"
          onAction={onAction}
          pending={actionPending}
        />
        {isUnpaid ? (
          <ActionButton code="urge_pay" name="催付" note="提醒买家尽快付款" onAction={onAction} pending={actionPending} />
        ) : null}
        {isUnpaid ? (
          <ActionButton code="change_price" name="改价" note="按活动价改价" onAction={onAction} pending={actionPending} />
        ) : null}
        {isUnpaid || order.stage === 'unshipped' ? (
          <ActionButton
            code="change_address"
            name="改地址"
            note="登记收货地址修改"
            onAction={onAction}
            pending={actionPending}
          />
        ) : null}
        {order.stage === 'unshipped' ? (
          <ActionButton code="ship_goods" name="去发货" note="把订单推进发货流程" onAction={onAction} pending={actionPending} />
        ) : null}
        {order.stage === 'unshipped' ? (
          <ActionButton
            code="ship_negotiate"
            name="发货协商"
            note="和买家协商发货时间"
            onAction={onAction}
            pending={actionPending}
          />
        ) : null}
        {isShipped ? (
          <ActionButton
            code="logistics_card"
            name="发物流卡"
            note="给买家发物流卡片"
            onAction={onAction}
            pending={actionPending}
          />
        ) : null}
        {isShipped ? (
          <ActionButton
            code="change_address"
            name="改地址"
            note="登记收货地址修改"
            onAction={onAction}
            pending={actionPending}
          />
        ) : null}
      </Space>
    </div>
  );
}
