import { Empty, Modal, Table, Tag, Typography } from 'antd';
import { ShoppingOutlined } from '@ant-design/icons';

/**
 * 商品「规格 / 属性」弹窗（客户 2026-10-03）：
 * 接待页里点「规格属性」，要能看到**管理员在《商品库》里配的真实商品信息**——
 * 规格 SKU（规格名 / 尺码 / 价格 / 库存）、商品属性（详情页参数表）、售价与划线价、库存、分类、
 * 上架状态、服务承诺、适用场景、详情图。
 *
 * 数据来源：会话快照里的 `session.product`（后端从 products 表按商品 id 取全字段，
 * 见 reception.service.ts 的 pickProduct），所以弹窗不需要再发请求，也不会和商品库不一致。
 */
export interface ProductAttr {
  id?: number;
  productNo?: string;
  title?: string;
  price?: number | string;
  originPrice?: number | string | null;
  stock?: number | null;
  category?: string | null;
  status?: number | null;
  coverUrl?: string | null;
  skus?: { name?: string; size?: string; price?: number | string; stock?: number | string }[] | null;
  attributes?: { name?: string; value?: string }[] | null;
  services?: string[] | null;
  scenes?: string[] | null;
  detailImages?: string[] | null;
}

interface Props {
  open: boolean;
  product?: ProductAttr | null;
  onClose: () => void;
}

const yuan = (value: number | string | null | undefined) =>
  value === null || value === undefined || value === '' ? '—' : `¥${Number(value).toFixed(2)}`;

/** 一行「标签 + 值」，与订单卡片同一套排版语言 */
function Line({ label, children }: { label: string; children: any }) {
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 12, lineHeight: '22px', marginTop: 6 }}>
      <span style={{ color: '#8c8c8c', flex: 'none', width: 64 }}>{label}</span>
      <span style={{ flex: 1, minWidth: 0, color: '#262626', wordBreak: 'break-all' }}>{children}</span>
    </div>
  );
}

export default function ProductSpecModal({ open, product, onClose }: Props) {
  const skus = (product?.skus || []).filter(
    (item) => item && (item.name || item.size || item.price !== undefined)
  );
  const attributes = (product?.attributes || []).filter((item) => item && item.name);
  const services = product?.services || [];
  const scenes = product?.scenes || [];
  const detailImages = product?.detailImages || [];

  return (
    <Modal open={open} title="规格 / 属性" onCancel={onClose} footer={null} width={520}>
      {!product ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前会话没有关联商品" />
      ) : (
        <div>
          <div style={{ display: 'flex', gap: 10 }}>
            <div className="order-thumb" style={{ width: 64, height: 64, fontSize: 24 }}>
              {product.coverUrl ? <img src={product.coverUrl} alt="" /> : <ShoppingOutlined />}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13, lineHeight: '20px' }}>{product.title}</div>
              <div style={{ marginTop: 4 }}>
                <span style={{ fontSize: 15, fontWeight: 600, color: '#fa541c' }}>{yuan(product.price)}</span>
                {product.originPrice ? (
                  <Typography.Text delete type="secondary" style={{ marginLeft: 6, fontSize: 12 }}>
                    {yuan(product.originPrice)}
                  </Typography.Text>
                ) : null}
              </div>
            </div>
          </div>

          <Line label="商品ID">{product.productNo || '—'}</Line>
          <Line label="商品分类">{product.category || '未分类'}</Line>
          <Line label="总库存">{product.stock ?? '—'}</Line>
          <Line label="上架状态">
            {product.status === 1 ? <Tag color="green">已上架</Tag> : <Tag>已下架</Tag>}
          </Line>

          <div style={{ marginTop: 14, fontSize: 13, fontWeight: 600 }}>规格（SKU）</div>
          {skus.length ? (
            <Table
              size="small"
              rowKey={(_, index) => String(index)}
              pagination={false}
              style={{ marginTop: 8 }}
              dataSource={skus}
              columns={[
                { title: '规格', dataIndex: 'name', render: (v) => v || '默认规格' },
                { title: '尺码', dataIndex: 'size', width: 80, render: (v) => v || '—' },
                { title: '价格', dataIndex: 'price', width: 110, render: (v) => yuan(v) },
                { title: '库存', dataIndex: 'stock', width: 90, render: (v) => (v === undefined || v === null ? '—' : v) },
              ]}
            />
          ) : (
            <div style={{ color: '#8c8c8c', fontSize: 12, marginTop: 6 }}>
              该商品在《商品库》里还没有维护规格，管理员可在商品编辑里补充规格（规格名 / 尺码 / 价格 / 库存）。
            </div>
          )}

          {attributes.length ? (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>商品属性</div>
              <Table
                size="small"
                rowKey={(_, index) => String(index)}
                pagination={false}
                style={{ marginTop: 8 }}
                dataSource={attributes}
                columns={[
                  { title: '属性', dataIndex: 'name', width: 140, render: (v) => v || '—' },
                  { title: '参数值', dataIndex: 'value', render: (v) => v || '—' },
                ]}
              />
            </div>
          ) : null}

          <div style={{ marginTop: 14 }}>
            <Line label="服务承诺">
              {services.length ? (
                <span>
                  {services.map((item) => (
                    <Tag key={item} color="blue" style={{ marginBottom: 4 }}>
                      {item}
                    </Tag>
                  ))}
                </span>
              ) : (
                '未维护'
              )}
            </Line>
            <Line label="适用场景">
              {scenes.length ? (
                <span>
                  {scenes.map((item) => (
                    <Tag key={item} style={{ marginBottom: 4 }}>
                      {item}
                    </Tag>
                  ))}
                </span>
              ) : (
                '未维护'
              )}
            </Line>
          </div>

          {detailImages.length ? (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>商品详情图</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {detailImages.map((url) => (
                  <img
                    key={url}
                    src={url}
                    alt=""
                    style={{ width: 84, height: 84, objectFit: 'cover', borderRadius: 4, border: '1px solid #f0f0f0' }}
                  />
                ))}
              </div>
            </div>
          ) : null}

          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 14, marginBottom: 0 }}>
            以上内容来自《商品库》，由管理员维护；接待中按这里的规格与承诺向买家说明。
          </Typography.Paragraph>
        </div>
      )}
    </Modal>
  );
}
