import { useEffect, useState } from 'react';
import {
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  Upload,
  message,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { api, uploadImage } from '../api/client';

export default function Backgrounds() {
  const [tab, setTab] = useState('bg');
  const [bgList, setBgList] = useState<any[]>([]);
  const [qaList, setQaList] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [creators, setCreators] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [bgModal, setBgModal] = useState<{ open: boolean; record?: any }>({ open: false });
  const [qaModal, setQaModal] = useState<{ open: boolean; record?: any }>({ open: false });
  const [keyword, setKeyword] = useState('');
  const [creatorId, setCreatorId] = useState<number | null>(null);
  const [activeCategory, setActiveCategory] = useState('');
  const [categoryKeyword, setCategoryKeyword] = useState('');
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [dragId, setDragId] = useState<number | null>(null);
  /** 新建分类弹窗（替代 window.prompt） */
  const [categoryModal, setCategoryModal] = useState<{ open: boolean; name: string }>({ open: false, name: '' });
  const [total, setTotal] = useState(0);
  const [bgForm] = Form.useForm();
  const [qaForm] = Form.useForm();
  const qaImageUrl = Form.useWatch('imageUrl', qaForm);

  /** 加载当前页签的素材、分类（含数量）与创建人筛选。 */
  const load = async () => {
    setLoading(true);
    try {
      const query = {
        pageSize: 200,
        keyword,
        creatorId: creatorId ?? undefined,
        category: activeCategory || undefined,
      };
      const [list, cats] = await Promise.all([
        tab === 'bg' ? api<any>('/backgrounds', { query }) : api<any>('/contents', { query }),
        api<any>('/categories', { query: { type: tab } }),
      ]);
      const items = list.list || [];
      if (tab === 'bg') setBgList(items);
      else setQaList(items);
      setTotal(list.total ?? items.length);
      setCategories(cats || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    api<any>('/accounts', { query: { pageSize: 100 } })
      .then((data) => setCreators(data.list || []))
      .catch(() => setCreators([]));
  }, []);

  useEffect(() => {
    setSelectedIds([]);
    setActiveCategory('');
    setKeyword('');
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const resetFilter = () => {
    setKeyword('');
    setCreatorId(null);
    setActiveCategory('');
    setTimeout(load, 0);
  };

  const selectCategory = (name: string) => {
    setActiveCategory(name);
    setTimeout(load, 0);
  };

  // 用页面内弹窗而不是 window.prompt：内嵌浏览器 / 沙箱 iframe 会直接忽略原生 prompt，
  // 表现为「点了新建分类没反应」；无头自检时也无人应答会导致页面挂住。
  const createCategory = () => {
    setCategoryModal({ open: true, name: '' });
  };

  const saveCategory = async () => {
    const name = categoryModal.name.trim();
    if (!name) {
      message.warning('请输入分类名称');
      return;
    }
    try {
      await api('/categories', { method: 'POST', body: { type: tab, name } });
      message.success('分类已创建');
      setCategoryModal({ open: false, name: '' });
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  /** 拖拽排序：把被拖动的分类移到目标分类之前并保存。 */
  const dropCategory = async (targetId: number) => {
    if (!dragId || dragId === targetId) return;
    const list = [...categories];
    const from = list.findIndex((c) => c.id === dragId);
    const to = list.findIndex((c) => c.id === targetId);
    if (from < 0 || to < 0) return;
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    setCategories(list);
    setDragId(null);
    try {
      await api('/categories/reorder', {
        method: 'PUT',
        body: { items: list.map((c, index) => ({ id: c.id, sort: index })) },
      });
    } catch (e) {
      message.error((e as Error).message);
      load();
    }
  };

  const openCreate = () => {
    if (tab === 'bg') {
      setBgModal({ open: true });
      bgForm.resetFields();
      bgForm.setFieldsValue({ category: activeCategory || '通用' });
    } else {
      setQaModal({ open: true });
      qaForm.resetFields();
      qaForm.setFieldsValue({ stage: 'presale', category: activeCategory || '通用' });
    }
  };

  const batchRemove = async () => {
    if (!selectedIds.length) return;
    await remove(tab as 'bg' | 'qa', selectedIds);
    setSelectedIds([]);
  };

  const visibleCategories = categories.filter(
    (c) => !categoryKeyword.trim() || String(c.name).includes(categoryKeyword.trim())
  );
  const categoryTotal = categories.reduce((sum, c) => sum + Number(c.count || 0), 0);

  const saveBackground = async () => {
    const values = await bgForm.validateFields();
    const body = { name: values.name, description: values.description, category: values.category };
    if (bgModal.record) await api(`/backgrounds/${bgModal.record.id}`, { method: 'PUT', body });
    else await api('/backgrounds', { method: 'POST', body });
    message.success('已保存');
    setBgModal({ open: false });
    load();
  };

  const saveContent = async () => {
    const values = await qaForm.validateFields();
    const body = {
      templateName: values.templateName,
      question: values.question,
      acceptedAnswer: values.acceptedAnswer,
      imageUrl: values.imageUrl || '',
      stage: values.stage,
      category: values.category,
    };
    if (qaModal.record) await api(`/contents/${qaModal.record.id}`, { method: 'PUT', body });
    else await api('/contents', { method: 'POST', body });
    message.success('已保存');
    setQaModal({ open: false });
    load();
  };

  const remove = async (type: 'bg' | 'qa', ids: number[]) => {
    try {
      await api(`/${type === 'bg' ? 'backgrounds' : 'contents'}/batch-delete`, { method: 'POST', body: { ids } });
      message.success('已删除');
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <div className="library-page">
      {/* 顶部页签（参考图 2 / 3） */}
      <div className="library-tabs">
        <div className={`library-tab ${tab === 'bg' ? 'active' : ''}`} onClick={() => setTab('bg')}>
          买家咨询背景
        </div>
        <div className={`library-tab ${tab === 'qa' ? 'active' : ''}`} onClick={() => setTab('qa')}>
          买家咨询内容
        </div>
      </div>

      {/* 筛选条 */}
      <div className="library-filter">
        <Input
          allowClear
          style={{ width: 320 }}
          placeholder={tab === 'bg' ? '买家咨询背景 请输入' : '名称/咨询问题/接受方案 请输入'}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onPressEnter={() => load()}
        />
        <Select
          allowClear
          style={{ width: 220 }}
          placeholder="创建人 请选择"
          value={creatorId ?? undefined}
          onChange={(value) => setCreatorId((value as number) ?? null)}
          options={creators.map((item) => ({ value: item.id, label: item.displayName || item.username }))}
        />
        <Button type="primary" onClick={() => load()}>
          查询
        </Button>
        <Button onClick={resetFilter}>重置</Button>
      </div>

      <div className="library-body">
        {/* 模板分类（支持拖拽排序） */}
        <div className="library-categories">
          <div className="library-categories-head">
            <span>模板分类</span>
            <Button type="link" size="small" onClick={createCategory}>
              新建分类
            </Button>
          </div>
          <Input
            size="small"
            allowClear
            placeholder="请输入分类关键词"
            value={categoryKeyword}
            onChange={(e) => setCategoryKeyword(e.target.value)}
          />
          <div className="library-categories-label">分类（支持拖拽排序）</div>
          <div className="category-list">
            <div
              className={`category-item ${activeCategory === '' ? 'active' : ''}`}
              onClick={() => selectCategory('')}
            >
              <span>全部</span>
              <span className="category-count">{categoryTotal}</span>
            </div>
            {visibleCategories.map((category) => (
              <div
                key={category.id}
                draggable
                className={`category-item ${activeCategory === category.name ? 'active' : ''}`}
                onDragStart={() => setDragId(category.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => dropCategory(category.id)}
                onClick={() => selectCategory(category.name)}
              >
                <span>{category.name}</span>
                <span className="category-count">{category.count}</span>
              </div>
            ))}
          </div>
        </div>

        {/* 素材表格 */}
        <div className="library-table">
          <Space style={{ marginBottom: 12 }} wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              {tab === 'bg' ? '新建咨询背景' : '新建咨询内容'}
            </Button>
            <Button danger disabled={!selectedIds.length} onClick={batchRemove}>
              批量删除{tab === 'bg' ? '咨询背景' : '咨询内容'}
            </Button>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              共 {total} 条记录
            </Typography.Text>
          </Space>

          {tab === 'bg' ? (
            <Table
              rowKey="id"
              loading={loading}
              dataSource={bgList}
              rowSelection={{ selectedRowKeys: selectedIds, onChange: (keys) => setSelectedIds(keys as number[]) }}
              pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (t) => `共 ${t} 条记录` }}
              columns={[
                {
                  title: '买家咨询背景',
                  dataIndex: 'name',
                  render: (_, row: any) => (
                    <div>
                      <div style={{ fontWeight: 500 }}>{row.name}</div>
                      {row.description ? <div className="cell-sub">{row.description}</div> : null}
                    </div>
                  ),
                },
                { title: '创建人', dataIndex: 'createdByName', width: 120, render: (v) => v || '系统' },
                {
                  title: '最后修改时间',
                  dataIndex: 'updatedAt',
                  width: 190,
                  sorter: (a: any, b: any) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime(),
                  render: (v) => new Date(v).toLocaleString('zh-CN'),
                },
                {
                  title: '操作',
                  width: 140,
                  render: (_, row: any) => (
                    <Space size={4}>
                      <Button
                        type="link"
                        size="small"
                        onClick={() => {
                          setBgModal({ open: true, record: row });
                          bgForm.setFieldsValue(row);
                        }}
                      >
                        编辑
                      </Button>
                      <Popconfirm title="确认删除该背景？" onConfirm={() => remove('bg', [row.id])}>
                        <Button type="link" size="small" danger>
                          删除
                        </Button>
                      </Popconfirm>
                    </Space>
                  ),
                },
              ]}
            />
          ) : (
            <Table
              rowKey="id"
              loading={loading}
              dataSource={qaList}
              rowSelection={{ selectedRowKeys: selectedIds, onChange: (keys) => setSelectedIds(keys as number[]) }}
              pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (t) => `共 ${t} 条记录` }}
              columns={[
                {
                  title: '模板名称',
                  dataIndex: 'templateName',
                  width: 230,
                  render: (v, row: any) => (
                    <Space size={4} wrap>
                      <span style={{ fontWeight: 500 }}>{v}</span>
                      {row.builtin ? <Tag color="blue">官</Tag> : null}
                      <Tag color={row.stage === 'aftersale' ? 'orange' : 'green'}>
                        {row.stage === 'aftersale' ? '售后' : '售前'}
                      </Tag>
                    </Space>
                  ),
                },
                { title: '买家咨询问题', dataIndex: 'question', ellipsis: true },
                {
                  title: '图片',
                  dataIndex: 'imageUrl',
                  width: 80,
                  render: (v) =>
                    v ? (
                      <img src={v} alt="" style={{ width: 40, height: 40, borderRadius: 4, objectFit: 'cover' }} />
                    ) : (
                      '-'
                    ),
                },
                { title: '买家接受方案', dataIndex: 'acceptedAnswer', ellipsis: true, render: (v) => v || '-' },
                { title: '创建人', dataIndex: 'createdByName', width: 110, render: (v) => v || '系统' },
                {
                  title: '最后修改时间',
                  dataIndex: 'updatedAt',
                  width: 180,
                  render: (v) => new Date(v).toLocaleString('zh-CN'),
                },
                    {
                      title: '操作',
                      width: 140,
                      render: (_, row: any) => (
                        <Space>
                          <Button
                            type="link"
                            onClick={() => {
                              setQaModal({ open: true, record: row });
                              qaForm.setFieldsValue({
                                templateName: row.templateName,
                                question: row.question,
                                acceptedAnswer: row.acceptedAnswer,
                                imageUrl: row.imageUrl || '',
                                stage: row.stage,
                                category: row.category,
                              });
                            }}
                          >
                            编辑
                          </Button>
                          <Popconfirm title="确认删除该咨询内容？" onConfirm={() => remove('qa', [row.id])}>
                            <Button type="link" danger>
                              删除
                            </Button>
                          </Popconfirm>
                        </Space>
                      ),
                },
              ]}
            />
          )}
        </div>
      </div>

      <Modal
        open={categoryModal.open}
        title="新建模板分类"
        onCancel={() => setCategoryModal({ open: false, name: '' })}
        onOk={saveCategory}
        okText="创建"
        width={420}
        destroyOnClose
      >
        <Input
          autoFocus
          placeholder="请输入分类名称，例如：物流快递相关"
          value={categoryModal.name}
          onChange={(e) => setCategoryModal({ open: true, name: e.target.value })}
          onPressEnter={saveCategory}
        />
      </Modal>

      <Modal
        open={bgModal.open}
        title={bgModal.record ? '编辑买家咨询背景' : '新建买家咨询背景'}
        onCancel={() => setBgModal({ open: false })}
        onOk={saveBackground}
        destroyOnClose
      >
        <Form form={bgForm} layout="vertical">
          <Form.Item name="name" label="背景名称" rules={[{ required: true, message: '请输入背景名称' }]}>
            <Input placeholder="例如：使用场景：出差/旅行/外出" />
          </Form.Item>
          <Form.Item name="description" label="需求描述">
            <Input.TextArea rows={3} placeholder="例如：需求：便携小巧、轻便易携、不占行李" />
          </Form.Item>
          <Form.Item name="category" label="模板分类">
            <Select options={categories.map((c) => ({ value: c.name, label: c.name }))} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={qaModal.open}
        title={qaModal.record ? '编辑买家咨询内容' : '新建买家咨询内容'}
        onCancel={() => setQaModal({ open: false })}
        onOk={saveContent}
        width={640}
        destroyOnClose
      >
        <Form form={qaForm} layout="vertical">
          <Form.Item name="templateName" label="模板名称" rules={[{ required: true, message: '请输入模板名称' }]}>
            <Input placeholder="例如：咨询赠品发货安排" />
          </Form.Item>
          <Form.Item
            name="question"
            label="买家咨询问题（多个问句用分号分隔，建议 6～10 轮）"
            rules={[{ required: true, message: '请输入买家咨询问题' }]}
          >
            <Input.TextArea rows={3} placeholder="赠品发货时间，是跟所购商品一起发吗；如果分开发，什么时候能到" />
          </Form.Item>
          <Form.Item name="acceptedAnswer" label="买家接受方案（作为评分时的参考）">
            <Input.TextArea rows={2} placeholder="明确告知赠品随主商品一起发出，并给出出库时效" />
          </Form.Item>
          <Form.Item label="配图（可选）" tooltip="买家发来的截图或示意图，接待时可作为参考">
            <Space align="start">
              <Upload
                listType="picture-card"
                accept="image/*"
                showUploadList={false}
                customRequest={async ({ file, onSuccess, onError }: any) => {
                  try {
                    const url = await uploadImage(file as File);
                    qaForm.setFieldValue('imageUrl', url);
                    onSuccess?.({});
                  } catch (e) {
                    message.error((e as Error).message);
                    onError?.(e as Error);
                  }
                }}
              >
                {qaImageUrl ? (
                  <img src={qaImageUrl} alt="配图" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <div>
                    <PlusOutlined />
                    <div style={{ marginTop: 8 }}>上传配图</div>
                  </div>
                )}
              </Upload>
              <Space direction="vertical" size={4}>
                <Input
                  value={qaImageUrl}
                  onChange={(e) => qaForm.setFieldValue('imageUrl', e.target.value)}
                  placeholder="也可直接填写图片地址"
                  style={{ width: 300 }}
                />
                {qaImageUrl ? (
                  <Button size="small" type="link" onClick={() => qaForm.setFieldValue('imageUrl', '')}>
                    清除配图
                  </Button>
                ) : null}
              </Space>
            </Space>
          </Form.Item>
          <Space size={16}>
            <Form.Item name="stage" label="接待阶段">
              <Select
                style={{ width: 140 }}
                options={[
                  { value: 'presale', label: '售前' },
                  { value: 'aftersale', label: '售后' },
                ]}
              />
            </Form.Item>
            <Form.Item name="category" label="模板分类">
              <Select style={{ width: 180 }} options={categories.map((c) => ({ value: c.name, label: c.name }))} />
            </Form.Item>
          </Space>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
            系统会按分号自动拆分为提问序列；不足 6 轮时，接待中会从补充追问池自动补足并在明细中标注。
          </Typography.Paragraph>
        </Form>
      </Modal>
    </div>
  );
}
