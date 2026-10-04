import { useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Divider, Form, InputNumber, Row, Select, Space, Switch, Typography, message } from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import { api } from '../api/client';
import { useAuth } from '../store/auth';

export default function Settings() {
  const { profile } = useAuth();
  const [params, setParams] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const readOnly = profile?.roleCode !== 'admin';

  const load = async () => {
    const data = await api<any>('/settings');
    setParams(data);
    form.setFieldsValue({
      firstResponseLimitSec: data.firstResponseLimitSec,
      avgResponseLimitSec: data.avgResponseLimitSec,
      replyRateLimitPct: data.replyRateLimitPct,
      timeoutSec: data.timeoutSec,
      timeoutPenalty: data.timeoutPenalty,
      response: data.weights.response,
      solving: data.weights.solving,
      wording: data.weights.wording,
      emotion: data.weights.emotion,
      passLine: data.passLine,
      unlockConsecutive: data.unlockConsecutive,
      maxConcurrent: data.maxConcurrent,
      concurrentL1: data.levelConcurrent?.L1 ?? 1,
      concurrentL2: data.levelConcurrent?.L2 ?? 2,
      concurrentL3: data.levelConcurrent?.L3 ?? 3,
      concurrentL4: data.levelConcurrent?.L4 ?? 4,
      // 总接待人数：客户 2026-10-03 口径默认 10 人，管理员可提前按档位设置
      totalL1: data.levelTotal?.L1 ?? 10,
      totalL2: data.levelTotal?.L2 ?? 10,
      totalL3: data.levelTotal?.L3 ?? 10,
      totalL4: data.levelTotal?.L4 ?? 10,
      roundsMin: data.levelRounds[0],
      roundsMax: data.levelRounds[1],
      joinMin: data.levelJoinDelaySec[0],
      joinMax: data.levelJoinDelaySec[1],
      emotionEscalateThreshold: data.emotionEscalateThreshold,
      messageMaxLength: data.messageMaxLength,
      aftersaleQuestionRatio: data.aftersaleQuestionRatio ?? 20,
      disconnectGraceSec: data.disconnectGraceSec,
      hintMode: data.hintMode,
      invalidReplyEnabled: data.invalidReplyEnabled,
      invalidReplyDuplicateMode: data.invalidReplyDuplicateMode || 'streak',
      invalidReplyDuplicateStreak: data.invalidReplyDuplicateStreak ?? 3,
      invalidReplyUnresolvedEnabled: data.invalidReplyUnresolvedEnabled,
      invalidReplyUnresolvedStreak: data.invalidReplyUnresolvedStreak ?? 3,
      banalWords: data.banalWords || [],
      hintDelaySec: data.hintDelaySec,
      loginMaxFailures: data.loginMaxFailures,
      loginLockMinutes: data.loginLockMinutes,
      passwordMaxAgeDays: data.passwordMaxAgeDays,
    });
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    const values = await form.validateFields();
    const weightSum = values.response + values.solving + values.wording + values.emotion;
    if (weightSum !== 100) {
      message.error(`评分权重之和必须等于 100，当前为 ${weightSum}`);
      return;
    }
    setSaving(true);
    try {
      // 接入人数被清空时不提交该档，保留原值（否则 null 会被后端当成 0 而报错）
      const levelConcurrent = Object.fromEntries(
        (
          [
            ['L1', values.concurrentL1],
            ['L2', values.concurrentL2],
            ['L3', values.concurrentL3],
            ['L4', values.concurrentL4],
          ] as [string, number | null | undefined][]
        ).filter(([, value]) => value !== null && value !== undefined && `${value}` !== '')
      );
      // 本次模拟总接待人数（C5）：清空时提交 10（客户口径的默认值）
      const levelTotal = Object.fromEntries(
        (
          [
            ['L1', values.totalL1],
            ['L2', values.totalL2],
            ['L3', values.totalL3],
            ['L4', values.totalL4],
          ] as [string, number | null | undefined][]
        ).map(([code, value]) => [
          code,
          value === null || value === undefined || `${value}` === '' ? 10 : Number(value),
        ])
      );
      await api('/settings', {
        method: 'PUT',
        body: {
          firstResponseLimitSec: values.firstResponseLimitSec,
          avgResponseLimitSec: values.avgResponseLimitSec,
          replyRateLimitPct: values.replyRateLimitPct,
          timeoutSec: values.timeoutSec,
          timeoutPenalty: values.timeoutPenalty,
          weights: { response: values.response, solving: values.solving, wording: values.wording, emotion: values.emotion },
          passLine: values.passLine,
          unlockConsecutive: values.unlockConsecutive,
          maxConcurrent: values.maxConcurrent,
          levelConcurrent,
          levelTotal,
          levelRounds: [values.roundsMin, values.roundsMax],
          levelJoinDelaySec: [values.joinMin, values.joinMax],
          emotionEscalateThreshold: values.emotionEscalateThreshold,
          messageMaxLength: values.messageMaxLength,
          // 客户 2026-10-03：一次接待里「买完商品后的订单类问题」占比（默认 20）
          aftersaleQuestionRatio: values.aftersaleQuestionRatio,
          disconnectGraceSec: values.disconnectGraceSec,
          hintMode: !!values.hintMode,
          invalidReplyEnabled: !!values.invalidReplyEnabled,
          invalidReplyDuplicateMode: values.invalidReplyDuplicateMode,
          invalidReplyDuplicateStreak: values.invalidReplyDuplicateStreak,
          invalidReplyUnresolvedEnabled: !!values.invalidReplyUnresolvedEnabled,
          invalidReplyUnresolvedStreak: values.invalidReplyUnresolvedStreak,
          banalWords: values.banalWords || [],
          hintDelaySec: values.hintDelaySec,
          loginMaxFailures: values.loginMaxFailures,
          loginLockMinutes: values.loginLockMinutes,
          passwordMaxAgeDays: values.passwordMaxAgeDays,
        },
      });
      message.success('系统参数已保存，新的接待将按新参数执行');
      load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!params) return <Card loading bordered={false} />;

  return (
    <Card
      className="page-card"
      bordered={false}
      title="系统参数"
      extra={
        <Button type="primary" icon={<SaveOutlined />} loading={saving} disabled={readOnly} onClick={save}>
          保存
        </Button>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="所有阈值与权重均在此配置，修改后立即对新接待生效；历史接待按生成时的参数快照计分，不重算（方案 3.8.4）。"
      />
      <Form form={form} layout="vertical" disabled={readOnly}>
        <Typography.Title level={5}>考核规则</Typography.Title>
        <Row gutter={16}>
          <Col span={6}>
            <Form.Item name="firstResponseLimitSec" label="首次响应时长上限（秒）">
              <InputNumber min={5} max={600} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item name="avgResponseLimitSec" label="平均响应时长上限（秒）">
              <InputNumber min={5} max={900} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item name="replyRateLimitPct" label="3 分钟回复率下限（%）">
              <InputNumber min={0} max={100} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item name="timeoutSec" label="超时判定阈值（秒）">
              <InputNumber min={30} max={1800} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item name="timeoutPenalty" label="单次超时扣分">
              <InputNumber min={0} max={20} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>

        <Divider />
        <Typography.Title level={5}>评分权重与达标线</Typography.Title>
        <Row gutter={16}>
          <Col span={5}>
            <Form.Item name="response" label="响应时效">
              <InputNumber min={0} max={100} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={5}>
            <Form.Item name="solving" label="问题解决率">
              <InputNumber min={0} max={100} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={5}>
            <Form.Item name="wording" label="话术规范">
              <InputNumber min={0} max={100} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={5}>
            <Form.Item name="emotion" label="情绪安抚">
              <InputNumber min={0} max={100} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={4}>
            <Form.Item name="passLine" label="达标线">
              <InputNumber min={0} max={100} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>

        <Divider />
        <Typography.Title level={5}>难度与接待参数</Typography.Title>
        <Row gutter={16}>
          <Col span={4}>
            <Form.Item name="maxConcurrent" label="并发接待上限">
              <InputNumber min={1} max={4} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={4}>
            <Form.Item
              name="unlockConsecutive"
              label="解锁所需达标次数"
              tooltip="客户 2026-10-02 确认：达标 1 次即解锁下一档（方案原默认 2 次，属客户覆盖值）"
            >
              <InputNumber min={1} max={10} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={4}>
            <Form.Item name="roundsMin" label="单会话轮数下限">
              <InputNumber min={1} max={20} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={4}>
            <Form.Item name="roundsMax" label="单会话轮数上限">
              <InputNumber min={1} max={30} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={4}>
            <Form.Item name="joinMin" label="进线间隔下限（秒）">
              <InputNumber min={0} max={300} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={4}>
            <Form.Item name="joinMax" label="进线间隔上限（秒）">
              <InputNumber min={0} max={600} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>
        {/* 客户新增需求：管理账号可设置各难度的接入买家数（默认仍是 1/2/3/4） */}
        <Row gutter={16}>
          <Col span={4}>
            <Form.Item name="concurrentL1" label="L1 接入人数" tooltip="话术适应档实际接入的买家数，1～4">
              <InputNumber min={1} max={4} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={4}>
            <Form.Item name="concurrentL2" label="L2 接入人数">
              <InputNumber min={1} max={4} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={4}>
            <Form.Item name="concurrentL3" label="L3 接入人数">
              <InputNumber min={1} max={4} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={4}>
            <Form.Item name="concurrentL4" label="L4 接入人数">
              <InputNumber min={1} max={4} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              实际接入人数 = min(本档人数, 并发接待上限 {params.maxConcurrent})
            </Typography.Text>
          </Col>
        </Row>
        {/* 客户新增需求 C5：本次模拟的总接待人数（含排队待接入），默认等于该档接入人数 */}
        <Row gutter={16}>
          <Col span={4}>
            <Form.Item name="totalL1" label="L1 总接待人数" tooltip="本次模拟一共接待几个买家（含还没接入、排队中的），1～20">
              <InputNumber min={1} max={20} style={{ width: '100%' }} placeholder={`默认 ${params.levelConcurrent?.L1 ?? 1}`} />
            </Form.Item>
          </Col>
          <Col span={4}>
            <Form.Item name="totalL2" label="L2 总接待人数">
              <InputNumber min={1} max={20} style={{ width: '100%' }} placeholder={`默认 ${params.levelConcurrent?.L2 ?? 2}`} />
            </Form.Item>
          </Col>
          <Col span={4}>
            <Form.Item name="totalL3" label="L3 总接待人数">
              <InputNumber min={1} max={20} style={{ width: '100%' }} placeholder={`默认 ${params.levelConcurrent?.L3 ?? 3}`} />
            </Form.Item>
          </Col>
          <Col span={4}>
            <Form.Item name="totalL4" label="L4 总接待人数">
              <InputNumber min={1} max={20} style={{ width: '100%' }} placeholder={`默认 ${params.levelConcurrent?.L4 ?? 4}`} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              「本次模拟合计接待多少人」，<b>默认 10 人</b>，管理员可在这里提前按档位设置；
              比同时在线（L1 {params.levelConcurrent?.L1 ?? 1} / L2 {params.levelConcurrent?.L2 ?? 2} / L3{' '}
              {params.levelConcurrent?.L3 ?? 3} / L4 {params.levelConcurrent?.L4 ?? 4} 人）多出来的买家
              排队待接入，有会话结束再补位。<b>改完保存后只对新接待生效。</b>
            </Typography.Text>
          </Col>
        </Row>

        <Divider />
        {/* 客户 2026-10-03：一次接待的问题构成——大部分是无订单的商品咨询（售前），小部分是买完商品后的订单类问题（售后） */}
        <Typography.Title level={5}>问题构成（售前 / 售后）</Typography.Title>
        <Row gutter={16}>
          <Col span={6}>
            <Form.Item name="aftersaleQuestionRatio" label="售后问题占比（%）">
              <InputNumber min={0} max={80} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={18}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              一次接待里，约这个比例的问题属于「**买完商品后**」的订单类售后问题（改收货地址、改快递、催发货、
              改单、改电话…），其余问题都是「**还没有订单**、只咨询商品信息」的售前问题（颜色/面料/尺码/优惠…）。
              默认 <b>20%</b>；填 0 表示整场都是剧本本身的话题。改动只对之后新开的接待生效。
            </Typography.Text>
          </Col>
        </Row>

        <Divider />
        <Typography.Title level={5}>沟通风格与消息</Typography.Title>
        <Row gutter={16}>
          <Col span={6}>
            <Form.Item name="emotionEscalateThreshold" label="情绪值升级阈值">
              <InputNumber min={0} max={100} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item name="messageMaxLength" label="单条消息长度上限（字）">
              <InputNumber min={50} max={2000} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item name="disconnectGraceSec" label="断线判定时长（秒）">
              <InputNumber min={10} max={600} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>
        <Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            买家响应等待口径：L1 宽松（超时阈值 ×{params.waitToleranceFactor?.L1 ?? 1.5}），L2～L4 标准（×1）。
          </Typography.Text>
        </Space>

        <Divider />
        <Typography.Title level={5}>无效 / 敷衍回复判定</Typography.Title>
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="抖店官方只公布了三种「敷衍回复」情形，并声明以平台系统判定为准，没有公开词表。"
          description="本页的「敷衍词表」由业务方自行维护，属自定义口径，不是平台官方口径；判定结果会实时提醒客服、给该条消息打标，并在明细里标注依据。默认关闭，开启后只对新接待生效。"
        />
        <Row gutter={16} align="middle">
          <Col span={4}>
            <Form.Item name="invalidReplyEnabled" label="总开关" valuePropName="checked" tooltip="关闭时完全按改造前行为，不做任何无效判定">
              <Switch checkedChildren="开启" unCheckedChildren="关闭" />
            </Form.Item>
          </Col>
          <Col span={5}>
            <Form.Item name="invalidReplyDuplicateMode" label="重复判定方式" tooltip="完全相同：与上一条客服回复一模一样即判无效；连续 N 次：同一内容连续出现 N 次才判无效">
              <Select
                options={[
                  { value: 'streak', label: '连续 N 次完全相同' },
                  { value: 'identical', label: '与上一条完全相同' },
                ]}
              />
            </Form.Item>
          </Col>
          <Col span={4}>
            <Form.Item name="invalidReplyDuplicateStreak" label="连续次数阈值">
              <InputNumber min={2} max={10} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={4}>
            <Form.Item name="invalidReplyUnresolvedEnabled" label="未解决判定" valuePropName="checked" tooltip="近似官方「买家明确要求后仍未改善」：连续 N 轮一个问题要点都没答到即判无效">
              <Switch checkedChildren="开启" unCheckedChildren="关闭" />
            </Form.Item>
          </Col>
          <Col span={4}>
            <Form.Item name="invalidReplyUnresolvedStreak" label="连续未命中轮数">
              <InputNumber min={2} max={10} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col span={16}>
            <Form.Item
              name="banalWords"
              label="敷衍词表（业务方自定义，非平台官方口径）"
              tooltip="命中即判为无效回复。与「禁用词库」分开维护，避免同一句同时被话术扣分、情绪上升与 600 秒三重惩罚"
            >
              <Select mode="tags" open={false} placeholder="输入后回车添加，例如：不知道 / 没办法" />
            </Form.Item>
          </Col>
        </Row>

        <Divider />
        <Typography.Title level={5}>教学与登录安全</Typography.Title>
        <Row gutter={16} align="middle">
          <Col span={4}>
            <Form.Item name="hintMode" label="提示模式" valuePropName="checked" tooltip="方案 F1-15：带教开启后，客服长时间未回复会看到话术思路提示；仅用于教学，不参与评分">
              <Switch checkedChildren="开启" unCheckedChildren="关闭" />
            </Form.Item>
          </Col>
          <Col span={5}>
            <Form.Item name="hintDelaySec" label="多久未回复给提示（秒）">
              <InputNumber min={10} max={600} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={5}>
            <Form.Item name="loginMaxFailures" label="登录失败锁定阈值（次）" tooltip="方案 F8-10：连续失败达到该次数后锁定账号">
              <InputNumber min={0} max={20} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={5}>
            <Form.Item name="loginLockMinutes" label="锁定时长（分钟）">
              <InputNumber min={1} max={240} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={5}>
            <Form.Item name="passwordMaxAgeDays" label="密码有效期（天）" tooltip="超过该天数后登录会被要求先改密；填 0 表示不过期">
              <InputNumber min={0} max={365} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Card>
  );
}
