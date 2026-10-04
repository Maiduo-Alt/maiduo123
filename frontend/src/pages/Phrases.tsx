import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AutoComplete,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { PlusOutlined, ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { api } from '../api/client';

interface PhraseRow {
  id: number;
  category: string;
  title: string;
  content: string;
  variables: string[];
  usedCount: number;
  status: number;
}

/** 与后端 domain/phrase-vars.ts 同口径：抽取内容里的 {变量}（仅供表单实时预览）。 */
function extractVariables(content: string): string[] {
  if (!content) return [];
  const found: string[] = [];
  const pattern = /\{([^{}\s]{1,32})\}/g;
  let match = pattern.exec(content);
  while (match) {
    if (!found.includes(match[1])) found.push(match[1]);
    match = pattern.exec(content);
  }
  return found;
}

/**
 * 快捷短语维护（方案 3.8 F8-08，一期）。
 * 页面结构按方案 3.8.5：左侧分类，右侧短语列表（标题、内容、变量、使用次数）。
 */
export default function Phrases() {
  const [list, setList] = useState<PhraseRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeCategory, setActiveCategory] = useState('');
  const [categoryKeyword, setCategoryKeyword] = useState('');
  const [keyword, setKeyword] = useState('');
  const [onlyDisabled, setOnlyDisabled] = useState(false);
  const [modal, setModal] = useState<{ open: boolean; record?: PhraseRow }>({ open: false });
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const contentValue = Form.useWatch('content', form) as string | undefined;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // all=1：维护页需要看到已停用的短语，便于重新启用
      const data = await api<any>('/phrases?all=1');
      setList(data.list || []);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const categoryStats = useMemo(() => {
    const map = new Map<string, number>();
    list.forEach((row) => map.set(row.category, (map.get(row.category) || 0) + 1));
    return [...map.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  }, [list]);

  const visibleCategories = categoryStats.filter(
    (item) => !categoryKeyword.trim() || item.name.includes(categoryKeyword.trim())
  );

  const rows = useMemo(() => {
    const kw = keyword.trim();
    return list.filter((row) => {
      if (activeCategory && row.category !== activeCategory) return false;
      if (onlyDisabled && row.status !== 0) return false;
      if (!kw) return true;
      return row.title.includes(kw) || row.content.includes(kw) || row.category.includes(kw);
    });
  }, [list, activeCategory, keyword, onlyDisabled]);

  const openCreate = () => {
    form.resetFields();
    form.setFieldsValue({ category: activeCategory || '通用', status: true });
    setModal({ open: true });
  };

  const openEdit = (record: PhraseRow) => {
    form.resetFields();
    form.setFieldsValue({
      category: record.category,
      title: record.title,
      content: record.content,
      status: record.status === 1,
    });
    setModal({ open: true, record });
  };

  const save = async () => {
    const values = await form.validateFields();
    const body = {
      category: values.category,
      title: values.title,
      content: values.content,
      status: values.status ? 1 : 0,
    };
    setSaving(true);
    try {
      if (modal.record) await api(`/phrases/${modal.record.id}`, { method: 'PUT', body });
      else await api('/phrases', { method: 'POST', body });
      message.success('已保存');
      setModal({ open: false });
      load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (record: PhraseRow) => {
    try {
      await api(`/phrases/${record.id}`, { method: 'PUT', body: { status: record.status === 1 ? 0 : 1 } });
      message.success(record.status === 1 ? '已停用' : '已启用');
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const remove = async (record: PhraseRow) => {
    try {
      await api(`/phrases/${record.id}`, { method: 'DELETE' });
      message.success('已删除');
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const previewVariables = extractVariables(contentValue || '');
  const disabledCount = list.filter((row) => row.status === 0).length;

  return (
    <div className="library-page">
      {/* 筛选条 */}
      <div className="library-filter">
        <Input
          allowClear
          style={{ width: 320 }}
          placeholder="短语标题 / 内容 / 分类 请输入"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <Button
          type={onlyDisabled ? 'primary' : 'default'}
          onClick={() => setOnlyDisabled((v) => !v)}
        >
          只看已停用（{disabledCount}）
        </Button>
        <Button icon={<ReloadOutlined />} onClick={() => load()}>
          刷新
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          共 {list.length} 条短语，覆盖 {categoryStats.length} 个分类
        </Typography.Text>
      </div>

      <div className="library-body">
        {/* 左侧分类 */}
        <div className="library-categories">
          <div className="library-categories-head">
            <span>短语分类</span>
          </div>
          <Input
            size="small"
            allowClear
            placeholder="请输入分类关键词"
            value={categoryKeyword}
            onChange={(e) => setCategoryKeyword(e.target.value)}
          />
          <div className="library-categories-label">分类</div>
          <div className="category-list">
            <div className={`category-item ${activeCategory === '' ? 'active' : ''}`} onClick={() => setActiveCategory('')}>
              <span>全部</span>
              <span className="category-count">{list.length}</span>
            </div>
            {visibleCategories.map((item) => (
              <div
                key={item.name}
                className={`category-item ${activeCategory === item.name ? 'active' : ''}`}
                onClick={() => setActiveCategory(item.name)}
              >
                <span>{item.name}</span>
                <span className="category-count">{item.count}</span>
              </div>
            ))}
          </div>
        </div>

        {/* 右侧短语列表 */}
        <div className="library-table">
          <Space style={{ marginBottom: 12 }} wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新建短语
            </Button>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              短语内容里的 {'{变量}'} 会在接待页插入时按当前会话替换（商品名、价格、订单号等）
            </Typography.Text>
          </Space>
          <Table
            rowKey="id"
            loading={loading}
            dataSource={rows}
            pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (t) => `共 ${t} 条记录` }}
            columns={[
              {
                title: '短语标题',
                dataIndex: 'title',
                width: 200,
                render: (_, row: PhraseRow) => (
                  <div>
                    <div style={{ fontWeight: 500 }}>
                      <ThunderboltOutlined style={{ color: '#1677ff', marginRight: 6 }} />
                      {row.title}
                    </div>
                    <div className="cell-sub">{row.category}</div>
                  </div>
                ),
              },
              {
                title: '短语内容',
                dataIndex: 'content',
                render: (value: string) => <span style={{ fontSize: 13 }}>{value}</span>,
              },
              {
                title: '变量',
                dataIndex: 'variables',
                width: 220,
                render: (variables: string[]) =>
                  variables?.length ? (
                    <Space size={4} wrap>
                      {variables.map((name) => (
                        <Tag key={name} color="blue" style={{ marginInlineEnd: 0 }}>
                          {name}
                        </Tag>
                      ))}
                    </Space>
                  ) : (
                    <Typography.Text type="secondary">—</Typography.Text>
                  ),
              },
              { title: '使用次数', dataIndex: 'usedCount', width: 100, sorter: (a: PhraseRow, b: PhraseRow) => a.usedCount - b.usedCount },
              {
                title: '状态',
                dataIndex: 'status',
                width: 90,
                render: (value: number) => (value === 1 ? <Tag color="green">启用</Tag> : <Tag>已停用</Tag>),
              },
              {
                title: '操作',
                width: 190,
                render: (_, row: PhraseRow) => (
                  <Space size={4}>
                    <Button type="link" size="small" onClick={() => openEdit(row)}>
                      编辑
                    </Button>
                    <Button type="link" size="small" onClick={() => toggleStatus(row)}>
                      {row.status === 1 ? '停用' : '启用'}
                    </Button>
                    <Popconfirm title="确定删除该短语？" onConfirm={() => remove(row)}>
                      <Button type="link" size="small" danger>
                        删除
                      </Button>
                    </Popconfirm>
                  </Space>
                ),
              },
            ]}
          />
        </div>
      </div>

      <Modal
        open={modal.open}
        title={modal.record ? '编辑快捷短语' : '新建快捷短语'}
        onCancel={() => setModal({ open: false })}
        onOk={save}
        confirmLoading={saving}
        okText="保存"
        width={620}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="category" label="短语分类" rules={[{ required: true, message: '请输入或选择分类' }]}>
            <AutoComplete
              options={categoryStats.map((item) => ({ value: item.name }))}
              placeholder="如：开场 / 商品 / 价格 / 物流 / 售后"
              filterOption={(input, option) => String(option?.value || '').includes(input)}
            />
          </Form.Item>
          <Form.Item
            name="title"
            label="短语标题"
            rules={[{ required: true, message: '请输入短语标题' }, { max: 64, message: '标题不超过 64 个字' }]}
          >
            <Input placeholder="如：到手价说明" maxLength={64} />
          </Form.Item>
          <Form.Item
            name="content"
            label="短语内容"
            rules={[{ required: true, message: '请输入短语内容' }, { max: 500, message: '内容不超过 500 个字' }]}
          >
            <Input.TextArea rows={4} maxLength={500} showCount placeholder="亲，这款到手价 {到手价} 元，{优惠方式} 后实付哦～" />
          </Form.Item>
          <Form.Item label="变量（按内容里的 {变量} 自动识别）">
            {previewVariables.length ? (
              <Space size={4} wrap>
                {previewVariables.map((name) => (
                  <Tag key={name} color="blue">
                    {name}
                  </Tag>
                ))}
              </Space>
            ) : (
              <Typography.Text type="secondary">未使用变量</Typography.Text>
            )}
          </Form.Item>
          <Form.Item name="status" label="启用状态" valuePropName="checked" initialValue>
            <Switch checkedChildren="启用" unCheckedChildren="停用" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
