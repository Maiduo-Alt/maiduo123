import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Drawer,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  Upload,
  message,
} from 'antd';
import { ImportOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons';
import { api, download } from '../api/client';
import { useAuth } from '../store/auth';

/**
 * 方案 F5-05 建议的标签口径：情绪强度、问题类型等，允许自行追加。
 * 注意：分组 options 的子项必须是 { label, value } 对象；只写字符串会让
 * rc-select 在回填已有标签时抛 "Cannot use 'in' operator to search for 'value'"，
 * 直接把整页渲染成白屏（案例编辑弹窗曾因此崩溃）。
 */
const tagGroup = (label: string, values: string[]) => ({
  label,
  options: values.map((value) => ({ label: value, value })),
});

const TAG_PRESETS = [
  tagGroup('情绪强度', ['情绪-高', '情绪-中', '情绪-低']),
  tagGroup('问题类型', ['物流', '售后', '商品', '价格', '活动', '发货', '退换']),
  tagGroup('接待阶段', ['售前', '售后']),
];

const SOURCE_LABEL: Record<string, string> = {
  paste: '文本粘贴',
  // 文件导入的案例 sourceType 是 'file'，之前没登记 → 列表「来源」列直接显示英文 file
  file: '文件导入',
  attempt: '训练明细',
};

export default function Cases() {
  const { profile } = useAuth();
  /** 方案 F5-07：标记优秀回复属带教/管理员能力（客服只做题，不评审案例） */
  const canMark = profile?.roleCode === 'admin' || profile?.roleCode === 'leader';
  const [list, setList] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // 文件导入（方案 F5-01 / F5-03）
  const [fileOpen, setFileOpen] = useState(false);
  const [fileName, setFileName] = useState('');
  const [fileBase64, setFileBase64] = useState('');
  const [fileText, setFileText] = useState('');
  const [fileResult, setFileResult] = useState<any>(null);
  const [adapters, setAdapters] = useState<any[]>([]);
  const [adapterCode, setAdapterCode] = useState<string | undefined>();
  const [fileForm] = Form.useForm();
  const [detail, setDetail] = useState<any>(null);
  const [editing, setEditing] = useState<any>(null);
  const [tagOptions, setTagOptions] = useState<string[]>([]);
  const [query, setQuery] = useState<any>({ page: 1, pageSize: 10 });
  // 检索条（方案 F5-08：关键词、店铺、接待阶段、标签、导入时间）
  const [keyword, setKeyword] = useState('');
  const [shop, setShop] = useState('');
  const [stage, setStage] = useState<string | undefined>();
  const [tag, setTag] = useState<string | undefined>();
  const [range, setRange] = useState<any>(null);
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();

  const load = async (patch: any = {}) => {
    const next = { ...query, ...patch };
    setQuery(next);
    setLoading(true);
    try {
      const res = await api<any>('/cases', { query: next });
      setList(res.list || []);
      setTotal(res.total || 0);
      setTagOptions(res.tags || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load({ page: 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const search = () =>
    load({
      keyword: keyword.trim() || undefined,
      shop: shop.trim() || undefined,
      stage,
      tag,
      from: range?.[0] ? range[0].startOf('day').toISOString() : undefined,
      to: range?.[1] ? range[1].endOf('day').toISOString() : undefined,
      page: 1,
    });

  const resetFilter = () => {
    setKeyword('');
    setShop('');
    setStage(undefined);
    setTag(undefined);
    setRange(null);
    load({ keyword: undefined, shop: undefined, stage: undefined, tag: undefined, from: undefined, to: undefined, page: 1 });
  };

  const doImport = async () => {
    const values = await form.validateFields();
    try {
      const res = await api<any>('/cases/import/text', {
        method: 'POST',
        body: { title: values.title, text: values.text, shop: values.shop, stage: values.stage, tags: values.tags || [] },
      });
      message.success(`已导入 ${res.imported} 条消息${res.failed?.length ? `，${res.failed.length} 行解析失败` : ''}`);
      setImportOpen(false);
      form.resetFields();
      load({ page: 1 });
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  /** 打开文件导入：顺带拉一次可用适配器，平台适配器接进来后这里会自动多一项 */
  const openFileImport = () => {
    setFileName('');
    setFileBase64('');
    setFileText('');
    setFileResult(null);
    setAdapterCode(undefined);
    fileForm.resetFields();
    fileForm.setFieldsValue({ stage: 'presale' });
    setFileOpen(true);
    api<any[]>('/cases/adapters')
      .then((rows) => setAdapters(rows || []))
      .catch(() => setAdapters([]));
  };

  const doImportFile = async () => {
    const values = await fileForm.validateFields();
    if (!fileName) {
      message.warning('请先选择 .xlsx 或 .csv 文件');
      return;
    }
    try {
      const res = await api<any>('/cases/import/file', {
        method: 'POST',
        body: {
          title: values.title,
          shop: values.shop,
          stage: values.stage,
          tags: values.tags || [],
          adapterCode,
          fileName,
          base64: fileBase64 || undefined,
          text: fileText || undefined,
        },
      });
      setFileResult(res);
      message.success(`已导入 ${res.imported} 条消息（适配器：${res.adapter}）`);
      load({ page: 1 });
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const openEdit = (record: any) => {
    editForm.setFieldsValue({
      title: record.title,
      shop: record.shop || '',
      stage: record.stage,
      tags: record.tags || [],
    });
    setEditing(record);
  };

  const saveEdit = async () => {
    const values = await editForm.validateFields();
    try {
      await api(`/cases/${editing.id}`, { method: 'PUT', body: values });
      message.success('案例已更新');
      setEditing(null);
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <Card
      className="page-card"
      bordered={false}
      title="案例收藏"
      extra={
        <Space>
          <Button
            type="primary"
            icon={<ImportOutlined />}
            onClick={() => {
              form.resetFields();
              form.setFieldsValue({ stage: 'presale' });
              setImportOpen(true);
            }}
          >
            导入真实会话
          </Button>
          <Button icon={<UploadOutlined />} onClick={openFileImport}>
            导入文件
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => load()}>
            刷新
          </Button>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="案例用于把真实接待经验回流成训练素材：导入或从训练明细转入后，可以一键生成“买家咨询内容”，再由剧本模块组合成训练剧本（方案 3.5 / F5-05 / F5-08 / F5-09）。"
      />

      {/* 检索条（方案 F5-08） */}
      <div className="library-filter" style={{ padding: 0, marginBottom: 12 }}>
        <Input
          allowClear
          style={{ width: 220 }}
          placeholder="案例标题 / 店铺"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onPressEnter={search}
        />
        <Input
          allowClear
          style={{ width: 150 }}
          placeholder="店铺"
          value={shop}
          onChange={(e) => setShop(e.target.value)}
          onPressEnter={search}
        />
        <Select
          allowClear
          style={{ width: 130 }}
          placeholder="接待阶段"
          value={stage}
          onChange={setStage}
          options={[
            { value: 'presale', label: '售前' },
            { value: 'aftersale', label: '售后' },
          ]}
        />
        <Select
          allowClear
          showSearch
          style={{ width: 160 }}
          placeholder="标签"
          value={tag}
          onChange={setTag}
          options={tagOptions.map((item) => ({ value: item, label: item }))}
        />
        <DatePicker.RangePicker style={{ width: 240 }} value={range} onChange={setRange} />
        <Button type="primary" onClick={search}>
          查询
        </Button>
        <Button onClick={resetFilter}>重置</Button>
      </div>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={list}
        // 1366 宽下这一行列表的固定列宽加起来会超过容器，加个横向兜底，避免把整页撑宽
        scroll={{ x: 'max-content' }}
        pagination={{
          total,
          current: query.page,
          pageSize: query.pageSize,
          showTotal: (t) => `共 ${t} 条案例`,
          onChange: (page, pageSize) => load({ page, pageSize }),
        }}
        columns={[
          { title: '案例标题', dataIndex: 'title', ellipsis: true },
          { title: '来源', dataIndex: 'sourceType', width: 110, render: (v) => SOURCE_LABEL[v] || v },
          { title: '接待阶段', dataIndex: 'stage', width: 100, render: (v) => (v === 'aftersale' ? '售后' : '售前') },
          {
            title: '标签',
            dataIndex: 'tags',
            width: 170,
            render: (tags: string[]) =>
              tags?.length ? (
                <Space size={4} wrap>
                  {tags.map((item) => (
                    <Tag key={item} style={{ marginInlineEnd: 0 }}>
                      {item}
                    </Tag>
                  ))}
                </Space>
              ) : (
                <Typography.Text type="secondary">—</Typography.Text>
              ),
          },
          { title: '消息数', dataIndex: 'messageCount', width: 80 },
          { title: '店铺', dataIndex: 'shop', width: 110, render: (v) => v || '-' },
          { title: '导入时间', dataIndex: 'createdAt', width: 150, render: (v) => new Date(v).toLocaleString('zh-CN') },
          {
            title: '操作',
            width: 250,
            render: (_, row: any) => (
              <Space>
                <Button type="link" onClick={async () => setDetail(await api(`/cases/${row.id}`))}>
                  查看
                </Button>
                <Button type="link" onClick={() => openEdit(row)}>
                  编辑
                </Button>
                <Button
                  type="link"
                  onClick={async () => {
                    try {
                      const res = await api<any>(`/cases/${row.id}/to-content`, { method: 'POST' });
                      message.success(`已生成咨询内容草稿（ID ${res.contentId}），可在素材库中补充要点`);
                    } catch (e) {
                      message.error((e as Error).message);
                    }
                  }}
                >
                  转为咨询内容
                </Button>
              </Space>
            ),
          },
        ]}
      />

      <Modal open={importOpen} title="导入真实会话记录" onCancel={() => setImportOpen(false)} onOk={doImport} width={680} destroyOnClose>
        <Form form={form} layout="vertical" initialValues={{ stage: 'presale' }}>
          <Form.Item name="title" label="案例标题" rules={[{ required: true, message: '请输入案例标题' }]}>
            <Input placeholder="例如：物流三天未更新的安抚与处理" />
          </Form.Item>
          <Space size={16}>
            <Form.Item name="shop" label="店铺/小组">
              <Input style={{ width: 220 }} />
            </Form.Item>
            <Form.Item name="stage" label="接待阶段">
              <Select
                style={{ width: 140 }}
                options={[
                  { value: 'presale', label: '售前' },
                  { value: 'aftersale', label: '售后' },
                ]}
              />
            </Form.Item>
          </Space>
          <Form.Item name="tags" label="标签（可多选，也可直接输入新标签）" tooltip="方案 F5-05：按分类、接待阶段、情绪强度、问题类型打标签">
            <Select
              mode="tags"
              allowClear
              placeholder="选择或输入标签"
              options={TAG_PRESETS}
              style={{ maxWidth: 560 }}
            />
          </Form.Item>
          <Form.Item
            name="text"
            label="会话内容（每行一条，格式：买家:内容 或 客服:内容）"
            rules={[{ required: true, message: '请粘贴会话内容' }]}
          >
            <Input.TextArea
              rows={10}
              placeholder={'买家:快递三天没有更新了！\n客服:亲，非常抱歉，我马上帮您核实物流进度～\n买家:什么时候能给答复？'}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer open={!!detail} title={detail?.title} width={560} onClose={() => setDetail(null)}>
        {canMark ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="把客服话术标为「优秀回复」，它会成为这条案例转成《买家咨询内容》时的参照答案（方案 F5-06 / F5-07）"
          />
        ) : null}
        {detail?.messages?.map((m: any) => (
          <div key={m.id} style={{ marginBottom: 10, opacity: 1 }}>
            <Space size={6} align="start">
              <Tag color={m.sender === 'buyer' ? 'default' : 'blue'}>{m.sender === 'buyer' ? '买家' : '客服'}</Tag>
              <Typography.Text>{m.content}</Typography.Text>
              {m.isExcellent ? <Tag color="gold">优秀回复</Tag> : null}
              {canMark && m.sender === 'agent' ? (
                <Button
                  type="link"
                  size="small"
                  onClick={async () => {
                    try {
                      await api(`/cases/messages/${m.id}/excellent`, {
                        method: 'POST',
                        body: { isExcellent: !m.isExcellent },
                      });
                      setDetail(await api(`/cases/${detail.id}`));
                    } catch (e) {
                      message.error((e as Error).message);
                    }
                  }}
                >
                  {m.isExcellent ? '取消优秀' : '标为优秀回复'}
                </Button>
              ) : null}
            </Space>
          </div>
        ))}
      </Drawer>

      {/* 案例维护（方案 F5-05） */}
      {/* 文件导入（方案 F5-01 / F5-03） */}
      <Modal
        open={fileOpen}
        title="导入会话文件（Excel / CSV）"
        onCancel={() => setFileOpen(false)}
        onOk={doImportFile}
        okText="开始导入"
        width={620}
        destroyOnClose
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="文件首行为表头，至少包含「角色」与「内容」两列（角色写买家/客服），也兼容单列「买家:内容」的写法。"
          action={
            <Button size="small" onClick={() => download('/cases/import/template')}>
              下载模板
            </Button>
          }
        />
        <Form form={fileForm} layout="vertical">
          <Form.Item name="title" label="案例标题" rules={[{ required: true, message: '请输入案例标题' }]}>
            <Input placeholder="例如：物流三天未更新的安抚与处理" />
          </Form.Item>
          <Space size={16}>
            <Form.Item name="shop" label="店铺 / 小组">
              <Input style={{ width: 200 }} />
            </Form.Item>
            <Form.Item name="stage" label="接待阶段">
              <Select
                style={{ width: 130 }}
                options={[
                  { value: 'presale', label: '售前' },
                  { value: 'aftersale', label: '售后' },
                ]}
              />
            </Form.Item>
            <Form.Item label="导入格式">
              <Select
                allowClear
                placeholder="自动识别"
                style={{ width: 170 }}
                value={adapterCode}
                onChange={setAdapterCode}
                options={adapters.map((item) => ({ value: item.code, label: item.name }))}
              />
            </Form.Item>
          </Space>
          <Form.Item name="tags" label="标签">
            <Select mode="tags" allowClear placeholder="选择或输入标签" options={TAG_PRESETS} />
          </Form.Item>
          <Form.Item label="会话文件">
            <Upload
              accept=".xlsx,.csv"
              maxCount={1}
              showUploadList={false}
              customRequest={async ({ file, onSuccess, onError }: any) => {
                const target = file as File;
                try {
                  const text = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(String(reader.result || ''));
                    reader.onerror = () => reject(reader.error);
                    if (target.name.toLowerCase().endsWith('.csv')) reader.readAsText(target, 'utf-8');
                    else reader.readAsDataURL(target);
                  });
                  setFileName(target.name);
                  if (target.name.toLowerCase().endsWith('.csv')) {
                    setFileText(text.replace(/^\uFEFF/, ''));
                    setFileBase64('');
                  } else {
                    setFileBase64(text.includes(',') ? text.slice(text.indexOf(',') + 1) : text);
                    setFileText('');
                  }
                  onSuccess?.({});
                } catch (error) {
                  message.error('文件读取失败');
                  onError?.(error as Error);
                }
              }}
            >
              <Button icon={<UploadOutlined />}>{fileName || '选择文件'}</Button>
            </Upload>
            {fileName ? <Typography.Text type="secondary" style={{ marginLeft: 8 }}>{fileName}</Typography.Text> : null}
          </Form.Item>
          {fileResult?.failed?.length ? (
            <Alert
              type="warning"
              showIcon
              message={`${fileResult.failed.length} 行未导入`}
              description={fileResult.failed
                .slice(0, 5)
                .map((item: any) => `第 ${item.line} 行：${item.reason}`)
                .join('；')}
            />
          ) : null}
        </Form>
      </Modal>

      <Modal
        open={!!editing}
        title="编辑案例"
        onCancel={() => setEditing(null)}
        onOk={saveEdit}
        okText="保存"
        width={560}
        destroyOnClose
      >
        <Form form={editForm} layout="vertical">
          <Form.Item name="title" label="案例标题" rules={[{ required: true, message: '请输入案例标题' }]}>
            <Input maxLength={160} />
          </Form.Item>
          <Space size={16}>
            <Form.Item name="shop" label="店铺 / 小组">
              <Input style={{ width: 220 }} />
            </Form.Item>
            <Form.Item name="stage" label="接待阶段">
              <Select
                style={{ width: 140 }}
                options={[
                  { value: 'presale', label: '售前' },
                  { value: 'aftersale', label: '售后' },
                ]}
              />
            </Form.Item>
          </Space>
          <Form.Item name="tags" label="标签">
            <Select mode="tags" allowClear placeholder="选择或输入标签" options={TAG_PRESETS} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
