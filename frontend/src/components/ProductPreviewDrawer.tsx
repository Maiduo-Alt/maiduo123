import { useMemo, useRef } from 'react';
import { Carousel, Drawer, Table, Tag, Typography } from 'antd';
import { LeftOutlined, RightOutlined, ShoppingOutlined } from '@ant-design/icons';
import type { ProductAttr } from './ProductSpecModal';

/**
 * 商品预览侧滑面板（客户 2026-10-10：对齐飞鸽会话页「商品预览」）：
 * 点会话里的商品卡，右侧滑出与真实商品详情页一致的预览——
 * 顶部图片轮播（左右切换 + 圆点）、价格/划线价/库存、标题、保障与物流、
 * 规格（SKU）表、产品参数（属性表）、商品详情长图。
 * 数据全部来自《商品库》的会话商品快照，不发新请求。
 */
interface Props {
  open: boolean;
  product?: ProductAttr | null;
  onClose: () => void;
}

const yuan = (value: number | string | null | undefined) =>
  value === null || value === undefined || value === '' ? '—' : `¥${Number(value).toFixed(2)}`;

/** 「标签 + 值」一行，浅灰标签，与飞鸽参数行同风格 */
function Row({ label, children }: { label: string; children: any }) {
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 12, lineHeight: '22px', padding: '5px 0' }}>
      <span style={{ color: '#8c8c8c', flex: 'none', width: 56 }}>{label}</span>
      <span style={{ flex: 1, minWidth: 0, color: '#262626', wordBreak: 'break-all' }}>{children}</span>
    </div>
  );
}

/** 分组标题（产品参数 / 商品详情 / 规格），飞鸽式居中细线分隔 */
function SectionTitle({ children }: { children: any }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '16px 0 8px', color: '#595959', fontSize: 13, fontWeight: 600 }}>
      <span style={{ flex: 1, height: 1, background: '#f0f0f0' }} />
      {children}
      <span style={{ flex: 1, height: 1, background: '#f0f0f0' }} />
    </div>
  );
}

