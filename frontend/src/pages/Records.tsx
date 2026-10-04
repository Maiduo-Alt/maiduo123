import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, DatePicker, Drawer, Form, Input, Select, Space, Table, Tag, Typography, message } from 'antd';
import { DownloadOutlined, ReloadOutlined, SwapOutlined } from '@ant-design/icons';
import { api, download } from '../api/client';
import { useAuth } from '../store/auth';

/** 明细详情里四维得分落在每个会话上，对比时取各会话的平均值。 */
function dimAvg(detail: any, key: string): number | string {
  const values = (detail?.sessions || [])
    .map((session: any) => session?.[key])
    .filter((value: any) => value !== null && value !== undefined) as number[];
  if (!values.length) return '—';
  return Math.round((values.reduce((sum, value) => sum + Number(value), 0) / values.length) * 10) / 10;
}

function fastest(detail: any): number {
  return (detail?.sessions || []).reduce(
    (max: number, session: any) => Math.max(max, Number(session?.maxResponseSec || 0)),
    0
  );
}

function timeoutSum(detail: any): number {
  return (detail?.sessions || []).reduce((sum: number, session: any) => sum + Number(session?.timeoutCount || 0), 0);
}

function durationText(attempt: any): string {
  if (!attempt?.started_at || !attempt?.finished_at) return '—';
  const seconds = Math.max(0, Math.round((Date.parse(attempt.finished_at) - Date.parse(attempt.started_at)) / 1000));
  return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`;
}

export default function Records() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  /** 方案 2.2：客服只能看本人明细，客服筛选只对带教/管理员有意义 */
  const canFilterByAccount = profile?.roleCode === 'admin' || profile?.roleCode === 'leader';
  const [data, setData] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState<any>({ page: 1, pageSize: 20 });
  const [accounts, setAccounts] = useState<any[]>([]);
  /** 对比视图（方案 F2-07）：最多选两次接待并排比指标 */
  const [selectedKeys, setSelectedKeys] = useState<number[]>([]);
  const [compare, setCompare] = useState<any[] | null>(null);
  const [form] = Form.useForm();

  const load = async (patch: any = {}) => {
    const next = { ...query, ...patch };
    setQuery(next);
    setLoading(true);
    try {
      const res = await api<any>('/records', { query: next });
      setData(res.list || []);
      setTotal(res.total || 0);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (canFilterByAccount) {
      api<any>('/accounts').then((res) => setAccounts(res.list || [])).catch(() => setAccounts([]));
    }
    load({ page: 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 表单里的时间范围拆成后端认识的 from / to（日期粒度，覆盖当天） */
  const submit = (values: any) => {
    const range = values.range;
    load({
      keyword: values.keyword || undefined,
      level: values.level,
      conclusion: values.conclusion,
      source: values.source,
      accountId: values.accountId,
      invalid: values.invalid,
      from: range?.[0] ? range[0].startOf('day').toISOString() : undefined,
      to: range?.[1] ? range[1].endOf('day').toISOString() : undefined,
      page: 1,
    });
  };

  return (
    <Card
      className="page-card"
      bordered={false}
      title="模拟接待明细"
      extra={
        <Space>
          <Button
            icon={<DownloadOutlined />}
            onClick={async () => {
              try {
                // 导出当前筛选条件下的全部明细（含对话全文），不只是当前这一页
                await download('/records/export', {
                  keyword: query.keyword,
                  level: query.level,
                  conclusion: query.conclusion,
                  source: query.source,
                  accountId: query.accountId,
                  from: query.from,
                  to: query.to,
                });
                message.success('已开始下载明细 Excel');
              } catch (e) {
                message.error((e as Error).message);
              }
            }}
          >
            导出 Excel
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => load()}>
            刷新
          </Button>
          <Button
            icon={<SwapOutlined />}
            disabled={selectedKeys.length !== 2}
            onClick={async () => {
              try {
                // 对比用现成的明细详情接口，不额外开后端口子
                const [left, right] = await Promise.all(selectedKeys.map((key) => api<any>(`/records/${key}`)));
                setCompare([left, right]);
              } catch (e) {
                message.error((e as Error).message);
              }
            }}
          >
            对比所选（{selectedKeys.length}/2）
          </Button>
        </Space>
      }
    >
      <Form
        form={form}
        layout="inline"
        style={{ marginBottom: 16, rowGap: 8 }}
        onFinish={submit}
      >
        <Form.Item name="keyword" label="关键词">
          <Input placeholder="接待编号 / 客服姓名" allowClear style={{ width: 200 }} />
        </Form.Item>
        {canFilterByAccount && (
          <Form.Item name="accountId" label="客服">
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              style={{ width: 150 }}
              placeholder="全部客服"
              options={accounts.map((item) => ({ value: item.id, label: item.displayName || item.username }))}
            />
          </Form.Item>
        )}
        <Form.Item name="range" label="接待时间">
          <DatePicker.RangePicker style={{ width: 240 }} />
        </Form.Item>
        <Form.Item name="level" label="难度">
          <Select
            allowClear
            style={{ width: 120 }}
            options={[
              { value: 'L1', label: 'L1 话术适应' },
              { value: 'L2', label: 'L2 简单' },
              { value: 'L3', label: 'L3 进阶' },
              { value: 'L4', label: 'L4 困难' },
            ]}
          />
        </Form.Item>
        <Form.Item name="conclusion" label="结论">
          <Select
            allowClear
            style={{ width: 120 }}
            options={[
              { value: 'pass', label: '达标' },
              { value: 'fail', label: '未达标' },
            ]}
          />
        </Form.Item>
        <Form.Item name="source" label="来源">
          <Select
            allowClear
            style={{ width: 120 }}
            options={[
              { value: 'free', label: '模拟训练' },
              { value: 'task', label: '任务训练' },
            ]}
          />
        </Form.Item>
        {/* C6：带教按「判定标签」筛选复盘（只看有被判无效回复的接待） */}
        <Form.Item name="invalid" label="判定标签">
          <Select
            allowClear
            style={{ width: 150 }}
            placeholder="全部"
            options={[{ value: '1', label: '含无效回复' }]}
          />
        </Form.Item>
        <Form.Item>
          <Space>
            <Button type="primary" htmlType="submit">
              查询
            </Button>
            <Button
              onClick={() => {
                form.resetFields();
                load({
                  keyword: undefined,
                  level: undefined,
                  conclusion: undefined,
                  source: undefined,
                  accountId: undefined,
                  invalid: undefined,
                  from: undefined,
                  to: undefined,
                  page: 1,
                });
              }}
            >
              重置
            </Button>
          </Space>
        </Form.Item>
      </Form>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={data}
        rowSelection={{
          selectedRowKeys: selectedKeys,
          // 对比最多选两条，选满后其余行禁用勾选
          onChange: (keys) => setSelectedKeys(keys as number[]),
          getCheckboxProps: (record: any) => ({ disabled: selectedKeys.length >= 2 && !selectedKeys.includes(record.id) }),
        }}
        pagination={{
          total,
          current: query.page,
          pageSize: query.pageSize,
          showSizeChanger: true,
          showTotal: (t) => `共 ${t} 条记录`,
          onChange: (page, pageSize) => load({ page, pageSize }),
        }}
        columns={[
          { title: '接待编号', dataIndex: 'attemptNo', width: 180 },
          { title: '客服', dataIndex: 'accountName', width: 120 },
          { title: '难度', dataIndex: 'level', width: 80 },
          { title: '来源', dataIndex: 'source', width: 100, render: (v) => (v === 'task' ? '任务训练' : '模拟训练') },
          { title: '会话数', dataIndex: 'sessionCount', width: 80 },
          {
            title: '接待时长',
            dataIndex: 'durationSec',
            width: 110,
            render: (v: number) => `${Math.floor(v / 60)}分${v % 60}秒`,
          },
          { title: '超时次数', dataIndex: 'timeoutCount', width: 90 },
          {
            title: '无效回复',
            dataIndex: 'invalidCount',
            width: 90,
            render: (v: number) => (v ? <Tag color="red">{v} 条</Tag> : '-'),
          },
          {
            title: '总分',
            dataIndex: 'totalScore',
            width: 100,
            render: (v) => (v === null ? '-' : <Typography.Text strong>{Number(v).toFixed(1)}</Typography.Text>),
          },
          {
            title: '结论',
            dataIndex: 'conclusion',
            width: 100,
            render: (v) => (v === 'pass' ? <Tag color="green">达标</Tag> : v === 'fail' ? <Tag color="red">未达标</Tag> : '-'),
          },
          {
            title: '接待时间',
            dataIndex: 'startedAt',
            render: (v) => new Date(v).toLocaleString('zh-CN'),
          },
          {
            title: '操作',
            width: 100,
            render: (_, row: any) => (
              <Button type="link" onClick={() => navigate(`/records/${row.id}`)}>
                查看详情
              </Button>
            ),
          },
        ]}
      />

      {/* 对比视图（方案 F2-07）：两次接待的关键指标并排看 */}
      <Drawer open={!!compare} title="接待对比" width={720} onClose={() => setCompare(null)}>
        {compare ? (
          <Table
            rowKey="metric"
            size="small"
            pagination={false}
            dataSource={[
              {
                metric: '接待编号',
                left: compare[0].attempt.attempt_no,
                right: compare[1].attempt.attempt_no,
              },
              { metric: '难度', left: compare[0].attempt.level, right: compare[1].attempt.level },
              {
                metric: '来源',
                left: compare[0].attempt.source === 'task' ? '任务训练' : '模拟训练',
                right: compare[1].attempt.source === 'task' ? '任务训练' : '模拟训练',
              },
              {
                metric: '总分',
                left: compare[0].attempt.total_score ?? '—',
                right: compare[1].attempt.total_score ?? '—',
              },
              {
                metric: '结论',
                left: compare[0].attempt.conclusion === 'pass' ? '达标' : '未达标',
                right: compare[1].attempt.conclusion === 'pass' ? '达标' : '未达标',
              },
              { metric: '会话数', left: (compare[0].sessions || []).length, right: (compare[1].sessions || []).length },
              {
                metric: '响应时效',
                left: dimAvg(compare[0], 'responseScore'),
                right: dimAvg(compare[1], 'responseScore'),
              },
              {
                metric: '问题解决',
                left: dimAvg(compare[0], 'solvingScore'),
                right: dimAvg(compare[1], 'solvingScore'),
              },
              {
                metric: '话术规范',
                left: dimAvg(compare[0], 'wordingScore'),
                right: dimAvg(compare[1], 'wordingScore'),
              },
              {
                metric: '情绪安抚',
                left: dimAvg(compare[0], 'emotionScore'),
                right: dimAvg(compare[1], 'emotionScore'),
              },
              {
                metric: '最慢首响',
                left: `${fastest(compare[0])} 秒`,
                right: `${fastest(compare[1])} 秒`,
              },
              {
                metric: '超时次数',
                left: timeoutSum(compare[0]),
                right: timeoutSum(compare[1]),
              },
              {
                metric: '接待时长',
                left: durationText(compare[0].attempt),
                right: durationText(compare[1].attempt),
              },
            ]}
            columns={[
              { title: '指标', dataIndex: 'metric', width: 120 },
              {
                title: compare[0].attempt.attempt_no,
                dataIndex: 'left',
                render: (value: any, row: any) =>
                  row.metric === '总分' ? <b>{value}</b> : value,
              },
              {
                title: compare[1].attempt.attempt_no,
                dataIndex: 'right',
                render: (value: any, row: any) => (row.metric === '总分' ? <b>{value}</b> : value),
              },
            ]}
          />
        ) : null}
      </Drawer>
    </Card>
  );
}
