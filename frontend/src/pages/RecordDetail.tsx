import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Input,
  List,
  Progress,
  Row,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { api } from '../api/client';
import { useAuth } from '../store/auth';

export default function RecordDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { profile } = useAuth();
  /** 方案 2.2：明细转案例属带教能力，客服不可用 */
  const canManage = profile?.roleCode === 'admin' || profile?.roleCode === 'leader';
  const [data, setData] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<string>('report');
  const [annotation, setAnnotation] = useState('');

  const load = async () => {
    const detail = await api<any>(`/records/${id}`);
    setData(detail);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const submitAnnotation = async () => {
    if (!annotation.trim()) return;
    try {
      await api(`/records/${id}/annotations`, { method: 'POST', body: { content: annotation.trim() } });
      setAnnotation('');
      message.success('批注已保存');
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  if (!data) return <Card loading bordered={false} />;

  const { attempt, sessions, messages, annotations } = data;
  /** 客户 2026-10-03：订单卡片上的平台侧操作（催付 / 改价 / 去发货…）逐条登记，复盘时能对上 */
  const businessActions: any[] = data.businessActions || [];
  const actionsOfSession = (sessionId: number) => businessActions.filter((a) => a.sessionId === sessionId);
  const totalScore = attempt.total_score === null ? null : Number(attempt.total_score);

  const sessionColumns = [
    { title: '买家', dataIndex: 'buyerName', width: 120 },
    { title: '剧本', dataIndex: 'scriptName', ellipsis: true },
    { title: '买家风格', dataIndex: 'styleName', width: 120 },
    { title: '问题数', dataIndex: 'totalQuestions', width: 80 },
    { title: '超时', dataIndex: 'timeoutCount', width: 70 },
    { title: '情绪值', dataIndex: 'emotionValue', width: 80 },
    { title: '响应时效', dataIndex: 'responseScore', width: 90, render: (v) => v ?? '-' },
    { title: '问题解决', dataIndex: 'solvingScore', width: 90, render: (v) => v ?? '-' },
    { title: '话术规范', dataIndex: 'wordingScore', width: 90, render: (v) => v ?? '-' },
    { title: '情绪安抚', dataIndex: 'emotionScore', width: 90, render: (v) => v ?? '-' },
    {
      title: '会话得分',
      dataIndex: 'totalScore',
      width: 100,
      render: (v) => (v === null ? '-' : <Typography.Text strong>{Number(v).toFixed(1)}</Typography.Text>),
    },
  ];

  const renderConversation = (sessionId: number) => {
    const list = messages.filter((m: any) => m.sessionId === sessionId);
    if (!list.length) return <Empty description="该会话没有消息记录" />;
    return (
      <div>
        {list.map((m: any) => (
          <div
            key={m.id}
            style={{
              display: 'flex',
              marginBottom: 12,
              justifyContent: m.sender === 'agent' ? 'flex-end' : 'flex-start',
            }}
          >
            <div
              style={{
                maxWidth: '62%',
                padding: '9px 12px',
                borderRadius: 10,
                fontSize: 13,
                lineHeight: 1.6,
                background: m.sender === 'agent' ? '#d9ecff' : m.sender === 'system' ? '#fff7e6' : '#fff',
                border: `1px solid ${m.sender === 'agent' ? '#b7dbff' : m.sender === 'system' ? '#ffe7ba' : '#eef0f5'}`,
              }}
            >
              <div>{m.content}</div>
              <div style={{ fontSize: 11, color: '#8c8c8c', marginTop: 4 }}>
                {m.sender === 'buyer' ? '买家' : m.sender === 'agent' ? '客服' : '系统'} ·{' '}
                {new Date(m.createdAt).toLocaleTimeString('zh-CN')}
                {m.responseSec !== null && m.sender === 'agent' && ` · 响应 ${m.responseSec}s`}
                {m.isTimeout && <span style={{ color: '#cf1322' }}> · 超时</span>}
                {m.ruleResult?.businessAction && (
                  <span style={{ color: '#1677ff' }}> · 业务动作：{m.ruleResult.businessAction.name}</span>
                )}
                {m.ruleResult?.invalid && (
                  <span style={{ color: '#cf1322' }}>
                    {' '}
                    · 被判无效回复：{m.ruleResult.invalidReason || '命中无效判定规则'}
                  </span>
                )}
                {m.ruleResult?.hitPoints?.length > 0 && (
                  <span style={{ color: '#389e0d' }}> · 命中：{m.ruleResult.hitPoints.join('、')}</span>
                )}
                {m.ruleResult?.missingPoints?.length > 0 && (
                  <span style={{ color: '#d46b08' }}> · 缺失：{m.ruleResult.missingPoints.join('、')}</span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card bordered={false} className="page-card">
        <Space style={{ marginBottom: 12 }}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/records')}>
            返回列表
          </Button>
          <Typography.Title level={5} style={{ margin: 0 }}>
            {attempt.attempt_no} · {attempt.level} 接待明细
          </Typography.Title>
          {attempt.conclusion === 'pass' ? <Tag color="green">达标</Tag> : <Tag color="red">未达标</Tag>}
          {canManage && (
            <Button
              size="small"
              onClick={async () => {
                try {
                  const res = await api<any>('/cases/from-attempt', { method: 'POST', body: { attemptId: Number(id) } });
                  message.success(`已推入案例收藏（${res.messageCount} 条消息），可在案例页补充标签`);
                } catch (e) {
                  message.error((e as Error).message);
                }
              }}
            >
              转为案例
            </Button>
          )}
          {canManage && (
            <Button
              size="small"
              type="primary"
              onClick={async () => {
                try {
                  const res = await api<any>('/cases/from-attempt', {
                    method: 'POST',
                    body: { attemptId: Number(id), highlight: true },
                  });
                  message.success(`已标记为典型案例（${res.messageCount} 条消息），可在案例页按「典型案例」标签筛选`);
                } catch (e) {
                  message.error((e as Error).message);
                }
              }}
            >
              标记为典型案例
            </Button>
          )}
        </Space>
        <Row gutter={16}>
          <Col span={4}>
            <Statistic title="总分" value={totalScore ?? 0} precision={1} suffix="分" />
          </Col>
          <Col span={4}>
            <Statistic title="会话数" value={sessions.length} />
          </Col>
          <Col span={4}>
            <Statistic title="来源" value={attempt.source === 'task' ? '任务训练' : '模拟训练'} />
          </Col>
          <Col span={6}>
            <Statistic title="开始时间" value={new Date(attempt.started_at).toLocaleString('zh-CN')} valueStyle={{ fontSize: 16 }} />
          </Col>
          <Col span={6}>
            <Statistic
              title="结束时间"
              value={attempt.finished_at ? new Date(attempt.finished_at).toLocaleString('zh-CN') : '-'}
              valueStyle={{ fontSize: 16 }}
            />
          </Col>
        </Row>
        <Progress
          style={{ marginTop: 12 }}
          percent={Math.min(100, totalScore ?? 0)}
          format={() => `${totalScore ?? 0} 分`}
          strokeColor={(totalScore ?? 0) >= 80 ? '#52c41a' : '#faad14'}
        />
      </Card>

      <Card bordered={false} className="page-card">
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={[
            {
              key: 'report',
              label: '评分报告',
              children: (
                <>
                  <Table rowKey="id" size="small" pagination={false} dataSource={sessions} columns={sessionColumns} />
                  <div style={{ marginTop: 16 }}>
                    <Typography.Title level={5}>失分明细</Typography.Title>
                    {sessions.flatMap((s: any) => (s.deductions || []).map((d: any) => ({ ...d, buyer: s.buyerName })))
                      .length ? (
                      <List
                        size="small"
                        dataSource={sessions.flatMap((s: any) =>
                          (s.deductions || []).map((d: any) => ({ ...d, buyer: s.buyerName }))
                        )}
                        renderItem={(item: any) => (
                          <List.Item>
                            <Space>
                              <Tag>{item.buyer}</Tag>
                              <Tag color="orange">-{item.points} 分</Tag>
                              <span>{item.reason}</span>
                            </Space>
                          </List.Item>
                        )}
                      />
                    ) : (
                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本次没有失分项" />
                    )}
                  </div>
                </>
              ),
            },
            {
              key: 'replay',
              label: '会话回放',
              children: (
                <Tabs
                  type="card"
                  items={sessions.map((s: any) => ({
                    key: String(s.id),
                    label: `${s.buyerName}（${s.totalScore ?? '-'} 分）`,
                    children: (
                      <>
                        <Descriptions size="small" column={3} style={{ marginBottom: 12 }}>
                          <Descriptions.Item label="剧本">{s.scriptName}</Descriptions.Item>
                          <Descriptions.Item label="买家风格">{s.styleName}</Descriptions.Item>
                          <Descriptions.Item label="结束原因">{s.finishedReason || '-'}</Descriptions.Item>
                          <Descriptions.Item label={`业务动作（${actionsOfSession(s.id).length}）`} span={3}>
                            {actionsOfSession(s.id).length ? (
                              <Space size={4} wrap>
                                {actionsOfSession(s.id).map((item) => (
                                  <Tag key={item.id} color="blue">
                                    {item.actionName}
                                  </Tag>
                                ))}
                              </Space>
                            ) : (
                              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                这次接待没有点过平台侧业务动作
                              </Typography.Text>
                            )}
                          </Descriptions.Item>
                        </Descriptions>
                        {renderConversation(s.id)}
                      </>
                    ),
                  }))}
                />
              ),
            },
            {
              key: 'annotation',
              label: `复盘批注（${annotations.length}）`,
              children: (
                <>
                  <Space.Compact style={{ width: '100%', marginBottom: 12 }}>
                    <Input
                      value={annotation}
                      onChange={(e) => setAnnotation(e.target.value)}
                      placeholder="写下你的复盘结论或对本次接待的评价"
                    />
                    <Button type="primary" onClick={submitAnnotation}>
                      添加批注
                    </Button>
                  </Space.Compact>
                  <List
                    dataSource={annotations}
                    renderItem={(item: any) => (
                      <List.Item>
                        <List.Item.Meta
                          title={
                            <Space>
                              <span>{item.authorName}</span>
                              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                {new Date(item.createdAt).toLocaleString('zh-CN')}
                              </Typography.Text>
                            </Space>
                          }
                          description={item.content}
                        />
                      </List.Item>
                    )}
                  />
                </>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
