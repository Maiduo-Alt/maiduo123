import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Button,
  Card,
  Empty,
  Input,
  List,
  Progress,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  ArrowLeftOutlined,
  BookOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  CustomerServiceOutlined,
  StarOutlined,
  UserOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { api } from '../api/client';
import { useAuth } from '../store/auth';
import OrderCard from '../components/OrderCard';

const FINISHED_REASON_LABEL: Record<string, string> = {
  manual: '正常收尾',
  normal: '全部答完',
  early: '提前结束',
  auto_timeout: '自动收尾',
  transferred: '已转人工',
  aborted: '异常中止',
};

const STAGE_LABEL: Record<string, string> = {
  opening: '开场阶段',
  discovery: '需求了解',
  clarification: '细节确认',
  decision: '下单决策',
  closing: '收尾阶段',
};

const INTENT_LABEL: Record<string, string> = {
  product_evaluation: '商品咨询',
  purchase_decision: '购买决策',
  order_service: '订单服务',
  aftersale_resolution: '售后处理',
  complaint_resolution: '投诉安抚',
};

function formatDurationRange(startedAt?: string, finishedAt?: string): string {
  if (!startedAt || !finishedAt) return '-';
  const sec = Math.max(0, Math.round((new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
}

function avgNumber(list: any[], key: string): number | null {
  const nums = list.map((item) => item?.[key]).filter((v) => v !== null && v !== undefined && Number.isFinite(Number(v))).map(Number);
  if (!nums.length) return null;
  return Math.round((nums.reduce((sum, n) => sum + n, 0) / nums.length) * 10) / 10;
}

export default function RecordDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { profile } = useAuth();
  /** 方案 2.2：明细转案例属带教能力，客服不可用 */
  const canManage = profile?.roleCode === 'admin' || profile?.roleCode === 'leader';
  const [data, setData] = useState<any>(null);
  /** 下部「会话明细」当前选中的买家页签（批注是一个固定页签） */
  const [activeBuyerTab, setActiveBuyerTab] = useState<string>('');
  const [annotation, setAnnotation] = useState('');
  const detailSectionRef = useRef<HTMLDivElement | null>(null);

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
  const isPass = attempt.conclusion === 'pass';

  const allDeductions = sessions.flatMap((s: any) =>
    (s.deductions || []).map((d: any, idx: number) => ({
      ...d,
      key: `${s.id}-${idx}`,
      sessionId: s.id,
      buyer: s.buyerName,
    })),
  );

  const totalTimeouts = sessions.reduce((sum: number, s: any) => sum + Number(s.timeoutCount || 0), 0);
  const avgRespSec = avgNumber(sessions, 'avgResponseSec');
  const avgResponseScore = avgNumber(sessions, 'responseScore');
  const avgSolvingScore = avgNumber(sessions, 'solvingScore');
  const avgWordingScore = avgNumber(sessions, 'wordingScore');
  const avgEmotionScore = avgNumber(sessions, 'emotionScore');

  const jumpToSession = (sessionId: number) => {
    setActiveBuyerTab(String(sessionId));
    setTimeout(() => {
      detailSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  };

  const sessionColumns = [
    {
      title: '买家',
      dataIndex: 'buyerName',
      width: 120,
      render: (v: string) => <span className="report-buyer-link">{v}</span>,
    },
    {
      title: '剧本',
      dataIndex: 'scriptName',
      ellipsis: true,
      render: (v: string) => v || <Typography.Text type="secondary">已删除剧本</Typography.Text>,
    },
    { title: '买家风格', dataIndex: 'styleName', width: 110 },
    {
      title: '有效题数',
      dataIndex: 'totalQuestions',
      width: 82,
      align: 'center' as const,
      render: (v: number, row: any) => Math.max(0, Number(v || 0) - (row.skippedSeqs || []).length),
    },
    {
      title: '超时',
      dataIndex: 'timeoutCount',
      width: 72,
      align: 'center' as const,
      render: (v: number) => (Number(v || 0) > 0 ? <Tag color="red">{v} 次</Tag> : <span className="report-muted">0</span>),
    },
    {
      title: '平均响应',
      dataIndex: 'avgResponseSec',
      width: 96,
      align: 'right' as const,
      render: (v: number | null | undefined) => (v === null || v === undefined ? '-' : `${v} 秒`),
    },
    { title: '响应时效', dataIndex: 'responseScore', width: 84, align: 'right' as const, render: (v: any) => v ?? '-' },
    { title: '问题解决', dataIndex: 'solvingScore', width: 84, align: 'right' as const, render: (v: any) => v ?? '-' },
    { title: '话术规范', dataIndex: 'wordingScore', width: 84, align: 'right' as const, render: (v: any) => v ?? '-' },
    { title: '情绪安抚', dataIndex: 'emotionScore', width: 84, align: 'right' as const, render: (v: any) => v ?? '-' },
    {
      title: '风险扣分',
      dataIndex: 'riskScore',
      width: 86,
      align: 'right' as const,
      render: (v: any) => (Number(v || 0) ? <span style={{ color: '#f04438', fontWeight: 600 }}>-{v}</span> : <span className="report-muted">0</span>),
    },
    {
      title: '会话得分',
      dataIndex: 'totalScore',
      width: 96,
      align: 'right' as const,
      render: (v: any) => {
        if (v === null || v === undefined) return '-';
        const num = Number(v);
        const color = num >= 80 ? 'green' : num >= 60 ? 'orange' : 'red';
        return <Tag color={color} className="report-score-pill">{num.toFixed(1)}</Tag>;
      },
    },
  ];

  const renderVerdictBadge = (m: any) => {
    if (m.sender !== 'agent') return null;
    if (m.ruleResult?.invalid) {
      return (
        <div className="report-msg-verdict invalid">
          <CloseCircleOutlined />
          <span>无效回复：{m.ruleResult.invalidReason || '命中无效判定规则'}</span>
        </div>
      );
    }
    const showJudgment =
      m.ruleResult?.judgmentVersion >= 1 &&
      !['opener', 'closing'].includes(m.ruleResult?.judge?.signal);
    if (!showJudgment && !m.ruleResult?.modelEvaluation && !m.ruleResult?.businessAction) return null;

    const status = m.ruleResult?.judgmentState === 'pending'
      ? { label: '判定中', cls: 'pending' }
      : m.ruleResult?.judgmentState === 'unavailable'
      ? { label: '判定未完成', cls: 'pending' }
      : m.ruleResult?.pendingVerification
      ? { label: '待核实', cls: 'pending' }
      : m.ruleResult?.replyAssessment?.status === 'partial'
      ? { label: '部分回答', cls: 'pending' }
      : m.ruleResult?.replyAssessment?.status === 'unsupported'
      ? { label: '信息待核对', cls: 'invalid' }
      : m.ruleResult?.judge?.pass
      ? { label: '已回答', cls: 'pass' }
      : { label: '未确认解决', cls: 'invalid' };

    const reason =
      m.ruleResult?.modelEvaluation?.reason ||
      m.ruleResult?.replyAssessment?.reason ||
      '';
    const sourceLabel = m.ruleResult?.modelEvaluation
      ? (m.ruleResult.modelEvaluation.decisionSource ? '规则' : '模型')
      : '';

    return (
      <div className="report-msg-verdict-wrap">
        {showJudgment && (
          <span className={`report-verdict-chip ${status.cls}`}>
            {status.cls === 'pass' ? <CheckCircleOutlined /> : status.cls === 'pending' ? <ClockCircleOutlined /> : <CloseCircleOutlined />}
            {status.label}
          </span>
        )}
        {reason && (
          <span className="report-verdict-reason">
            {sourceLabel ? `${sourceLabel}：` : ''}{reason}
          </span>
        )}
        {m.ruleResult?.businessAction && (
          <Tag color="blue" style={{ margin: 0 }}>业务动作：{m.ruleResult.businessAction.name}</Tag>
        )}
        {m.ruleResult?.hitPoints?.length > 0 && (
          <Tag color="green" style={{ margin: 0 }}>命中：{m.ruleResult.hitPoints.join('、')}</Tag>
        )}
        {m.ruleResult?.missingPoints?.length > 0 && (
          <Tag color="orange" style={{ margin: 0 }}>缺失：{m.ruleResult.missingPoints.join('、')}</Tag>
        )}
      </div>
    );
  };

  const renderConversation = (sessionId: number) => {
    const list = messages.filter((m: any) => m.sessionId === sessionId);
    if (!list.length) return <Empty description="该会话没有消息记录" />;
    return (
      <div className="report-chat-box">
        {list.map((m: any) => {
          const isAgent = m.sender === 'agent';
          const isSystem = m.sender === 'system';
          return (
            <div key={m.id} className={`report-msg-row ${isAgent ? 'agent' : isSystem ? 'system' : 'buyer'}`}>
              <div className={`report-msg-avatar ${isAgent ? 'agent' : isSystem ? 'system' : 'buyer'}`}>
                {isAgent ? <CustomerServiceOutlined /> : isSystem ? '系' : <UserOutlined />}
              </div>
              <div className="report-msg-body">
                <div className="report-msg-meta">
                  <span className="report-msg-sender">{isAgent ? '客服' : isSystem ? '系统' : '买家'}</span>
                  <span>{new Date(m.createdAt).toLocaleTimeString('zh-CN')}</span>
                  {m.responseSec !== null && isAgent && (
                    <span className={`report-resp-chip ${m.isTimeout ? 'timeout' : ''}`}>
                      响应 {m.responseSec}s{m.isTimeout ? ' · 超时' : ''}
                    </span>
                  )}
                </div>
                <div className="report-msg-bubble">{m.content}</div>
                {renderVerdictBadge(m)}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const dimensions = [
    { label: '响应时效', value: avgResponseScore, max: 40, color: '#1e6fff' },
    { label: '问题解决', value: avgSolvingScore, max: 35, color: '#12b76a' },
    { label: '话术规范', value: avgWordingScore, max: 15, color: '#7a5af8' },
    { label: '情绪安抚', value: avgEmotionScore, max: 10, color: '#f79009' },
  ];

  return (
    <div className="report-page">
      {/* 顶部标题与操作栏 */}
      <div className="report-header-bar">
        <div className="report-header-left">
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/records')}>
            返回列表
          </Button>
          <div className="report-title-group">
            <span className="report-attempt-no">{attempt.attempt_no}</span>
            <Tag color="blue">{attempt.level}</Tag>
            <Tag color={isPass ? 'green' : 'red'} icon={isPass ? <CheckCircleOutlined /> : <CloseCircleOutlined />}>
              {isPass ? '达标' : '未达标'}
            </Tag>
            <Tag>{attempt.source === 'task' ? '任务训练' : '模拟训练'}</Tag>
          </div>
        </div>
        <div className="report-header-right">
          <span className="report-time-meta">
            <ClockCircleOutlined /> {new Date(attempt.started_at).toLocaleString('zh-CN')} · 用时 {formatDurationRange(attempt.started_at, attempt.finished_at)}
          </span>
          {canManage && (
            <Space size={8}>
              <Button
                size="small"
                icon={<BookOutlined />}
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
              <Button
                size="small"
                type="primary"
                icon={<StarOutlined />}
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
                标记典型案例
              </Button>
            </Space>
          )}
        </div>
      </div>

      {/* 总览卡片：左总分环 + 右四维度均分 & 关键指标 */}
      <div className="report-hero-grid">
        <div className="report-score-panel">
          <Progress
            type="dashboard"
            size={148}
            strokeWidth={9}
            percent={Math.min(100, Math.max(0, totalScore ?? 0))}
            strokeColor={isPass ? '#12b76a' : (totalScore ?? 0) >= 60 ? '#f79009' : '#f04438'}
            trailColor="#eef2f6"
            format={() => (
              <div className="report-ring-inner">
                <div className="report-ring-value">{totalScore === null ? '-' : totalScore.toFixed(1)}</div>
                <div className="report-ring-label">综合总分</div>
              </div>
            )}
          />
          <div className="report-score-meta">
            <div className="report-mini-stat">
              <span>接待会话</span>
              <b>{sessions.length} 组</b>
            </div>
            <div className="report-mini-stat">
              <span>平均响应</span>
              <b>{avgRespSec === null ? '-' : `${avgRespSec} 秒`}</b>
            </div>
            <div className="report-mini-stat">
              <span>累计超时</span>
              <b style={{ color: totalTimeouts > 0 ? '#f04438' : '#12b76a' }}>{totalTimeouts} 次</b>
            </div>
            <div className="report-mini-stat">
              <span>失分项</span>
              <b style={{ color: allDeductions.length > 0 ? '#f79009' : '#12b76a' }}>{allDeductions.length} 处</b>
            </div>
          </div>
        </div>

        <div className="report-dim-panel">
          <div className="report-panel-head">
            <span>四维度平均得分</span>
            <span className="report-panel-sub">
              结束时间：{attempt.finished_at ? new Date(attempt.finished_at).toLocaleString('zh-CN') : '-'}
            </span>
          </div>
          <div className="report-dim-list">
            {dimensions.map((dim) => {
              const pct = dim.value === null ? 0 : Math.min(100, Math.round((dim.value / dim.max) * 100));
              return (
                <div key={dim.label} className="report-dim-row">
                  <div className="report-dim-top">
                    <span className="report-dim-name">{dim.label}</span>
                    <span className="report-dim-num">
                      <b>{dim.value === null ? '-' : dim.value.toFixed(1)}</b>
                      <span> / {dim.max}</span>
                    </span>
                  </div>
                  <div className="report-dim-track">
                    <div className="report-dim-fill" style={{ width: `${pct}%`, background: dim.color }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* 各会话评分表 */}
      <Card
        bordered={false}
        className="page-card"
        title="各会话评分明细"
        extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>点击任意买家行可直接定位到下方对话复盘</Typography.Text>}
      >
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={sessions}
          columns={sessionColumns}
          scroll={{ x: 960 }}
          rowClassName="report-clickable-row"
          onRow={(record: any) => ({
            onClick: () => jumpToSession(record.id),
          })}
        />
      </Card>

      {/* 失分明细：紧凑两列网格卡片 */}
      <Card
        bordered={false}
        className="page-card"
        title={
          <Space size={8}>
            <WarningOutlined style={{ color: '#f79009' }} />
            <span>失分明细</span>
            <Tag color={allDeductions.length ? 'orange' : 'green'}>{allDeductions.length} 项</Tag>
          </Space>
        }
        extra={allDeductions.length > 0 && <Typography.Text type="secondary" style={{ fontSize: 12 }}>点击失分项可跳转至对应会话</Typography.Text>}
      >
        {allDeductions.length ? (
          <div className="report-deductions-grid">
            {allDeductions.map((item: any) => (
              <div
                key={item.key}
                className="report-deduction-item"
                onClick={() => jumpToSession(item.sessionId)}
              >
                <div className="report-deduction-head">
                  <Tag style={{ margin: 0 }}>{item.buyer}</Tag>
                  <Tag color="orange" className="report-deduction-pts">-{item.points} 分</Tag>
                </div>
                <div className="report-deduction-reason">{item.reason}</div>
              </div>
            ))}
          </div>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本次没有失分项，表现很棒！" />
        )}
      </Card>

      {/* 会话明细回放 + 复盘批注 */}
      <div ref={detailSectionRef}>
        <Card bordered={false} className="page-card" title="会话复盘明细">
          <Tabs
            type="card"
            activeKey={activeBuyerTab || String(sessions[0]?.id ?? '')}
            onChange={setActiveBuyerTab}
            items={[
              ...sessions.map((s: any) => ({
                key: String(s.id),
                label: (
                  <span className="report-tab-label">
                    <span>{s.buyerName}</span>
                    <span className={`report-tab-score ${(s.totalScore ?? 0) >= 80 ? 'good' : (s.totalScore ?? 0) >= 60 ? 'mid' : 'low'}`}>
                      {s.totalScore === null || s.totalScore === undefined ? '-' : `${Number(s.totalScore).toFixed(1)}`}
                    </span>
                  </span>
                ),
                children: (
                  <div className="report-session-split">
                    <div className="report-session-main">
                      {/* 紧凑会话摘要卡 */}
                      <div className="report-session-summary">
                        <div className="report-summary-row">
                          <div className="report-summary-kv">
                            <span>剧本</span>
                            <b>{s.scriptName || '已删除剧本'}</b>
                          </div>
                          <div className="report-summary-kv">
                            <span>买家风格</span>
                            <b>{s.styleName}</b>
                          </div>
                          <div className="report-summary-kv">
                            <span>结束原因</span>
                            <b>{FINISHED_REASON_LABEL[s.finishedReason] || s.finishedReason || '-'}</b>
                          </div>
                          <div className="report-summary-kv">
                            <span>最终阶段</span>
                            <b>{STAGE_LABEL[s.conversationState?.conversationStage] || s.conversationState?.conversationStage || '-'}</b>
                          </div>
                          <div className="report-summary-kv">
                            <span>客户意图</span>
                            <b>{INTENT_LABEL[s.conversationState?.customerIntent] || s.conversationState?.customerIntent || '-'}</b>
                          </div>
                        </div>

                        <div className="report-summary-metrics">
                          <div className="report-metric-pill">
                            <span>解决度</span>
                            <b>{s.conversationState?.resolutionScore !== undefined ? `${s.conversationState.resolutionScore}%` : '-'}</b>
                          </div>
                          <div className="report-metric-pill">
                            <span>满意度</span>
                            <b>{s.conversationState?.satisfaction !== undefined ? `${s.conversationState.satisfaction}/100` : '-'}</b>
                          </div>
                          <div className="report-metric-pill">
                            <span>购买意愿</span>
                            <b>{s.conversationState?.purchaseIntent !== undefined ? `${s.conversationState.purchaseIntent}/100` : '-'}</b>
                          </div>
                          <Space size={6} wrap style={{ marginLeft: 'auto' }}>
                            <Tag color="green">已解决 {s.conversationState?.resolvedGoalIds?.length || 0}</Tag>
                            <Tag color="orange">部分解决 {s.conversationState?.partialGoalIds?.length || 0}</Tag>
                            <Tag color={(s.conversationState?.unresolvedGoalIds?.length || 0) > 0 ? 'red' : 'default'}>
                              未解决 {s.conversationState?.unresolvedGoalIds?.length || 0}
                            </Tag>
                            {(s.skippedSeqs || []).length ? <Tag color="blue">自然跳过 {(s.skippedSeqs || []).length}</Tag> : null}
                          </Space>
                        </div>

                        {(s.conversationState?.customerGoal || s.conversationState?.pendingConcern || actionsOfSession(s.id).length > 0) && (
                          <div className="report-summary-foot">
                            {s.conversationState?.customerGoal && (
                              <span>核心目标：<b>{s.conversationState.customerGoal}</b></span>
                            )}
                            {s.conversationState?.pendingConcern && (
                              <span>待解决顾虑：<b>{s.conversationState.pendingConcern}</b></span>
                            )}
                            {actionsOfSession(s.id).length > 0 && (
                              <Space size={4} wrap>
                                <span>业务动作：</span>
                                {actionsOfSession(s.id).map((item) => (
                                  <Tag key={item.id} color="blue" style={{ margin: 0 }}>{item.actionName}</Tag>
                                ))}
                              </Space>
                            )}
                          </div>
                        )}
                      </div>

                      {renderConversation(s.id)}
                    </div>

                    <div className="report-session-side">
                      {s.orderPayload ? (
                        <OrderCard order={s.orderPayload} product={Array.isArray(s.products) ? s.products[0] : null} />
                      ) : (
                        <div className="report-empty-order">
                          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本次会话没有订单" />
                        </div>
                      )}
                    </div>
                  </div>
                ),
              })),
              {
                key: 'annotations',
                label: `复盘批注（${annotations.length}）`,
                children: (
                  <div className="report-annotations">
                    <Space.Compact style={{ width: '100%', marginBottom: 16 }}>
                      <Input
                        value={annotation}
                        onChange={(e) => setAnnotation(e.target.value)}
                        onPressEnter={submitAnnotation}
                        placeholder="写下你的复盘结论或对本次接待的评价"
                      />
                      <Button type="primary" onClick={submitAnnotation}>
                        添加批注
                      </Button>
                    </Space.Compact>
                    {annotations.length ? (
                      <List
                        dataSource={annotations}
                        renderItem={(item: any) => (
                          <List.Item>
                            <List.Item.Meta
                              title={
                                <Space>
                                  <Typography.Text strong>{item.authorName}</Typography.Text>
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
                    ) : (
                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无复盘批注" />
                    )}
                  </div>
                ),
              },
            ]}
          />
        </Card>
      </div>
    </div>
  );
}
