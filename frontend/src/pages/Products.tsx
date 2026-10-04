import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Upload,
  message,
} from 'antd';
import { DeleteOutlined, DownloadOutlined, PlusOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons';
import { api, download, uploadImage } from '../api/client';

export default function Products() {
  const [list, setList] = useState<any[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState<any>({ page: 1, pageSize: 10 });
  const [modal, setModal] = useState<{ open: boolean; record?: any }>({ open: false });
  const [importOpen, setImportOpen] = useState(false);
  const [csv, setCsv] = useState('');
  const [xlsxBase64, setXlsxBase64] = useState('');
  const [xlsxName, setXlsxName] = useState('');
  const [importResult, setImportResult] = useState<any>(null);
  const [form] = Form.useForm();
  // 筛选条（方案 F4-05：标题 / 商品ID、分类、价格区间、状态）
  const [filterKeyword, setFilterKeyword] = useState('');
  const [filterCategory, setFilterCategory] = useState<string | undefined>();
  const [filterMinPrice, setFilterMinPrice] = useState<number | null>(null);
  const [filterMaxPrice, setFilterMaxPrice] = useState<number | null>(null);
  const [filterStatus, setFilterStatus] = useState<number | undefined>();
  const coverUrl = Form.useWatch('coverUrl', form);
  const detailImages = Form.useWatch('detailImages', form) as string[] | undefined;

  const applyFilter = () =>
    load({
      keyword: filterKeyword || undefined,
      category: filterCategory,
      minPrice: filterMinPrice ?? undefined,
      maxPrice: filterMaxPrice ?? undefined,
      status: filterStatus,
      page: 1,
    });

  const resetFilter = () => {
    setFilterKeyword('');
    setFilterCategory(undefined);
    setFilterMinPrice(null);
    setFilterMaxPrice(null);
    setFilterStatus(undefined);
    load({ keyword: undefined, category: undefined, minPrice: undefined, maxPrice: undefined, status: undefined, page: 1 });
  };

  const load = async (patch: any = {}) => {
    const next = { ...query, ...patch };
    setQuery(next);
    setLoading(true);
    try {
      const res = await api<any>('/products', { query: next });
      setList(res.list || []);
      setTotal(res.total || 0);
      setCategories(res.categories || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load({ page: 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    const values = await form.validateFields();
    const body = {
      productNo: values.productNo,
      title: values.title,
      price: values.price,
      originPrice: values.originPrice,
      stock: values.stock,
      category: values.category,
      coverUrl: values.coverUrl || '',
      detailImages: values.detailImages || [],
      services: values.services || [],
      scenes: values.scenes || [],
      // 客户 2026-10-03：规格（SKU）交给管理员维护，接待页「规格/属性」读的就是这份数据
      skus: (values.skus || []).filter((item: any) => item && String(item.name || '').trim()),
    };
    try {
      if (modal.record) await api(`/products/${modal.record.id}`, { method: 'PUT', body });
      else await api('/products', { method: 'POST', body });
      message.success('已保存');
      setModal({ open: false });
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const doImport = async () => {
    try {
      const res = await api<any>('/products/import', {
        method: 'POST',
        body: xlsxBase64 ? { xlsxBase64 } : { csv },
      });
      setImportResult(res);
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <Card
      className="page-card"
      bordered={false}
      title="商品库"
      extra={
        <Space>
          <Button
            icon={<UploadOutlined />}
            onClick={() => {
              setImportResult(null);
              setXlsxBase64('');
              setXlsxName('');
              setImportOpen(true);
            }}
          >
            批量导入
          </Button>
          <Button
            icon={<DownloadOutlined />}
            onClick={async () => {
              try {
                // 导出当前筛选条件下的商品清单，可直接改完再导入
                await download('/products/export', {
                  keyword: filterKeyword || undefined,
                  category: filterCategory,
                  minPrice: filterMinPrice ?? undefined,
                  maxPrice: filterMaxPrice ?? undefined,
                  status: filterStatus,
                });
                message.success('已开始下载商品清单 Excel');
              } catch (e) {
                message.error((e as Error).message);
              }
            }}
          >
            导出 Excel
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setModal({ open: true });
              form.resetFields();
            }}
          >
            新建商品
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => load()}>
            刷新
          </Button>
        </Space>
      }
    >
      {/* 筛选条（方案 F4-05：按标题 / 商品ID、分类、价格区间、状态筛选） */}
      <div className="library-filter" style={{ padding: 0, marginBottom: 12 }}>
        <Input.Search
          placeholder="商品标题 / 商品ID"
          allowClear
          style={{ width: 240 }}
          value={filterKeyword}
          onChange={(e) => setFilterKeyword(e.target.value)}
          onSearch={applyFilter}
        />
        <Select
          allowClear
          placeholder="分类"
          style={{ width: 140 }}
          value={filterCategory}
          onChange={(v) => setFilterCategory(v)}
          options={categories.map((c) => ({ value: c, label: c }))}
        />
        <Space size={4}>
          <InputNumber
            min={0}
            placeholder="最低价"
            style={{ width: 110 }}
            value={filterMinPrice}
            onChange={(v) => setFilterMinPrice(v as number | null)}
          />
          <span style={{ color: '#bfbfbf' }}>~</span>
          <InputNumber
            min={0}
            placeholder="最高价"
            style={{ width: 110 }}
            value={filterMaxPrice}
            onChange={(v) => setFilterMaxPrice(v as number | null)}
          />
        </Space>
        <Select
          allowClear
          placeholder="状态"
          style={{ width: 120 }}
          value={filterStatus}
          onChange={(v) => setFilterStatus(v)}
          options={[
            { value: 1, label: '在售' },
            { value: 0, label: '已下架' },
          ]}
        />
        <Button type="primary" onClick={applyFilter}>
          查询
        </Button>
        <Button onClick={resetFilter}>重置</Button>
      </div>
      <Table
        rowKey="id"
        loading={loading}
        dataSource={list}
        pagination={{
          total,
          current: query.page,
          pageSize: query.pageSize,
          showSizeChanger: true,
          showTotal: (t) => `共 ${t} 个商品`,
          onChange: (page, pageSize) => load({ page, pageSize }),
        }}
        columns={[
          {
            title: '主图',
            dataIndex: 'coverUrl',
            width: 80,
            render: (v) =>
              v ? <img src={v} alt="" style={{ width: 44, height: 44, borderRadius: 6 }} /> : <div style={{ width: 44, height: 44, borderRadius: 6, background: '#f0f2f5' }} />,
          },
          { title: '商品标题', dataIndex: 'title', ellipsis: true },
          { title: '商品ID', dataIndex: 'productNo', width: 200 },
          { title: '价格', dataIndex: 'price', width: 100, render: (v) => `¥${Number(v).toFixed(2)}` },
          { title: '库存', dataIndex: 'stock', width: 80 },
          { title: '分类', dataIndex: 'category', width: 100, render: (v) => <Tag>{v}</Tag> },
          { title: '关联剧本', dataIndex: 'scriptCount', width: 90 },
          {
            title: '状态',
            dataIndex: 'status',
            width: 90,
            render: (v) => (v === 1 ? <Tag color="blue">上架</Tag> : <Tag>下架</Tag>),
          },
          {
            title: '操作',
            width: 150,
            render: (_, row: any) => (
              <Space>
                <Button
                  type="link"
                  onClick={() => {
                    setModal({ open: true, record: row });
                    form.setFieldsValue(row);
                    // 列表不返回详情图，编辑时补拉一次，避免保存时把已有详情图覆盖掉
                    api<any>(`/products/${row.id}`)
                      .then((detail) =>
                        form.setFieldsValue({
                          coverUrl: detail.coverUrl || '',
                          detailImages: detail.detailImages || [],
                          // 列表接口不返回规格，编辑时一并补上，避免保存时把已有规格覆盖成空
                          skus: detail.skus || [],
                        })
                      )
                      .catch(() => undefined);
                  }}
                >
                  编辑
                </Button>
                <Popconfirm
                  title="确认删除该商品？"
                  onConfirm={async () => {
                    try {
                      await api(`/products/${row.id}`, { method: 'DELETE' });
                      message.success('已删除');
                      load();
                    } catch (e) {
                      message.error((e as Error).message);
                    }
                  }}
                >
                  <Button type="link" danger>
                    删除
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        open={modal.open}
        title={modal.record ? '编辑商品' : '新建商品'}
        onCancel={() => setModal({ open: false })}
        onOk={save}
        width={680}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="productNo" label="商品ID" rules={[{ required: true, message: '请输入商品ID' }]}>
            <Input placeholder="例如 3781182303640879201" disabled={!!modal.record} />
          </Form.Item>
          <Form.Item name="title" label="商品标题" rules={[{ required: true, message: '请输入商品标题' }]}>
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item label="商品主图">
            <Space align="start">
              <Upload
                listType="picture-card"
                accept="image/*"
                showUploadList={false}
                customRequest={async ({ file, onSuccess, onError }: any) => {
                  try {
                    const url = await uploadImage(file as File);
                    form.setFieldValue('coverUrl', url);
                    onSuccess?.({});
                  } catch (e) {
                    message.error((e as Error).message);
                    onError?.(e as Error);
                  }
                }}
              >
                {coverUrl ? (
                  <img src={coverUrl} alt="主图" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <div>
                    <PlusOutlined />
                    <div style={{ marginTop: 8 }}>上传主图</div>
                  </div>
                )}
              </Upload>
              <Space direction="vertical" size={4}>
                <Input
                  value={coverUrl}
                  onChange={(e) => form.setFieldValue('coverUrl', e.target.value)}
                  placeholder="也可直接填写图片地址"
                  style={{ width: 320 }}
                />
                {coverUrl ? (
                  <Button size="small" type="link" onClick={() => form.setFieldValue('coverUrl', '')}>
                    清除主图
                  </Button>
                ) : null}
              </Space>
            </Space>
          </Form.Item>
          <Form.Item label="商品详情图" tooltip="最多 5 张，用于接待页商品卡片与详情展示">
            <Upload
              listType="picture-card"
              accept="image/*"
              fileList={(detailImages || []).map((url, index) => ({
                uid: `detail-${index}`,
                name: `详情图${index + 1}`,
                status: 'done',
                url,
              })) as any}
              customRequest={async ({ file, onSuccess, onError }: any) => {
                try {
                  const url = await uploadImage(file as File);
                  form.setFieldValue('detailImages', [...(form.getFieldValue('detailImages') || []), url]);
                  onSuccess?.({});
                } catch (e) {
                  message.error((e as Error).message);
                  onError?.(e as Error);
                }
              }}
              onRemove={(file) => {
                form.setFieldValue(
                  'detailImages',
                  (form.getFieldValue('detailImages') || []).filter((url: string) => url !== (file as any).url)
                );
              }}
            >
              {(detailImages || []).length >= 5 ? null : (
                <div>
                  <PlusOutlined />
                  <div style={{ marginTop: 8 }}>上传详情图</div>
                </div>
              )}
            </Upload>
          </Form.Item>
          <Space size={16}>
            <Form.Item name="price" label="销售价" rules={[{ required: true, message: '请输入价格' }]}>
              <InputNumber min={0.01} precision={2} style={{ width: 160 }} />
            </Form.Item>
            <Form.Item name="originPrice" label="划线价">
              <InputNumber min={0} precision={2} style={{ width: 160 }} />
            </Form.Item>
            <Form.Item name="stock" label="库存">
              <InputNumber min={0} style={{ width: 160 }} />
            </Form.Item>
          </Space>
          <Form.Item name="category" label="商品分类">
            <Select
              options={categories.map((c) => ({ value: c, label: c }))}
              style={{ width: 200 }}
            />
          </Form.Item>
          <Form.Item name="services" label="服务承诺">
            <Select
              mode="tags"
              placeholder="七天无理由 / 运费险 / 正品保障 ..."
              options={['七天无理由', '运费险', '正品保障', '48小时发货', '一年质保'].map((v) => ({ value: v, label: v }))}
            />
          </Form.Item>
          <Form.Item name="scenes" label="适用场景">
            <Select
              mode="tags"
              placeholder="出差/旅行/外出 / 节日送礼 ..."
              options={['出差/旅行/外出', '节日送礼', '日常通勤', '运动健身'].map((v) => ({ value: v, label: v }))}
            />
          </Form.Item>
          {/**
           * 客户 2026-10-03：接待页点「规格/属性」要能看到管理员在这里配的真实商品信息，
           * 所以商品库补上「规格（SKU）」的维护入口（名称 / 价格 / 库存），接待页弹窗直接读它。
           */}
          <Form.Item label="规格（SKU）" tooltip="接待页点「规格/属性」看到的就是这里维护的内容；留空表示该商品没有细分规格">
            <Form.List name="skus">
              {(fields, { add, remove }) => (
                <div>
                  {fields.map((field) => (
                    <Space key={field.key} align="baseline" style={{ marginBottom: 8 }}>
                      <Form.Item name={[field.name, 'name']} rules={[{ required: true, message: '请输入规格名' }]}>
                        <Input placeholder="规格名，如 S 码" style={{ width: 160 }} />
                      </Form.Item>
                      <Form.Item name={[field.name, 'price']}>
                        <InputNumber min={0} precision={2} placeholder="价格" style={{ width: 120 }} />
                      </Form.Item>
                      <Form.Item name={[field.name, 'stock']}>
                        <InputNumber min={0} placeholder="库存" style={{ width: 120 }} />
                      </Form.Item>
                      <Button type="text" danger icon={<DeleteOutlined />} onClick={() => remove(field.name)} />
                    </Space>
                  ))}
                  <Button type="dashed" block icon={<PlusOutlined />} onClick={() => add({ name: '', price: undefined, stock: undefined })}>
                    添加规格
                  </Button>
                </div>
              )}
            </Form.List>
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={importOpen}
        title="批量导入商品（Excel / CSV）"
        onCancel={() => {
          setImportOpen(false);
          setXlsxBase64('');
        }}
        onOk={doImport}
        width={680}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Space>
            <Upload
              accept=".xlsx,.csv,.txt"
              showUploadList={false}
              beforeUpload={(file) => {
                const name = (file.name || '').toLowerCase();
                const reader = new FileReader();
                if (name.endsWith('.xlsx')) {
                  setXlsxName(file.name);
                  reader.onload = () => {
                    setXlsxBase64(String(reader.result || ''));
                    setCsv('');
                  };
                  reader.readAsDataURL(file);
                } else {
                  setXlsxBase64('');
                  setXlsxName('');
                  reader.onload = () => setCsv(String(reader.result || ''));
                  reader.readAsText(file, 'utf-8');
                }
                return false;
              }}
            >
              <Button icon={<UploadOutlined />}>选择 Excel / CSV 文件</Button>
            </Upload>
            <Button
              icon={<DownloadOutlined />}
              onClick={() => {
                const header = 'product_no,title,price,stock,category,services,scenes\n';
                const sample = '3781182303640999001,示例商品标题,99.00,100,家居,七天无理由;运费险,日常通勤\n';
                const blob = new Blob(['\uFEFF' + header + sample], { type: 'text/csv;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'product-import-template.csv';
                a.click();
                URL.revokeObjectURL(url);
              }}
            >
              下载模板
            </Button>
          </Space>
          {xlsxBase64 ? (
            <Alert type="info" showIcon message={`已选择 Excel 文件：${xlsxName}，点击确定开始导入`} />
          ) : (
            <Input.TextArea
              rows={8}
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              placeholder="粘贴 CSV 内容，首行为表头：product_no,title,price,stock,category,services,scenes；Excel 请直接用上方按钮选择 .xlsx 文件"
            />
          )}
          {importResult && (
            <Card size="small">
              <div>
                导入完成：成功 <Tag color="green">{importResult.success}</Tag> 条，失败{' '}
                <Tag color="red">{importResult.failed?.length || 0}</Tag> 条（共 {importResult.total} 条）
              </div>
              {!!importResult.failed?.length && (
                <ul style={{ marginTop: 8, maxHeight: 160, overflow: 'auto', paddingLeft: 18 }}>
                  {importResult.failed.map((f: any) => (
                    <li key={f.row} style={{ fontSize: 12, color: '#8c8c8c' }}>
                      第 {f.row} 行：{f.reason}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </Space>
      </Modal>
    </Card>
  );
}
