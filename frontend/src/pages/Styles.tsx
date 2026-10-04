import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Progress,
  Row,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { PlusOutlined, SaveOutlined } from '@ant-design/icons';
import { api } from '../api/client';

export default function Styles() {
  const [styles, setStyles] = useState<any[]>([]);
  const [preview, setPreview] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  /** 风格效果统计（方案 F7-07） */
  const [stats, setStats] = useState<any>(null);
  /** 自定义风格模板（方案 F7-08） */
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [styleForm] = Form.useForm();

  const createStyle = async () => {
    const values = await styleForm.validateFields();
    setCreating(true);
    try {
      await api('/styles', { method: 'POST', body: values });
      message.success('风格已新增，可在下方配置占比');
      setCreateOpen(false);
      styleForm.resetFields();
      load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const load = async () => {
    const data = await api<any[]>('/styles');
    setStyles(data);
    api<any>('/styles/stats')
      .then(setStats)
      .catch(() => setStats(null));
    const total = data.reduce((sum, s) => sum + (s.ratio || 0), 0);
    const map: Record<string, number> = {};
    data.forEach((s) => {
      const ratio = s.ratio === null || s.ratio === undefined ? (data.filter((x) => x.ratio === null).length ? (100 - total) / data.filter((x) => x.ratio === null).length : 0) : s.ratio;
      map[s.code] = Math.round(ratio);
    });
    setPreview(map);
  };

  useEffect(() => {
    load();
  }, []);

  const change = (code: string, value: number | null) => {
    setStyles((prev) => prev.map((s) => (s.code === code ? { ...s, ratio: value } : s)));
    setPreview((prev) => ({ ...prev, [code]: value ?? 0 }));
  };

  const total = styles.reduce((sum, s) => sum + (s.ratio || 0), 0);

  const save = async () => {
    setSaving(true);
    try {
      const res = await api<any>('/styles/ratios', {
        method: 'PUT',
        body: { items: styles.map((s) => ({ code: s.code, ratio: s.ratio ?? null })) },
      });
      setPreview(res.preview || {});
      message.success('占比已保存');
      load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      className="page-card"
      bordered={false}
      title="沟通风格"
      extra={
        <Space>
          <Button
            icon={<PlusOutlined />}
            onClick={() => {
              styleForm.resetFields();
              styleForm.setFieldsValue({ emotionBase: 20, isEmotional: false });
              setCreateOpen(true);
            }}
          >
            新建风格
          </Button>
          <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={save}>
            保存占比
          </Button>
        </Space>
      }
    >
      <Alert
        type={total > 100 ? 'error' : 'info'}
        showIcon
        style={{ marginBottom: 16 }}
        message={
          total > 100
            ? `占比总和为 ${total}%，已超过 100%，请调整后再保存`
            : `当前已填写 ${total}%，剩余 ${100 - total}% 将按“未填写”行平均分配（方案 3.7.4）`
        }
      />
      <Table
        rowKey="code"
        pagination={false}
        dataSource={styles}
        // 1366 宽下这一行固定列宽加起来会挤扁「风格特征」，加横向兜底让它保持可读
        scroll={{ x: 'max-content' }}
        columns={[
          { title: '买家沟通风格', dataIndex: 'name', width: 180 },
          { title: '风格特征', dataIndex: 'description', width: 260 },
          { title: '语气示例', dataIndex: 'toneSample', width: 240 },
          { title: '情绪基线', dataIndex: 'emotionBase', width: 100 },
          {
            title: '情绪化场景',
            dataIndex: 'isEmotional',
            width: 110,
            render: (v) => (v ? <Tag color="orange">是</Tag> : <Tag>否</Tag>),
          },
          {
            title: '聊天占比',
            width: 180,
            render: (_, row: any) => (
              <Space>
                <InputNumber
                  min={0}
                  max={100}
                  value={row.ratio ?? null}
                  placeholder="自动"
                  onChange={(v) => change(row.code, v as number | null)}
                  style={{ width: 90 }}
                />
                <span>%</span>
              </Space>
            ),
          },
          {
            title: '100 个剧本中的分布',
            width: 220,
            render: (_, row: any) => (
              <div>
                <Progress percent={preview[row.code] || 0} size="small" />
                <span style={{ fontSize: 12, color: '#8c8c8c' }}>约 {preview[row.code] || 0} 个</span>
              </div>
            ),
          },
          // 风格效果统计（方案 F7-07）
          {
            title: '被练次数',
            width: 100,
            render: (_, row: any) => {
              const item = stats?.items?.find((s: any) => s.code === row.code);
              return item ? item.attemptCount : '—';
            },
          },
          {
            title: '达标率',
            width: 110,
            render: (_, row: any) => {
              const item = stats?.items?.find((s: any) => s.code === row.code);
              if (!item || item.passRate === null) return <Typography.Text type="secondary">未练过</Typography.Text>;
              return (
                <Tag color={item.passRate >= 80 ? 'green' : item.passRate >= 50 ? 'orange' : 'red'}>
                  {item.passRate}%（{item.passCount}/{item.attemptCount}）
                </Tag>
              );
            },
          },
        ]}
      />
      {stats?.hardest?.length ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 16 }}
          message="最难应对的买家类型"
          description={`${stats.hardest
            .map((item: any) => `${item.name}（达标率 ${item.passRate}%）`)
            .join('　')}`}
        />
      ) : null}
      <Row gutter={16} style={{ marginTop: 16 }}>
        <Col span={24}>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
            说明：高难度档位（L3、L4）在抽取剧本时，会将急躁易怒型与纠结谨慎型的权重上浮 1.5 倍；已生成的剧本可单独指定风格，手工值优先。
          </Typography.Paragraph>
        </Col>
      </Row>

      {/* 自定义风格模板（方案 F7-08）：内置五种之外，管理员可自行新增 */}
      <Modal
        open={createOpen}
        title="新建沟通风格"
        onCancel={() => setCreateOpen(false)}
        onOk={createStyle}
        confirmLoading={creating}
        okText="保存"
        width={560}
        destroyOnClose
      >
        <Form form={styleForm} layout="vertical">
          <Space size={16}>
            <Form.Item
              name="code"
              label="风格编码"
              rules={[{ required: true, message: '请输入风格编码' }, { pattern: /^[a-z][a-z0-9_]*$/, message: '小写字母开头，可含数字与下划线' }]}
            >
              <Input placeholder="如 humorous" style={{ width: 220 }} />
            </Form.Item>
            <Form.Item name="name" label="风格名称" rules={[{ required: true, message: '请输入风格名称' }]}>
              <Input placeholder="如 幽默风趣型" style={{ width: 220 }} />
            </Form.Item>
          </Space>
          <Form.Item name="description" label="风格特征">
            <Input placeholder="如：喜欢开玩笑，语气轻松，但反感答非所问" />
          </Form.Item>
          <Form.Item name="toneSample" label="语气示例">
            <Input.TextArea rows={2} placeholder="如：哈哈哈你们这个包装也太可爱了吧～" />
          </Form.Item>
          <Space size={16}>
            <Form.Item name="emotionBase" label="情绪基线" tooltip="买家初始情绪值，0～100，越高越容易激动">
              <InputNumber min={0} max={100} style={{ width: 160 }} />
            </Form.Item>
            <Form.Item name="isEmotional" label="情绪化场景" valuePropName="checked">
              <Switch checkedChildren="是" unCheckedChildren="否" />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </Card>
  );
}
