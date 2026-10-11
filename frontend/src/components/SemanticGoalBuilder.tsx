import { Alert, Button, Card, Collapse, Form, Input, InputNumber, Select, Space, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';

const expressionsInput = {
  mode: 'tags' as const,
  tokenSeparators: [',', '，', ';', '；'],
  placeholder: '输入一种说法后按回车，例如：标准尺码',
};

/** 将运行时的轮次目标转换成运营人员可直接编辑的表单字段。 */
export function semanticQuestionsToRows(questionSeq: any[] = []) {
  return questionSeq.flatMap((question) =>
    (question.semanticGoals || []).map((goal: any) => ({
      seq: question.seq,
      name: goal.name,
      points: (goal.requiredPoints || []).map((point: any) => ({
        label: point.label,
        matchAny: point.matchAny || [],
        mustIncludeAll: point.businessRules?.mustIncludeAll || [],
        mustIncludeAny: point.businessRules?.mustIncludeAny || [],
        mustExclude: point.businessRules?.mustExclude || [],
      })),
      riskRules: (goal.riskRules || []).map((rule: any) => ({
        label: rule.label,
        matchAny: rule.matchAny || [],
        penalty: rule.penalty ?? 15,
      })),
    }))
  );
}

/** 表单值转成后端语义目标结构；自动生成 id，用户无需接触 JSON 或标识符。 */
export function semanticRowsToGoalsBySeq(rows: any[] = []): Record<string, any[]> {
  if (!rows.length) throw new Error('请至少添加一个语义目标');
  const result: Record<string, any[]> = {};
  rows.forEach((row, goalIndex) => {
    const seq = Number(row.seq);
    if (!Number.isInteger(seq) || seq < 1 || seq > 10) throw new Error('请选择 1 到 10 轮的问题');
    if (!String(row.name || '').trim()) throw new Error(`第 ${goalIndex + 1} 个目标需要填写名称`);
    if (!Array.isArray(row.points) || !row.points.length) throw new Error(`“${row.name}”至少添加一个必答要点`);
    const goalId = `goal-${seq}-${goalIndex + 1}`;
    const requiredPoints = row.points.map((point: any, pointIndex: number) => {
      const matchAny = (point.matchAny || []).map((item: string) => String(item).trim()).filter(Boolean);
      if (!String(point.label || '').trim()) throw new Error(`“${row.name}”有要点名称未填写`);
      if (!matchAny.length) throw new Error(`“${point.label}”至少添加一种认可说法`);
      const businessRules: Record<string, string[]> = {};
      for (const key of ['mustIncludeAll', 'mustIncludeAny', 'mustExclude']) {
        const values = (point[key] || []).map((item: string) => String(item).trim()).filter(Boolean);
        if (values.length) businessRules[key] = values;
      }
      return {
        id: `point-${seq}-${goalIndex + 1}-${pointIndex + 1}`,
        label: String(point.label).trim(),
        matchAny,
        ...(Object.keys(businessRules).length ? { businessRules } : {}),
      };
    });
    const riskRules = (row.riskRules || []).map((risk: any, riskIndex: number) => {
      const matchAny = (risk.matchAny || []).map((item: string) => String(item).trim()).filter(Boolean);
      if (!String(risk.label || '').trim()) throw new Error(`“${row.name}”有风险项名称未填写`);
      if (!matchAny.length) throw new Error(`风险项“${risk.label}”至少添加一种触发表达`);
      return {
        id: `risk-${seq}-${goalIndex + 1}-${riskIndex + 1}`,
        label: String(risk.label).trim(),
        matchAny,
        penalty: Math.max(0, Number(risk.penalty ?? 15)),
      };
    });
    (result[String(seq)] ||= []).push({
      id: goalId,
      name: String(row.name).trim(),
      requiredPoints,
      ...(riskRules.length ? { riskRules } : {}),
    });
  });
  return result;
}

export default function SemanticGoalBuilder({
  name = 'semanticGoalRows',
  roundLabels = {},
}: {
  name?: string;
  roundLabels?: Record<number, string>;
}) {
  return (
    <>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="用日常说法配置客服需要覆盖的内容"
        description="填写目标名称、必答要点和几种认可说法即可，不需要写代码。未配置的轮次继续使用关键词规则；可选添加严格核验条件与风险扣分项。"
      />
      <Form.List name={name}>
        {(goals, goalOps) => (
          <Space direction="vertical" style={{ width: '100%' }} size={12}>
            {goals.map((goal, goalIndex) => (
              <Card
                key={goal.key}
                size="small"
                title={`目标 ${goalIndex + 1}`}
                extra={<Button type="text" danger icon={<DeleteOutlined />} onClick={() => goalOps.remove(goal.name)}>删除</Button>}
              >
                <Space align="start" wrap style={{ width: '100%' }}>
                  <Form.Item
                    name={[goal.name, 'seq']}
                    label="应用轮次"
                    rules={[{ required: true, message: '请选择轮次' }]}
                  >
                    <Select
                      style={{ width: 150 }}
                      placeholder="选择问题轮次"
                      options={Array.from({ length: 10 }, (_, i) => ({
                        value: i + 1,
                        label: roundLabels[i + 1] ? `第 ${i + 1} 轮：${roundLabels[i + 1]}` : `第 ${i + 1} 轮`,
                      }))}
                    />
                  </Form.Item>
                  <Form.Item
                    name={[goal.name, 'name']}
                    label="客服需要达成的目标"
                    rules={[{ required: true, message: '请填写目标' }]}
                    style={{ flex: 1, minWidth: 260 }}
                  >
                    <Input placeholder="例如：说明商品尺码正常" maxLength={80} />
                  </Form.Item>
                </Space>

                <Typography.Text strong>客服需要说明的要点</Typography.Text>
                <Form.List name={[goal.name, 'points']}>
                  {(points, pointOps) => (
                    <Space direction="vertical" style={{ width: '100%', marginTop: 8 }} size={8}>
                      {points.map((point, pointIndex) => (
                        <Card key={point.key} size="small" type="inner">
                          <Space align="start" style={{ width: '100%' }}>
                            <Form.Item
                              name={[point.name, 'label']}
                              label={`要点 ${pointIndex + 1}`}
                              rules={[{ required: true, message: '请描述要说明的内容' }]}
                              style={{ width: 230 }}
                            >
                              <Input placeholder="例如：说明尺码不偏大" />
                            </Form.Item>
                            <Form.Item
                              name={[point.name, 'matchAny']}
                              label="认可的说法（回车添加）"
                              rules={[{ required: true, message: '至少添加一种说法' }]}
                              style={{ flex: 1 }}
                            >
                              <Select {...expressionsInput} />
                            </Form.Item>
                            <Button
                              type="text"
                              danger
                              icon={<DeleteOutlined />}
                              aria-label="删除要点"
                              style={{ marginTop: 30 }}
                              onClick={() => pointOps.remove(point.name)}
                            />
                          </Space>
                          <Collapse
                            size="small"
                            items={[{
                              key: 'rules',
                              label: '可选：补充核验条件，减少误判',
                              children: (
                                <Space wrap style={{ width: '100%' }}>
                                  <Form.Item name={[point.name, 'mustIncludeAll']} label="回复必须同时包含">
                                    <Select {...expressionsInput} style={{ minWidth: 260 }} />
                                  </Form.Item>
                                  <Form.Item name={[point.name, 'mustIncludeAny']} label="回复还需包含任一词">
                                    <Select {...expressionsInput} style={{ minWidth: 260 }} />
                                  </Form.Item>
                                  <Form.Item name={[point.name, 'mustExclude']} label="排除这些说法">
                                    <Select {...expressionsInput} style={{ minWidth: 260 }} />
                                  </Form.Item>
                                </Space>
                              ),
                            }]}
                          />
                        </Card>
                      ))}
                      <Button
                        type="dashed"
                        icon={<PlusOutlined />}
                        onClick={() => pointOps.add({ matchAny: [] })}
                        block
                      >
                        添加必答要点
                      </Button>
                    </Space>
                  )}
                </Form.List>

                <Collapse
                  size="small"
                  style={{ marginTop: 12 }}
                  items={[{
                    key: 'risks',
                    label: '添加错误承诺等风险项（可选）',
                    children: (
                      <Form.List name={[goal.name, 'riskRules']}>
                        {(risks, riskOps) => (
                          <Space direction="vertical" style={{ width: '100%' }}>
                            {risks.map((risk, riskIndex) => (
                              <Space key={risk.key} align="start" wrap>
                                <Form.Item
                                  name={[risk.name, 'label']}
                                  label={`风险项 ${riskIndex + 1}`}
                                  rules={[{ required: true, message: '请填写风险说明' }]}
                                  style={{ width: 220 }}
                                >
                                  <Input placeholder="例如：承诺无条件退货" />
                                </Form.Item>
                                <Form.Item
                                  name={[risk.name, 'matchAny']}
                                  label="触发表达（回车添加）"
                                  rules={[{ required: true, message: '至少添加一种触发表达' }]}
                                  style={{ minWidth: 280, flex: 1 }}
                                >
                                  <Select {...expressionsInput} />
                                </Form.Item>
                                <Form.Item name={[risk.name, 'penalty']} label="扣分">
                                  <InputNumber min={0} max={100} addonAfter="分" />
                                </Form.Item>
                                <Button
                                  type="text"
                                  danger
                                  icon={<DeleteOutlined />}
                                  aria-label="删除风险项"
                                  style={{ marginTop: 30 }}
                                  onClick={() => riskOps.remove(risk.name)}
                                />
                              </Space>
                            ))}
                            <Button type="dashed" icon={<PlusOutlined />} onClick={() => riskOps.add({ matchAny: [], penalty: 15 })}>
                              添加风险项
                            </Button>
                          </Space>
                        )}
                      </Form.List>
                    ),
                  }]}
                />
              </Card>
            ))}
            <Button
              type="dashed"
              icon={<PlusOutlined />}
              onClick={() => goalOps.add({ seq: 1, points: [{ matchAny: [] }], riskRules: [] })}
              block
            >
              添加一个轮次目标
            </Button>
          </Space>
        )}
      </Form.List>
    </>
  );
}
