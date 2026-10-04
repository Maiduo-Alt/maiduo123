import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Card, DatePicker, Drawer, Form, Input, InputNumber, Modal, Select, Space, Statistic, Table, Tag, Tooltip, message } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { api } from '../api/client';
import { useAuth } from '../store/auth';

export default function Tasks() {
  const navigate = useNavigate();
  const [list, setList] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  /** 剧本范围的候选项（方案 F6-03） */
  const [scriptCategories, setScriptCategories] = useState<any[]>([]);
  const [productOptions, setProductOptions] = useState<any[]>([]);
  const [scriptOptions, setScriptOptions] = useState<any[]>([]);
  /**
   * 客户 2026-10-03：任务可以按**商品种类**（男装 / 女装 / 鞋靴 …）圈定训练内容。
   * 选项直接取商品库实际用到的分类，并统计每个品类下有多少剧本——避免选了没有剧本的品类。
   */
  const [productCategoryOptions, setProductCategoryOptions] = useState<{ value: string; label: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const { profile } = useAuth();
  /** 任务下发是带教能力（方案 2.2），客服只接收与执行 */
  const canManage = profile?.roleCode === 'admin' || profile?.roleCode === 'leader';
  const [createOpen, setCreateOpen] = useState(false);
  const [report, setReport] = useState<any>(null);
  const [form] = Form.useForm();
  const scopeType = Form.useWatch('scopeType', form);

  const load = async () => {
    setLoading(true);
    try {
      // 客服只接收与执行任务（方案 2.2），下发对象列表仅管理员/主管需要，也仅有他们有权限
      const [tasks, users] = await Promise.all([
        api<any[]>('/tasks'),
        canManage ? api<any>('/accounts', { query: { role: 'agent', pageSize: 200 } }) : Promise.resolve({ list: [] }),
      ]);
      setList(tasks || []);
      setAccounts(users.list || []);
      if (canManage) {
        // 范围候选项只在建任务时需要，失败不影响任务列表展示
        const [categories, products, scripts] = await Promise.all([
          api<any>('/categories', { query: { type: 'script' } }).catch(() => []),
          api<any>('/products', { query: { pageSize: 200 } }).catch(() => ({ list: [] })),
          api<any>('/scripts', { query: { pageSize: 200 } }).catch(() => ({ list: [] })),
        ]);
        setScriptCategories(Array.isArray(categories) ? categories : []);
        setProductOptions(products.list || []);
        setScriptOptions(scripts.list || []);
        // 商品种类选项：商品库实际用到的分类 + 每个分类下关联了多少条剧本（剧本通过关联商品带出品类）
        const productList = products.list || [];
        const categoryOf = new Map<number, string>(
          productList.map((item: any) => [Number(item.id), String(item.category || '未分类')])
        );
        const countByCategory = new Map<string, number>();
        (scripts.list || []).forEach((row: any) => {
          const names = new Set(
            (row.productIds || []).map((id: any) => categoryOf.get(Number(id))).filter(Boolean) as string[]
          );
          names.forEach((name) => countByCategory.set(name, (countByCategory.get(name) || 0) + 1));
        });
        setProductCategoryOptions(
          [...countByCategory.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([name, count]) => ({ value: name, label: `${name}（${count} 个剧本）` }))
        );
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  /**
   * 任务列表的「范围」列（客户 2026-10-03）：
   * 把 scopeType/scopeValue 说成人话——「剧本 2 个 × 商品 3 个」这种，
   * 悬停还能看到具体选了哪些剧本/商品/分类。
   */
  const scopeInfo = (row: any): { text: string; detail: string } => {
    const value = row?.scopeValue || {};
    const names = (ids: any[] = [], options: any[], key: string) =>
      ids
        .map((id) => options.find((item) => Number(item.id) === Number(id))?.[key] || `#${id}`)
        .join('、');
    switch (row?.scopeType) {
      case 'scripts_products': {
        const scriptIds: number[] = value.scriptIds || [];
        const productIds: number[] = value.productIds || [];
        const parts: string[] = [];
        if (scriptIds.length) parts.push(`剧本 ${scriptIds.length} 个`);
        if (productIds.length) parts.push(`商品 ${productIds.length} 个`);
        const detail = [
          scriptIds.length ? `剧本：${names(scriptIds, scriptOptions, 'name')}` : '剧本：不限',
          productIds.length ? `商品：${names(productIds, productOptions, 'title')}` : '商品：不限',
        ].join('；');
        return { text: parts.length ? `${parts.join(' × ')}` : '全部剧本', detail };
      }
      case 'product_category':
        return {
          text: `商品种类：${(value.categories || []).join('、') || '未选'}`,
          detail: '只抽「关联商品的分类」命中这些种类的剧本',
        };
      case 'category':
        return {
          text: `剧本分类：${(value.categories || []).join('、') || '未选'}`,
          detail: '按剧本自身的分类圈定',
        };
      case 'product':
        return {
          text: `关联商品 ${(value.productIds || []).length} 个`,
          detail: `商品：${names(value.productIds || [], productOptions, 'title')}`,
        };
      case 'scripts':
        return {
          text: `剧本清单 ${(value.scriptIds || []).length} 个`,
          detail: `剧本：${names(value.scriptIds || [], scriptOptions, 'name')}`,
        };
      default:
        return { text: '全部剧本', detail: '未限定范围' };
    }
  };

  const create = async () => {
    const values = await form.validateFields();
    const scopeValue =
      values.scopeType === 'category'
        ? { categories: values.scopeCategories || [] }
        : values.scopeType === 'product_category'
          ? { categories: values.scopeProductCategories || [] }
        : values.scopeType === 'scripts_products'
          ? { scriptIds: values.scopeScripts2 || [], productIds: values.scopeProducts2 || [] }
        : values.scopeType === 'product'
          ? { productIds: values.scopeProducts || [] }
          : values.scopeType === 'scripts'
            ? { scriptIds: values.scopeScripts || [] }
            : {};
    try {
      await api('/tasks', {
        method: 'POST',
        body: {
          name: values.name,
          levels: values.levels,
          targetCount: values.targetCount,
          startAt: new Date().toISOString(),
          deadline: values.deadline.toISOString(),
          assignees: values.assignees,
          scopeType: values.scopeType || 'all',
          scopeValue,
          targets: [{ metric: 'total_score', operator: 'gte', threshold: values.scoreThreshold }],
        },
      });
      message.success('任务已下发');
      setCreateOpen(false);
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <Card
      className="page-card"
      bordered={false}
      title="回复模拟任务"
      extra={
        <Space>
          {canManage && (
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                setCreateOpen(true);
                form.resetFields();
              }}
            >
              新建任务
            </Button>
          )}
          <Button icon={<ReloadOutlined />} onClick={load}>
            刷新
          </Button>
        </Space>
      }
    >
      <Table
        rowKey="id"
        loading={loading}
        dataSource={list}
        pagination={false}
        locale={{
          emptyText: canManage
            ? '还没有任务，点右上角「新建任务」下发一个'
            : '还没有下发给你的任务，请联系带教确认；带教下发后这里会显示任务目标与截止倒计时',
        }}
        /**
         * 列宽都给足并让表格自己横向滚动：否则窄屏下没设宽度的列（任务名称 / 目标）
         * 会被固定宽度的列挤成 0 宽——2026-10-03 加「范围」列时就是这么被截图抓到的。
         */
        scroll={{ x: 1260 }}
        columns={[
          { title: '任务编号', dataIndex: 'taskNo', width: 160 },
          { title: '任务名称', dataIndex: 'name', width: 180, ellipsis: true },
          {
            title: '范围',
            key: 'scope',
            width: 150,
            render: (_: any, row: any) => {
              const info = scopeInfo(row);
              return (
                <Tooltip title={info.detail}>
                  <span style={{ fontSize: 12 }}>{info.text}</span>
                </Tooltip>
              );
            },
          },
          { title: '难度', dataIndex: 'levels', width: 120, render: (v: string[]) => (v || []).map((l) => <Tag key={l}>{l}</Tag>) },
          {
            title: '目标',
            dataIndex: 'targets',
            width: 110,
            render: (v: any[]) =>
              (v || []).map((t, i) => (
                <Tag key={i} color="blue">
                  {t.metric === 'total_score' ? '总分' : t.metric === 'first_response' ? '首次响应' : '超时次数'}{' '}
                  {t.operator === 'gte' ? '≥' : '≤'} {t.threshold}
                </Tag>
              )),
          },
          { title: '需完成', dataIndex: 'targetCount', width: 80 },
          {
            // 客服看到的是「我的进度（我完成几次 / 需完成几次）」；
            // 带教看到的是「完成人数（已达标人数 / 参与人数）」——两个口径不能混在一列。
            title: canManage ? '完成人数' : '我的进度',
            width: 110,
            render: (_, row: any) =>
              canManage ? `${row.doneCount}/${row.assigneeCount} 人` : `${row.myDoneCount ?? 0}/${row.targetCount} 次`,
          },
          { title: '截止时间', dataIndex: 'deadline', width: 180, render: (v) => new Date(v).toLocaleString('zh-CN') },
          {
            title: '操作',
            width: 170,
            render: (_, row: any) => (
              <Space size={4}>
                {/* 只有被下发的账号才能开这一局（后端也会校验），带教看别人的任务时不给入口 */}
                {row.assignedToMe ? (
                  <Button
                    type="link"
                    size="small"
                    // 截止后任务自动关闭（后端也会拦）：这里按状态 + 截止时间双重判断，
                    // 避免「刚过截止但状态还没被扫描更新」时点进去报错。
                    disabled={row.status !== 'running' || Date.parse(row.deadline) <= Date.now()}
                    onClick={() => navigate(`/reception?taskId=${row.id}`)}
                  >
                    开始训练
                  </Button>
                ) : null}
                {canManage && (
                  <Button type="link" size="small" onClick={async () => setReport(await api(`/tasks/${row.id}/report`))}>
                    查看报表
                  </Button>
                )}
              </Space>
            ),
          },
        ]}
      />

      <Modal open={createOpen} title="新建训练任务" onCancel={() => setCreateOpen(false)} onOk={create} width={640} destroyOnClose>
        <Form form={form} layout="vertical" initialValues={{ levels: ['L2'], targetCount: 3, scoreThreshold: 85 }}>
          <Form.Item name="name" label="任务名称" rules={[{ required: true, message: '请输入任务名称' }]}>
            <Input placeholder="例如：报价类场景强化训练" />
          </Form.Item>
          <Form.Item name="levels" label="允许难度" rules={[{ required: true, message: '请选择难度' }]}>
            <Select
              mode="multiple"
              options={[
                { value: 'L1', label: 'L1 话术适应' },
                { value: 'L2', label: 'L2 简单' },
                { value: 'L3', label: 'L3 进阶' },
                { value: 'L4', label: 'L4 困难' },
              ]}
            />
          </Form.Item>
          <Space size={16}>
            <Form.Item name="scoreThreshold" label="达标总分（≥）">
              <InputNumber min={0} max={100} style={{ width: 160 }} />
            </Form.Item>
            <Form.Item name="targetCount" label="需达成次数">
              <InputNumber min={1} style={{ width: 160 }} />
            </Form.Item>
            <Form.Item name="deadline" label="截止时间" rules={[{ required: true, message: '请选择截止时间' }]}>
              <DatePicker showTime defaultValue={dayjs().add(7, 'day')} />
            </Form.Item>
          </Space>
          <Form.Item name="assignees" label="下发对象" rules={[{ required: true, message: '请选择下发对象' }]}>
            <Select
              mode="multiple"
              options={accounts.map((a: any) => ({ value: a.id, label: `${a.displayName}（${a.username}）` }))}
              placeholder="选择客服"
            />
          </Form.Item>
          {/* 剧本范围限定（方案 F6-03 + 客户 2026-10-03 的「按商品种类」） */}
          <Form.Item
            name="scopeType"
            label="剧本范围"
            initialValue="all"
            tooltip="限定客服这次训练能抽到的剧本；按商品种类圈定时，推送的问题也会围绕这些品类的商品"
          >
            <Select
              options={[
                { value: 'all', label: '全部剧本' },
                { value: 'scripts_products', label: '指定剧本 + 商品（都能多选）' },
                { value: 'product_category', label: '按商品种类（男装/女装…）' },
                { value: 'category', label: '按剧本分类' },
                { value: 'product', label: '按关联商品' },
                { value: 'scripts', label: '指定剧本清单' },
              ]}
            />
          </Form.Item>
          {/*
            客户 2026-10-03：下发任务时要能**同时多选剧本和商品**——
            两个都选 = 「这批剧本里、关联了这些商品的」才会被抽到；任一侧留空表示该维度不限制。
          */}
          {scopeType === 'scripts_products' && (
            <>
              <Form.Item name="scopeScripts2" label="选择剧本（可多选）" extra="留空 = 不限剧本">
                <Select
                  mode="multiple"
                  showSearch
                  optionFilterProp="label"
                  placeholder="只抽这些剧本"
                  options={scriptOptions.map((item: any) => ({ value: item.id, label: `${item.name}（${item.scriptNo}）` }))}
                />
              </Form.Item>
              <Form.Item name="scopeProducts2" label="选择商品（可多选）" extra="留空 = 不限商品；与上面同时生效（两个条件都满足才抽到）">
                <Select
                  mode="multiple"
                  showSearch
                  optionFilterProp="label"
                  placeholder="只抽关联了这些商品的剧本"
                  options={productOptions.map((item: any) => ({ value: item.id, label: `${item.title}（${item.category || '未分类'}）` }))}
                />
              </Form.Item>
            </>
          )}
          {scopeType === 'product_category' && (
            <Form.Item
              name="scopeProductCategories"
              label="选择商品种类"
              rules={[{ required: true, message: '请选择商品种类' }]}
              extra="只抽「关联商品的分类」命中这些种类的剧本，推送的问题也就围绕这些品类的商品；括号里是该品类当前可用的剧本数"
            >
              <Select mode="multiple" placeholder="例如：女装 / 男装" options={productCategoryOptions} />
            </Form.Item>
          )}
          {scopeType === 'category' && (
            <Form.Item name="scopeCategories" label="选择分类" rules={[{ required: true, message: '请选择剧本分类' }]}>
              <Select
                mode="multiple"
                placeholder="选择剧本分类"
                options={scriptCategories.map((item: any) => ({ value: item.name, label: item.name }))}
              />
            </Form.Item>
          )}
          {scopeType === 'product' && (
            <Form.Item name="scopeProducts" label="选择商品" rules={[{ required: true, message: '请选择商品' }]}>
              <Select
                mode="multiple"
                showSearch
                optionFilterProp="label"
                placeholder="关联到这些商品的剧本才会被抽到"
                options={productOptions.map((item: any) => ({ value: item.id, label: item.title }))}
              />
            </Form.Item>
          )}
          {scopeType === 'scripts' && (
            <Form.Item name="scopeScripts" label="选择剧本" rules={[{ required: true, message: '请选择剧本' }]}>
              <Select
                mode="multiple"
                showSearch
                optionFilterProp="label"
                placeholder="只抽这些剧本"
                options={scriptOptions.map((item: any) => ({ value: item.id, label: `${item.name}（${item.scriptNo}）` }))}
              />
            </Form.Item>
          )}
        </Form>
      </Modal>

      <Drawer open={!!report} title={`任务报表 · ${report?.task?.name || ''}`} width={680} onClose={() => setReport(null)}>
        {report && (
          <>
            {/* 方案 F6-09：任务报表要能直接看到完成率与未通过名单 */}
            <Space size={28} style={{ marginBottom: 12 }} wrap>
              <Statistic title="参与者" value={report.participantCount ?? (report.assignees || []).length} suffix="人" />
              <Statistic title="完成率" value={report.completionRate ?? 0} suffix="%" />
              <Statistic
                title="未通过"
                value={(report.failedAssignees || []).length}
                suffix="人"
                valueStyle={{ color: (report.failedAssignees || []).length ? '#cf1322' : '#389e0d' }}
              />
            </Space>
            {(report.failedAssignees || []).length ? (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                message="未通过名单"
                description={(report.failedAssignees || [])
                  .map(
                    (row: any) =>
                      `${row.accountName}（已完成 ${row.doneCount} 次，最高 ${Number(row.bestScore || 0).toFixed(1)} 分）`
                  )
                  .join('；')}
              />
            ) : (
              <Alert type="success" showIcon style={{ marginBottom: 12 }} message="全部参与者都已达标" />
            )}
            <Table
            rowKey="accountId"
            size="small"
            pagination={false}
            dataSource={report.assignees}
            columns={[
              { title: '客服', dataIndex: 'accountName' },
              { title: '已完成次数', dataIndex: 'doneCount' },
              { title: '接待次数', dataIndex: 'attemptCount' },
              { title: '平均分', dataIndex: 'avgScore', render: (v) => Number(v || 0).toFixed(1) },
              { title: '最高分', dataIndex: 'bestScore', render: (v) => Number(v || 0).toFixed(1) },
              {
                title: '状态',
                dataIndex: 'status',
                render: (v) => (v === 'done' ? <Tag color="green">已完成</Tag> : v === 'doing' ? <Tag color="blue">进行中</Tag> : <Tag>未开始</Tag>),
              },
            ]}
            />
          </>
        )}
      </Drawer>
    </Card>
  );
}
