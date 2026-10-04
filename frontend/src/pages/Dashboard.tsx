import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Card, Col, Empty, Row, Segmented, Space, Statistic, Table, Tag, Typography, message } from 'antd';
import { api } from '../api/client';
import { useAuth } from '../store/auth';
import dayjs from 'dayjs';
import TrendChart from '../components/TrendChart';

export default function Dashboard() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  /** 客户新增需求：自由练习只给管理员/主管，客服从《我的任务》进入训练 */
  const canFreePractice = profile?.roleCode === 'admin' || profile?.roleCode === 'leader';
  const [overview, setOverview] = useState<any>(null);
  /** 我的任务（方案 F6-05：首页看到待办任务与截止倒计时） */
  const [tasks, setTasks] = useState<any[]>([]);
  /** 任务催办（方案 F6-10）：24 小时内到期或已过期但未完成的任务 */
  const [reminders, setReminders] = useState<any[]>([]);
  /** 个人成长曲线（方案 F2-09） */
  const [trend, setTrend] = useState<any>(null);
  const [trendMetric, setTrendMetric] = useState<'avgScore' | 'avgFirstResponse' | 'timeoutCount'>('avgScore');
  /**
   * 成长曲线粒度（方案 F2-09）：
   * - `session`（默认）：当天每一次模拟各一个点——新人一天练好几局，按天平均只剩一个点，看不出走势；
   * - `day`：最近 30 天按天平均（方案原文口径）。
   */
  const [trendScope, setTrendScope] = useState<'session' | 'day'>('session');

  useEffect(() => {
    api('/records/overview').then(setOverview);
    api<any[]>('/tasks')
      .then((rows) => setTasks(rows || []))
      .catch(() => setTasks([]));
    api<any>('/tasks/reminders')
      .then((res) => setReminders(res?.items || []))
      .catch(() => setReminders([]));
  }, []);

  useEffect(() => {
    api<any>('/records/trend', { query: { days: 30, granularity: trendScope } })
      .then(setTrend)
      .catch(() => setTrend(null));
  }, [trendScope]);

  const stats = overview?.stats || { totalCount: 0, avgScore: 0, bestScore: 0, passCount: 0 };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card className="page-card" bordered={false}>
        <Typography.Title level={4} style={{ marginTop: 0 }}>
          你好，{profile?.displayName}
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          {canFreePractice
            ? '从这里查看你的训练任务与最近接待；要练手请到《在线模拟接待》。'
            : '从这里查看你的训练任务与最近接待。'}
        </Typography.Paragraph>
      </Card>

      <Row gutter={16}>
        <Col span={6}>
          <Card bordered={false}>
            <Statistic title="累计接待次数" value={stats.totalCount} />
          </Card>
        </Col>
        <Col span={6}>
          <Card bordered={false}>
            <Statistic title="平均得分" value={stats.avgScore} precision={1} suffix="分" />
          </Card>
        </Col>
        <Col span={6}>
          <Card bordered={false}>
            <Statistic title="最高得分" value={stats.bestScore} precision={1} suffix="分" />
          </Card>
        </Col>
        <Col span={6}>
          <Card bordered={false}>
            <Statistic title="达标次数" value={stats.passCount} suffix={`/ ${stats.totalCount}`} />
          </Card>
        </Col>
      </Row>

      {reminders.length > 0 && (
        <Alert
          type={reminders.some((item) => item.overdue) ? 'error' : 'warning'}
          showIcon
          message="训练任务催办"
          description={
            <span>
              {reminders
                .map(
                  (item) =>
                    `${item.name}（还差 ${Math.max(0, item.targetCount - item.doneCount)} 次，${
                      item.overdue ? '已过期' : `还剩 ${item.hoursLeft} 小时`
                    }）`
                )
                .join('　')}
            </span>
          }
        />
      )}

      {/* 「我的任务」只列下发给自己的：带教/管理员的列表里包含别人被下发的任务 */}
      {tasks.filter((item) => item.assignedToMe).length > 0 && (
        <Card
          title={`我的任务（进行中 ${
            tasks.filter((item) => item.assignedToMe && item.status === 'running').length
          } 个）`}
          bordered={false}
          className="page-card"
        >
          <Table
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={tasks.filter((item) => item.assignedToMe)}
            columns={[
              { title: '任务名称', dataIndex: 'name', ellipsis: true },
              {
                title: '难度',
                dataIndex: 'levels',
                width: 140,
                render: (value: string[]) => (value || []).map((item) => <Tag key={item}>{item}</Tag>),
              },
              {
                title: '进度',
                width: 120,
                render: (_, row: any) => `${row.doneCount || 0} / ${row.targetCount} 次`,
              },
              {
                title: '截止时间',
                dataIndex: 'deadline',
                width: 240,
                render: (value: string) => {
                  const overdue = dayjs(value).isBefore(dayjs());
                  return (
                    <span>
                      {dayjs(value).format('YYYY-MM-DD HH:mm')}{' '}
                      {overdue ? (
                        <Tag color="red">已截止</Tag>
                      ) : (
                        <Tag color="blue">还剩 {dayjs(value).diff(dayjs(), 'hour')} 小时</Tag>
                      )}
                    </span>
                  );
                },
              },
              {
                title: '操作',
                width: 110,
                render: (_, row: any) => (
                  <Button
                    type="link"
                    size="small"
                    disabled={row.status !== 'running'}
                    onClick={() => navigate(`/reception?taskId=${row.id}`)}
                  >
                    开始训练
                  </Button>
                ),
              },
            ]}
          />
        </Card>
      )}

      {/* 个人成长曲线（方案 F2-09） */}
      {trend && (
        <Card
          title={
            trendScope === 'session'
              ? `我的成长曲线（今天 ${trend.summary?.attempts ?? 0} 次模拟）`
              : '我的成长曲线（最近 30 天）'
          }
          bordered={false}
          className="page-card"
          extra={
            <Space size={8} wrap>
              <Segmented
                size="small"
                value={trendScope}
                onChange={(value) => setTrendScope(value as typeof trendScope)}
                options={[
                  { value: 'session', label: '当天每次模拟' },
                  { value: 'day', label: '最近 30 天' },
                ]}
              />
              <Segmented
                size="small"
                value={trendMetric}
                onChange={(value) => setTrendMetric(value as typeof trendMetric)}
                options={[
                  { value: 'avgScore', label: '总分' },
                  { value: 'avgFirstResponse', label: '首响时长' },
                  { value: 'timeoutCount', label: '超时次数' },
                ]}
              />
            </Space>
          }
        >
          <TrendChart
            points={trend.points || []}
            valueKey={trendMetric}
            unit={trendMetric === 'avgScore' ? ' 分' : trendMetric === 'avgFirstResponse' ? ' 秒' : ' 次'}
            noun={trendScope === 'session' ? '次' : '天'}
            xLabel={trendScope === 'session' ? (point: any) => String(point.date) : undefined}
            label={
              trendMetric === 'avgScore'
                ? trendScope === 'session'
                  ? '本次总分'
                  : '日均总分'
                : trendMetric === 'avgFirstResponse'
                  ? trendScope === 'session'
                    ? '本次首响'
                    : '日均首响'
                  : '超时次数'
            }
            color={trendMetric === 'timeoutCount' ? '#d46b08' : '#2f6fe4'}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {trendScope === 'session' ? '今天' : '30 天'}共 {trend.summary.attempts} 次接待，达标{' '}
            {trend.summary.passCount} 次，平均分 {trend.summary.avgScore ?? '—'}，平均首响{' '}
            {trend.summary.avgFirstResponse ?? '—'} 秒，累计超时 {trend.summary.timeoutCount} 次。
            {trendScope === 'session' ? '（横轴是当天每次模拟的开始时间，点与点之间就是这一天的练习节奏）' : ''}
          </Typography.Text>
        </Card>
      )}

      {/**
       * 客户 2026-10-03：这里原来摆过「难度档位与快速开始」（错位），后来换成一张
       * 「自由练习已统一放在《在线模拟接待》里」的提示卡；客户 2026-10-03 当天又要求
       * **整块删掉**——《我的训练》只留「我的任务」与「我的最近接待」，不再放任何提示卡。
       * 客服仍然需要知道去哪开始训练，所以客服侧的「开始训练」卡保留。
       */}
      {!canFreePractice ? (
        <Card title="开始训练" bordered={false} className="page-card">
          <Alert
            type="info"
            showIcon
            message="模拟训练只对带教/管理员开放"
            description="你的训练由带教通过《回复模拟任务》下发；进入任务后从任务卡开始接待，难度与剧本范围都由任务决定。"
            action={
              <Button type="primary" size="small" onClick={() => navigate('/tasks')}>
                去我的任务
              </Button>
            }
          />
        </Card>
      ) : null}

      <Card title="我的最近接待" bordered={false} className="page-card">
        {overview?.recent?.length ? (
          <Table
            rowKey="id"
            pagination={false}
            dataSource={overview.recent}
            columns={[
              { title: '接待编号', dataIndex: 'attemptNo' },
              { title: '难度', dataIndex: 'level' },
              { title: '来源', dataIndex: 'source', render: (v) => (v === 'task' ? '任务训练' : '模拟训练') },
              { title: '得分', dataIndex: 'totalScore', render: (v) => (v === null ? '-' : `${v} 分`) },
              {
                title: '结论',
                dataIndex: 'conclusion',
                render: (v) => (v === 'pass' ? <Tag color="green">达标</Tag> : v === 'fail' ? <Tag color="red">未达标</Tag> : '-'),
              },
              { title: '开始时间', dataIndex: 'startedAt', render: (v) => new Date(v).toLocaleString('zh-CN') },
              {
                title: '操作',
                render: (_, row: any) => (
                  <Button type="link" onClick={() => navigate(`/records/${row.id}`)}>
                    查看明细
                  </Button>
                ),
              },
            ]}
          />
        ) : (
          <Empty description="还没有接待记录，先开始一次模拟接待吧" />
        )}
      </Card>
    </div>
  );
}
