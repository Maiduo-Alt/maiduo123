import { useEffect, useState } from 'react';
import { Button, Card, Form, Input, Modal, Popconfirm, Space, Table, Tag, Typography, message } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { api } from '../api/client';

/** 字典类型 → 说明（方案 F8-11：分类、标签等基础字典统一维护） */
const DICT_TYPES = [
  { code: 'bg', name: '买家咨询背景分类', scope: '用于《客户问题剧本》的背景筛选' },
  { code: 'qa', name: '买家咨询内容分类', scope: '用于《客户问题剧本》的内容筛选' },
  { code: 'script', name: '剧本分类', scope: '用于剧本列表筛选与任务范围限定' },
  { code: 'product', name: '商品分类', scope: '用于商品库筛选与编辑；商品库页面的「分类管理」与这里维护的是同一份数据' },
  { code: 'tag', name: '商品场景标签', scope: '商品详情里的场景标签（如「出差便携」）' },
];

export default function Dictionary() {
  const [type, setType] = useState('script');
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form] = Form.useForm();

  const current = DICT_TYPES.find((item) => item.code === type) || DICT_TYPES[0];

  const load = async (nextType = type) => {
    setLoading(true);
    try {
      const data = await api<any[]>('/categories', { query: { type: nextType } });
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);

  const openCreate = () => {
    form.resetFields();
    setEditing({ type });
  };

  const openRename = (record: any) => {
    form.setFieldsValue({ name: record.name });
    setEditing(record);
  };

  const save = async () => {
    const values = await form.validateFields();
    try {
      if (editing?.id) {
        const res = await api<any>(`/categories/${editing.id}`, { method: 'PUT', body: { name: values.name } });
        message.success(res.renamed ? `已改名，并同步更新了 ${res.renamed} 处引用` : '已改名');
      } else {
        await api('/categories', { method: 'POST', body: { type, name: values.name } });
        message.success('已新增');
      }
      setEditing(null);
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const remove = async (record: any) => {
    try {
      await api(`/categories/${record.id}`, { method: 'DELETE' });
      message.success('已删除');
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const move = async (record: any, delta: number) => {
    const list = [...rows];
    const index = list.findIndex((item) => item.id === record.id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= list.length) return;
    const [moved] = list.splice(index, 1);
    list.splice(target, 0, moved);
    setRows(list);
    try {
      await api('/categories/reorder', { method: 'PUT', body: { items: list.map((item, i) => ({ id: item.id, sort: i })) } });
    } catch (e) {
      message.error((e as Error).message);
      load();
    }
  };

  return (
    <div className="library-page">
      <div className="library-tabs">
        {DICT_TYPES.map((item) => (
          <div key={item.code} className={`library-tab ${type === item.code ? 'active' : ''}`} onClick={() => setType(item.code)}>
            {item.name}
          </div>
        ))}
      </div>

      <Card bordered={false} className="page-card">
        <Space style={{ marginBottom: 12 }} wrap>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新增字典项
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => load()}>
            刷新
          </Button>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {current.name}：{current.scope}。改名会同步更新已引用它的素材，删除前会检查是否还有引用。
          </Typography.Text>
        </Space>
        <Table
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={rows}
          pagination={false}
          columns={[
            { title: '名称', dataIndex: 'name' },
            {
              title: '被引用',
              dataIndex: 'count',
              width: 100,
              render: (value: number) => (value ? <Tag color="blue">{value}</Tag> : <Typography.Text type="secondary">0</Typography.Text>),
            },
            {
              title: '排序',
              width: 120,
              render: (_, row: any, index: number) => (
                <Space size={4}>
                  <Button size="small" type="link" disabled={index === 0} onClick={() => move(row, -1)}>
                    上移
                  </Button>
                  <Button size="small" type="link" disabled={index === rows.length - 1} onClick={() => move(row, 1)}>
                    下移
                  </Button>
                </Space>
              ),
            },
            {
              title: '操作',
              width: 150,
              render: (_, row: any) => (
                <Space size={4}>
                  <Button size="small" type="link" onClick={() => openRename(row)}>
                    改名
                  </Button>
                  <Popconfirm
                    title="删除后已引用它的素材会变成「分类不存在」，确定删除？"
                    onConfirm={() => remove(row)}
                  >
                    <Button size="small" type="link" danger>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        open={!!editing}
        title={editing?.id ? '修改字典项' : `新增${current.name}`}
        onCancel={() => setEditing(null)}
        onOk={save}
        okText="保存"
        width={460}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }, { max: 64, message: '不超过 64 个字' }]}>
            <Input placeholder="如：售后退款" maxLength={64} />
          </Form.Item>
          {editing?.id ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              改名会同步更新已引用该分类的素材，改完不需要再去逐条修改。
            </Typography.Text>
          ) : null}
        </Form>
      </Modal>
    </div>
  );
}