export default function ProductPreviewDrawer({ open, product, onClose }: Props) {
  const carouselRef = useRef<any>(null);
  const services = product?.services || [];
  const skus = (product?.skus || []).filter((s) => s && (s.name || s.size));
  const attributes = (product?.attributes || []).filter((a) => a && a.name);
  const detailImages = product?.detailImages || [];
  // 轮播图 = 封面 + 详情图（去重、去空）
  const gallery = useMemo(() => {
    const list = [product?.coverUrl, ...detailImages].filter(Boolean) as string[];
    return [...new Set(list)];
  }, [product?.coverUrl, detailImages]);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={440}
      placement="right"
      title={
        <span>
          <LeftOutlined style={{ marginRight: 8, cursor: 'pointer' }} onClick={onClose} />
          商品预览
        </span>
      }
      styles={{ body: { padding: 0, background: '#f7f8fa' } }}
    >
      {!product ? null : (
        <div>
          {/* 图片轮播：左右箭头 + 底部圆点，复刻飞鸽商品预览主图区 */}
          <div style={{ position: 'relative', background: '#fff' }}>
            {gallery.length ? (
              <>
                <Carousel ref={carouselRef} dots={{ className: 'cs-preview-dots' }}>
                  {gallery.map((url, index) => (
                    <div key={index}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 400, background: '#fafafa' }}>
                        <img src={url} alt="" style={{ maxWidth: '100%', maxHeight: 400, objectFit: 'contain' }} />
                      </div>
                    </div>
                  ))}
                </Carousel>
                {gallery.length > 1 ? (
                  <>
                    <span
                      style={arrowStyle('left')}
                      onClick={() => carouselRef.current?.prev()}
                    >
                      <LeftOutlined />
                    </span>
                    <span
                      style={arrowStyle('right')}
                      onClick={() => carouselRef.current?.next()}
                    >
                      <RightOutlined />
                    </span>
                  </>
                ) : null}
              </>
            ) : (
              <div style={{ height: 240, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#bfbfbf', fontSize: 40 }}>
                <ShoppingOutlined />
              </div>
            )}
          </div>

          {/* 价格 + 标题 */}
          <div style={{ background: '#fff', padding: '12px 16px 14px' }}>
            <div>
              <span style={{ fontSize: 22, fontWeight: 700, color: '#ff2d55' }}>{yuan(product.price)}</span>
              {product.originPrice ? (
                <Typography.Text delete type="secondary" style={{ marginLeft: 8, fontSize: 13 }}>
                  {yuan(product.originPrice)}
                </Typography.Text>
              ) : null}
              {product.stock !== undefined && product.stock !== null ? (
                <span style={{ marginLeft: 10, fontSize: 12, color: '#8c8c8c' }}>库存 {product.stock}</span>
              ) : null}
            </div>
            <div style={{ marginTop: 6, fontSize: 14, lineHeight: '20px', color: '#262626' }}>{product.title}</div>
            <Row label="保障">
              {services.length ? (
                services.map((s) => (
                  <Tag key={s} color="blue" style={{ marginBottom: 4 }}>
                    {s}
                  </Tag>
                ))
              ) : (
                <span style={{ color: '#bfbfbf' }}>未维护</span>
              )}
            </Row>
            <Row label="物流">
              {services.some((s) => s.includes('发货')) ? '现货 · 按承诺时效发货' : <span style={{ color: '#bfbfbf' }}>未维护</span>}
            </Row>
          </div>

          {/* 规格 SKU */}
          {skus.length ? (
            <div style={{ background: '#fff', marginTop: 8, padding: '4px 16px 12px' }}>
              <SectionTitle>规格</SectionTitle>
              <Table
                size="small"
                rowKey={(_, i) => String(i)}
                pagination={false}
                dataSource={skus}
                columns={[
                  { title: '规格', dataIndex: 'name', render: (v) => v || '默认规格' },
                  { title: '尺码', dataIndex: 'size', width: 70, render: (v) => v || '—' },
                  { title: '价格', dataIndex: 'price', width: 100, render: (v) => yuan(v) },
                  { title: '库存', dataIndex: 'stock', width: 64, render: (v) => (v === undefined || v === null ? '—' : v) },
                ]}
              />
            </div>
          ) : null}

          {/* 产品参数（商品属性） */}
          {attributes.length ? (
            <div style={{ background: '#fff', marginTop: 8, padding: '4px 16px 12px' }}>
              <SectionTitle>产品参数</SectionTitle>
              <Table
                size="small"
                rowKey={(_, i) => String(i)}
                pagination={false}
                dataSource={attributes}
                showHeader={false}
                columns={[
                  { title: '属性', dataIndex: 'name', width: 120, render: (v) => <span style={{ color: '#8c8c8c' }}>{v || '—'}</span> },
                  { title: '参数值', dataIndex: 'value', render: (v) => v || '—' },
                ]}
              />
            </div>
          ) : null}

          {/* 商品详情：详情图整页铺开，像真实详情页 */}
          {detailImages.length ? (
            <div style={{ background: '#fff', marginTop: 8, padding: '4px 16px 16px' }}>
              <SectionTitle>商品详情</SectionTitle>
              {detailImages.map((url, index) => (
                <img key={index} src={url} alt="" style={{ width: '100%', display: 'block', marginBottom: 2 }} />
              ))}
            </div>
          ) : null}

          <Typography.Paragraph type="secondary" style={{ fontSize: 12, padding: '12px 16px', textAlign: 'center', margin: 0 }}>
            以上内容来自《商品库》，由管理员维护
          </Typography.Paragraph>
        </div>
      )}
    </Drawer>
  );
}

function arrowStyle(side: 'left' | 'right'): React.CSSProperties {
  return {
    position: 'absolute',
    top: '50%',
    [side]: 8,
    transform: 'translateY(-50%)',
    width: 28,
    height: 28,
    borderRadius: '50%',
    background: 'rgba(0,0,0,0.35)',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    zIndex: 2,
  };
}
