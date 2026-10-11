import { useEffect, useState } from 'react';
import {
  Alert,
  AutoComplete,
  Button,
  Card,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Radio,
  Select,
  Space,
  Steps,
  Table,
  Tag,
  Timeline,
  Typography,
  message,
} from 'antd';
import { BarChartOutlined, DeleteOutlined, PlusOutlined, QuestionCircleOutlined, ReloadOutlined, ShoppingOutlined } from '@ant-design/icons';
import { api } from '../api/client';
import SemanticGoalBuilder, { semanticQuestionsToRows, semanticRowsToGoalsBySeq } from '../components/SemanticGoalBuilder';

/**
 * 把背景 / 咨询内容按「分类」分组，供 Select 分组展示（客户 2026-10-10：
 * 新建剧本时背景和内容要按分类筛选，不再是一眼望不到头的平铺列表）。
 * 分组按组内条数降序；组名带数量，方便一眼看出哪类素材最多。
 * groupKey 可换成分组字段（如咨询内容按 stageLabel = 售前/售后 的问题类型分组）。
 */
function groupByCategory(items: any[], labelKey: string, groupKey = 'category') {
  const groups = new Map<string, { value: number; label: string }[]>();
  for (const item of items || []) {
    const cat = item[groupKey] || '通用';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push({ value: item.id, label: item[labelKey] });
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([cat, opts]) => ({ label: `${cat}（${opts.length}）`, options: opts }));
}

export default function Scripts() {
  const [list, setList] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState<any>({ page: 1, pageSize: 10 });
  const [batchOpen, setBatchOpen] = useState(false);
  /** 表格勾选的剧本 id（批量删除用） */
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  /** 批量改分类弹窗（2026-10-09 客户新增） */
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [categoryValue, setCategoryValue] = useState<string>('');
  const [categorySaving, setCategorySaving] = useState(false);
  const [detail, setDetail] = useState<any>(null);
  const [goalConfigOpen, setGoalConfigOpen] = useState(false);
  const [savingGoals, setSavingGoals] = useState(false);
  const [options, setOptions] = useState<{
    backgrounds: any[];
    contents: any[];
    products: any[];
    styles: any[];
    cases: any[];
    /** 剧本分类：来自《数据字典》type=script，与筛选、新建表单的分类选项共用一份数据（客户 2026-10-09） */
    scriptCategories: any[];
    /** 分类维度（客户 2026-10-10 多维分类 B 类）：咨询内容筛选用 */
    dimensions: any[];
  }>({
    backgrounds: [],
    contents: [],
    products: [],
    styles: [],
    cases: [],
    scriptCategories: [],
    dimensions: [],
  });
  const [form] = Form.useForm();
  const [goalForm] = Form.useForm();
  /** 异步批量生成任务（超过阈值时后端返回任务 ID） */
  const [genTask, setGenTask] = useState<any>(null);
  /** 剧本统计（方案 F3-12） */
  const [stats, setStats] = useState<any>(null);
  /** 使用说明：剧本管理操作说明卡（2026-10-08 客户新增） */
  const [guideOpen, setGuideOpen] = useState(false);
  const createMode = Form.useWatch('createMode', form);
  const createWay = Form.useWatch('createWay', form);
  const ruleMode = Form.useWatch('ruleMode', form);
  const productIds = Form.useWatch('productIds', form) as number[] | undefined;
  const selectedProducts = (options.products || []).filter((p) => (productIds || []).includes(p.id));
  /**
   * 客户 2026-10-10：新建剧本改为**三段式向导**——基础设置 → 剧本信息 → 剧本内容，
   * 每一步只填少量字段，点「下一步」时只校验本步字段，避免一屏十几个控件的眼花缭乱。
   */
  const [step, setStep] = useState(0);
  /** 多维分类（B 类）筛选：新建剧本第 3 步按维度组合过滤咨询内容 */
  const [qaDimFilters, setQaDimFilters] = useState<Record<string, string>>({});
  /** 分段式选择（客户 2026-10-10）：先选模板分类缩小范围，再选具体内容，避免一次性平铺几百条 */
  const [qaCatFilter, setQaCatFilter] = useState<string>();
  /** 买家咨询背景同样分段式：先选背景分类再选背景 */
  const [bgCatFilter, setBgCatFilter] = useState<string>();
  const bgCategories = Array.from(new Set((options.backgrounds || []).map((b) => b.category || '通用')));
  const filteredBackgrounds = (options.backgrounds || []).filter(
    (b) => !bgCatFilter || (b.category || '通用') === bgCatFilter
  );
  const qaCategories = Array.from(new Set((options.contents || []).map((c) => c.category || '通用')));
  const filteredContents = (options.contents || []).filter(
    (c) =>
      (!qaCatFilter || (c.category || '通用') === qaCatFilter) &&
      Object.entries(qaDimFilters).every(([k, v]) => !v || (c.dims || {})[k] === v)
  );
  /** 每步参与校验的字段（联动字段按当前选项动态收窄） */
  const stepFields: string[][] = [
    createWay === 'case' ? ['createMode', 'createWay', 'caseId', 'category'] : ['createMode', 'createWay', 'category'],
    createMode === 'single' ? ['stage', 'styleId', 'productIds'] : ['stage', 'productIds'],
    ['bgIds', 'qaIds'],
  ];
  const nextStep = async () => {
    await form.validateFields(stepFields[step]);
    setStep(step + 1);
  };

  const load = async (patch: any = {}) => {
    const next = { ...query, ...patch };
    setQuery(next);
    setSelectedIds([]);
    setLoading(true);
    try {
      const res = await api<any>('/scripts', { query: next });
      setList(res.list || []);
      setTotal(res.total || 0);
    } finally {
      setLoading(false);
    }
  };

  const loadOptions = async () => {
    const [backgrounds, contents, products, styles, cases, scriptCategories, dimensions] = await Promise.all([
      api<any>('/backgrounds', { query: { pageSize: 200 } }),
      api<any>('/contents', { query: { pageSize: 200 } }),
      // 方案 9.1：下架商品不应出现在新剧本的商品选择中
      api<any>('/products', { query: { pageSize: 200, status: 1 } }),
      api<any>('/styles'),
      // 按案例创建用（方案 F3-07）
      api<any>('/cases', { query: { pageSize: 200 } }).catch(() => ({ list: [] })),
      // 剧本分类：与《数据字典》里的「剧本分类」词条同源
      api<any[]>('/categories', { query: { type: 'script' } }).catch(() => []),
      // 分类维度（多维分类）：新建剧本时按维度组合筛选咨询内容
      api<any[]>('/dimensions').catch(() => []),
    ]);
    setOptions({
      backgrounds: backgrounds.list || [],
      contents: contents.list || [],
      products: products.list || [],
      styles: Array.isArray(styles) ? styles : styles.list || [],
      cases: cases.list || [],
      scriptCategories: Array.isArray(scriptCategories) ? scriptCategories : [],
      dimensions: Array.isArray(dimensions) ? dimensions : [],
    });
  };

  useEffect(() => {
    load({ page: 1 });
    loadOptions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 异步批量生成：轮询进度直到结束
  useEffect(() => {
    if (!genTask || genTask.status !== 'running') return;
    const timer = window.setInterval(async () => {
      try {
        const data = await api<any>(`/scripts/batch-generate/tasks/${genTask.id}`);
        setGenTask(data);
        if (data.status !== 'running') {
          message.success(
            `批量生成${data.status === 'cancelled' ? '已取消' : '完成'}：新建 ${data.createdCount} 个剧本` +
              (data.failedCount ? `，失败 ${data.failedCount} 个` : '')
          );
          load({ page: 1 });
        }
      } catch {
        /* 轮询失败不中断，下次继续 */
      }
    }, 800);
    return () => window.clearInterval(timer);
  }, [genTask?.id, genTask?.status]);

  const cancelGenTask = async () => {
    if (!genTask) return;
    try {
      await api(`/scripts/batch-generate/tasks/${genTask.id}/cancel`, { method: 'POST' });
      message.info('已发送取消请求，已生成的剧本会保留');
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const generate = async () => {
    const values = await form.validateFields();
    try {
      const autoSemanticGoals = values.ruleMode === 'semantic' && values.createWay !== 'case';
      // 按案例创建（方案 F3-07）：案例的买家消息先沉淀成咨询内容，再走标准建剧本流程
      if (values.createWay === 'case') {
        const res = await api<any>('/scripts/from-case', {
          method: 'POST',
          body: {
            caseId: values.caseId,
            productIds: values.productIds,
            styleId: values.styleId,
            name: values.name || undefined,
            autoSemanticGoals,
          },
        });
        message.success('已按案例生成剧本');
        setBatchOpen(false);
        load({ page: 1 });
        void res;
        return;
      }
      // 单个剧本：直接调用创建接口；批量剧本：按「背景 × 内容」交叉生成
      if (values.createMode === 'single') {
        if (values.bgIds.length !== 1 || values.qaIds.length !== 1) {
          message.error('单个剧本只能选择 1 个背景与 1 条咨询内容，如需交叉生成请切换到批量剧本');
          return;
        }
        await api('/scripts', {
          method: 'POST',
          body: {
            bgId: values.bgIds[0],
            qaId: values.qaIds[0],
            styleId: values.styleId,
            productIds: values.productIds,
            stage: values.stage,
            category: values.category || '培训',
            name: values.name || undefined,
            autoSemanticGoals,
          },
        });
        message.success('已生成 1 个剧本');
        setBatchOpen(false);
        load({ page: 1 });
        return;
      }
      const res = await api<any>('/scripts/batch-generate', {
        method: 'POST',
        body: {
          bgIds: values.bgIds,
          qaIds: values.qaIds,
          productIds: values.productIds,
          stage: values.stage,
          category: values.category || '培训',
          autoSemanticGoals,
        },
      });
      // 超过异步阈值时后端返回任务 ID，改为进度条展示（方案 3.3 / 5.7）
      if (res.async) {
        setBatchOpen(false);
        setGenTask({ id: res.taskId, total: res.total, createdCount: 0, failedCount: 0, status: 'running' });
        return;
      }
      message.success(`已生成 ${res.total} 个剧本`);
      /**
       * 客户 2026-10-03：商品与问题必须一致——不匹配的内容会被跳过，
       * 这里把跳过的条数与原因告诉带教，避免"选了没生成"的困惑。
       */
      if (res.skipped?.length) {
        message.warning(
          `有 ${res.skipped.length} 条咨询内容因「商品与问题不匹配」被跳过：${res.skipped[0].templateName}（${res.skipped[0].reason}）`
        );
      }
      setBatchOpen(false);
      load({ page: 1 });
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const openDetail = async (id: number) => {
    const data = await api<any>(`/scripts/${id}`);
    setDetail(data);
  };

  const openGoalConfig = async (scriptId?: number) => {
    try {
      const script = scriptId && scriptId !== detail?.id ? await api<any>(`/scripts/${scriptId}`) : detail;
      if (!script) return;
      setDetail(script);
      goalForm.setFieldsValue({ semanticGoalRows: semanticQuestionsToRows(script.questionSeq || []) });
      setGoalConfigOpen(true);
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  const saveGoalConfig = async () => {
    let bySeq: Record<string, any[]>;
    try {
      await goalForm.validateFields();
      bySeq = semanticRowsToGoalsBySeq(goalForm.getFieldValue('semanticGoalRows') || []);
    } catch (error) {
      message.error((error as Error).message || '请检查目标配置');
      return;
    }

    const goalsBySeq = new Map(Object.entries(bySeq).map(([seq, goals]) => [Number(seq), goals]));
    const questionSeq = (detail.questionSeq || []).map((question: any) => ({
      ...question,
      semanticGoals: goalsBySeq.get(question.seq) || [],
    }));
    setSavingGoals(true);
    try {
      await api(`/scripts/${detail.id}`, { method: 'PUT', body: { questionSeq } });
      setDetail({ ...detail, questionSeq });
      setGoalConfigOpen(false);
      message.success('语义目标已保存；新接待会使用此配置，进行中的会话保留开局快照');
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSavingGoals(false);
    }
  };

  /**
   * 删除剧本（含已被练过的）：物理删除，历史接待明细不受影响
   * （会话的问题/商品快照存在会话自己身上，《明细》剧本名兜底显示「已删除剧本」）。
   */
  const removeScripts = async (ids: number[]) => {
    if (!ids.length) return;
    try {
      const res = await api<any>('/scripts/batch-delete', { method: 'POST', body: { ids } });
      message.success(`已删除 ${res.deleted} 个剧本`);
      setSelectedIds([]);
      load({ page: 1 });
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  /** 批量改分类：勾选的剧本统一归到一个分类，新分类名会自动登记进《数据字典》 */
  const applyCategory = async () => {
    const name = categoryValue.trim();
    if (!name) {
      message.warning('请选择或输入分类名称');
      return;
    }
    setCategorySaving(true);
    try {
      const res = await api<any>('/scripts/batch-update-category', { method: 'POST', body: { ids: selectedIds, category: name } });
      message.success(`已将 ${res.updated} 个剧本的分类改为「${res.category}」`);
      setCategoryOpen(false);
      setCategoryValue('');
      setSelectedIds([]);
      load({ page: 1 });
      loadOptions();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setCategorySaving(false);
    }
  };

  return (
    <Card
      className="page-card"
      bordered={false}
      title="剧本列表"
      extra={
        <Space>
          <Input.Search
            placeholder="搜索剧本名称 / 编号"
            allowClear
            style={{ width: 220 }}
            onSearch={(v) => load({ keyword: v, page: 1 })}
          />
          <Select
            allowClear
            placeholder="接待类型"
            style={{ width: 120 }}
            onChange={(v) => load({ stage: v, page: 1 })}
            options={[
              { value: 'presale', label: '售前' },
              { value: 'aftersale', label: '售后' },
            ]}
          />
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="剧本分类"
            style={{ width: 130 }}
            onChange={(v) => load({ category: v, page: 1 })}
            options={(options.scriptCategories || []).map((c: any) => ({ value: c.name, label: c.name }))}
          />
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="买家风格"
            style={{ width: 140 }}
            onChange={(v) => load({ styleId: v, page: 1 })}
            options={(options.styles || []).map((s: any) => ({ value: s.id, label: s.name }))}
          />
          <Button
            disabled={!selectedIds.length}
            onClick={() => {
              setCategoryValue('');
              setCategoryOpen(true);
            }}
          >
            批量改分类{selectedIds.length ? `（${selectedIds.length}）` : ''}
          </Button>
          <Popconfirm
            title={`确认删除选中的 ${selectedIds.length} 个剧本？`}
            description="删除后不可恢复；历史接待明细不受影响"
            onConfirm={() => removeScripts(selectedIds)}
            disabled={!selectedIds.length}
          >
            <Button danger icon={<DeleteOutlined />} disabled={!selectedIds.length}>
              批量删除{selectedIds.length ? `（${selectedIds.length}）` : ''}
            </Button>
          </Popconfirm>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setBatchOpen(true);
              form.resetFields();
              setStep(0);
            }}
          >
            新建剧本
          </Button>
          <Button
            icon={<BarChartOutlined />}
            onClick={async () => {
              try {
                setStats(await api<any>('/scripts/stats'));
              } catch (e) {
                message.error((e as Error).message);
              }
            }}
          >
            剧本统计
          </Button>
          <Button icon={<QuestionCircleOutlined />} onClick={() => setGuideOpen(true)}>
            使用说明
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => load()}>
            刷新
          </Button>
        </Space>
      }
    >
      <Table
        rowKey="id"
        loading={loading}
        dataSource={list}
        rowSelection={{
          selectedRowKeys: selectedIds,
          onChange: (keys) => setSelectedIds(keys.map(Number)),
          preserveSelectedRowKeys: false,
        }}
        pagination={{
          total,
          current: query.page,
          pageSize: query.pageSize,
          showSizeChanger: true,
          showTotal: (t) => `共 ${t} 个剧本`,
          onChange: (page, pageSize) => load({ page, pageSize }),
        }}
        columns={[
          { title: '剧本编号', dataIndex: 'scriptNo', width: 170 },
          { title: '剧本名称', dataIndex: 'name', ellipsis: true },
          { title: '剧本分类', dataIndex: 'category', width: 100, render: (v) => v || '-' },
          { title: '接待类型', dataIndex: 'stage', width: 100, render: (v) => (v === 'aftersale' ? '售后' : '售前') },
          { title: '买家风格', dataIndex: 'styleName', width: 120 },
          {
            title: '轮数',
            dataIndex: 'rounds',
            width: 90,
            render: (v: number) => (v < 6 ? <Tag color="orange">{v} 轮</Tag> : <Tag color="green">{v} 轮</Tag>),
          },
          { title: '被练次数', dataIndex: 'practicedCount', width: 90 },
          { title: '平均分', dataIndex: 'avgScore', width: 90, render: (v) => (v === null ? '-' : Number(v).toFixed(1)) },
          {
            title: '状态',
            dataIndex: 'status',
            width: 90,
            render: (v) => (v === 1 ? <Tag color="blue">启用</Tag> : <Tag>停用</Tag>),
          },
          {
            title: '操作',
            width: 220,
            render: (_, row: any) => (
              <Space size={0}>
                <Button type="link" onClick={() => openDetail(row.id)}>
                  预览
                </Button>
                <Button type="link" onClick={() => void openGoalConfig(row.id)}>
                  配置目标
                </Button>
                <Popconfirm
                  title="确认删除该剧本？"
                  description="删除后不可恢复；历史接待明细不受影响"
                  onConfirm={() => removeScripts([row.id])}
                >
                  <Button type="link" danger>
                    删除
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      {/* 异步批量生成进度（方案 3.3：超过 100 条以进度条展示，支持中途取消） */}
      <Modal open={!!genTask} title="批量生成剧本" footer={null} closable={false} width={460}>
        <Progress
          percent={Math.round(((genTask?.createdCount || 0) / Math.max(1, genTask?.total || 1)) * 100)}
          status={genTask?.status === 'running' ? 'active' : genTask?.status === 'failed' ? 'exception' : 'success'}
        />
        <Typography.Text type="secondary">
          已生成 {genTask?.createdCount || 0} / {genTask?.total || 0} 个剧本
          {genTask?.failedCount ? `（失败 ${genTask.failedCount} 个）` : ''}
        </Typography.Text>
        {genTask?.message ? (
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
            {genTask.message}
          </Typography.Paragraph>
        ) : null}
        <div style={{ marginTop: 16, textAlign: 'right' }}>
          {genTask?.status === 'running' ? (
            <Button onClick={cancelGenTask}>取消（已生成的保留）</Button>
          ) : (
            <Button type="primary" onClick={() => setGenTask(null)}>
              知道了
            </Button>
          )}
        </div>
      </Modal>

      {/* 批量改分类（2026-10-09 客户新增）：勾选剧本后统一归到一个分类，新分类自动登记进字典 */}
      <Modal
        open={categoryOpen}
        title={`批量修改分类（已选 ${selectedIds.length} 个剧本）`}
        onCancel={() => setCategoryOpen(false)}
        onOk={applyCategory}
        okText="确认修改"
        cancelText="取消"
        confirmLoading={categorySaving}
        width={420}
        destroyOnClose
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          从字典中选择已有分类，或直接输入新分类名（新分类会自动登记到《数据字典》的「剧本分类」中）。
        </Typography.Paragraph>
        <AutoComplete
          value={categoryValue}
          onChange={(v) => setCategoryValue(v)}
          style={{ width: '100%' }}
          placeholder="选择或输入分类名称"
          options={(options.scriptCategories || []).map((c: any) => ({ value: c.name, label: `${c.name}（现有 ${c.scriptCount ?? 0} 个剧本）` }))}
          filterOption={(input, option) => String(option?.value || '').includes(input)}
        />
      </Modal>

      <Modal
        open={batchOpen}
        title="新建聊天剧本"
        onCancel={() => setBatchOpen(false)}
        width={760}
        destroyOnClose
        footer={
          <Space>
            <Button onClick={() => setBatchOpen(false)}>取消</Button>
            {step > 0 ? <Button onClick={() => setStep(step - 1)}>上一步</Button> : null}
            {step < 2 ? (
              <Button type="primary" onClick={nextStep}>
                下一步
              </Button>
            ) : (
              <Button type="primary" onClick={generate}>
                生成剧本
              </Button>
            )}
          </Space>
        }
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{ category: '培训', stage: 'presale', createMode: 'batch', createWay: 'custom', ruleMode: 'keyword' }}
        >
          {/* 客户 2026-10-10：三段式向导——每一步只渲染本步字段，眼不见为净 */}
          <Steps
            size="small"
            current={step}
            style={{ marginBottom: 20 }}
            items={[{ title: '基础设置' }, { title: '剧本信息' }, { title: '剧本内容' }]}
          />

          <div className="script-section" style={{ display: step === 0 ? 'block' : 'none' }}>
            <div className="script-section-title">基础设置</div>
            <Form.Item name="createMode" label="创建模式" rules={[{ required: true }]}>
              <Radio.Group>
                <Radio value="single">单个剧本</Radio>
                <Radio value="batch">批量剧本</Radio>
              </Radio.Group>
            </Form.Item>
            <Form.Item name="createWay" label="创建方式" rules={[{ required: true }]}>
              <Radio.Group>
                <Radio value="custom">自定义创建</Radio>
                <Radio value="case">根据聊天案例创建</Radio>
              </Radio.Group>
            </Form.Item>
            {createWay !== 'case' && (
              <>
                <Form.Item name="ruleMode" label="规则模式" rules={[{ required: true }]}>
                  <Radio.Group>
                    <Radio value="keyword">关键词规则（现有模式）</Radio>
                    <Radio value="semantic">自动生成语义目标（推荐）</Radio>
                  </Radio.Group>
                </Form.Item>
              </>
            )}
            {createWay === 'case' && (
              <Form.Item name="caseId" label="选择案例" rules={[{ required: true, message: '请选择案例' }]}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  placeholder="从《案例收藏》里挑一个真实会话作为剧本来源"
                  options={(options.cases || []).map((item: any) => ({
                    value: item.id,
                    label: `${item.title}（${item.messageCount} 条消息）`,
                  }))}
                />
              </Form.Item>
            )}
            <Form.Item name="category" label="剧本分类" rules={[{ required: true, message: '请选择剧本分类' }]}>
              <Select
                style={{ width: 200 }}
                placeholder="请选择剧本分类"
                // 选项来自《数据字典》的「剧本分类」，字典里增删改这里同步生效
                options={(options.scriptCategories.length
                  ? options.scriptCategories.map((c: any) => c.name)
                  : ['培训', '售前', '售后', '退款', '物流', '其他']
                ).map((v) => ({ value: v, label: v }))}
              />
            </Form.Item>
            <Form.Item name="name" label="剧本名称" tooltip="批量生成时自动拼接为「接待类型-背景-内容」，无需手动填写">
              <Input
                placeholder="自动生成剧本名称，无需手动填写"
                maxLength={100}
                showCount
                disabled={createMode !== 'single'}
              />
            </Form.Item>
          </div>

          <div className="script-section" style={{ display: step === 1 ? 'block' : 'none' }}>
            <div className="script-section-title">剧本信息</div>
            <Form.Item name="stage" label="接待类型" rules={[{ required: true }]}>
              <Radio.Group>
                <Radio value="presale">售前</Radio>
                <Radio value="aftersale">售后</Radio>
              </Radio.Group>
            </Form.Item>
            {createMode === 'single' ? (
              <Form.Item name="styleId" label="买家沟通风格" rules={[{ required: true, message: '请选择沟通风格' }]}>
                <Select
                  style={{ width: 240 }}
                  options={options.styles.map((s) => ({ value: s.id, label: s.name }))}
                />
              </Form.Item>
            ) : null}
            <Form.Item name="productIds" label="关联商品" rules={[{ required: true, message: '请选择商品' }]}>
              <Select
                mode="multiple"
                placeholder="剧本必须关联至少一个商品"
                options={options.products.map((p) => ({ value: p.id, label: p.title }))}
                optionFilterProp="label"
              />
            </Form.Item>
            {selectedProducts.length ? (
              <div className="script-product-preview">
                {selectedProducts.slice(0, 5).map((p) => (
                  <div key={p.id} className="script-product-thumb" title={p.title}>
                    {p.coverUrl ? <img src={p.coverUrl} alt="" /> : <ShoppingOutlined />}
                  </div>
                ))}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  已选择 {selectedProducts.length} 个商品
                </Typography.Text>
              </div>
            ) : null}
          </div>

          <div className="script-section" style={{ display: step === 2 ? 'block' : 'none' }}>
            <div className="script-section-title">剧本内容</div>
            <Space wrap size={8} style={{ marginBottom: 8 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                按分类筛选：
              </Typography.Text>
              <Select
                size="small"
                allowClear
                style={{ width: 150 }}
                placeholder="背景分类"
                value={bgCatFilter}
                options={bgCategories.map((c) => ({ value: c, label: c }))}
                onChange={(v) => {
                  setBgCatFilter(v);
                  // 切换分类时清掉已选背景，避免把不可见分类下的选择静默带进生成数量
                  form.setFieldValue('bgIds', []);
                }}
              />
            </Space>
            <Form.Item
              name="bgIds"
              label="买家咨询背景"
              extra="分段式选择：先在上面选一个背景分类，再在该分类下勾选背景；支持输入关键词搜索，选择多个买家咨询背景将生成多个剧本"
              rules={[{ required: true, message: '请选择背景' }]}
            >
              <Select
                mode="multiple"
                maxTagCount="responsive"
                placeholder={bgCatFilter ? `请在「${bgCatFilter}」分类下选择背景` : '请先在上面选择一个背景分类'}
                options={bgCatFilter ? groupByCategory(filteredBackgrounds, 'name') : []}
                optionFilterProp="label"
              />
            </Form.Item>
            <Space wrap size={8} style={{ marginBottom: 8 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                按分类筛选：
              </Typography.Text>
              <Select
                size="small"
                allowClear
                style={{ width: 150 }}
                placeholder="模板分类"
                value={qaCatFilter}
                options={qaCategories.map((c) => ({ value: c, label: c }))}
                onChange={(v) => {
                  setQaCatFilter(v);
                  // 切换分类时清掉已选内容，避免把不可见分类下的选择静默带进生成数量
                  form.setFieldValue('qaIds', []);
                }}
              />
              {options.dimensions.length ? (
                <>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    按维度筛选：
                  </Typography.Text>
                  {options.dimensions.map((dim) => (
                    <Select
                      key={dim.id}
                      size="small"
                      allowClear
                      style={{ width: 150 }}
                      placeholder={dim.name}
                      value={qaDimFilters[dim.name]}
                      options={(dim.values || []).map((v: any) => ({ value: v.name, label: v.name }))}
                      onChange={(v) => {
                        setQaDimFilters((p) => ({ ...p, [dim.name]: v }));
                        form.setFieldValue('qaIds', []);
                      }}
                    />
                  ))}
                </>
              ) : null}
            </Space>
            <Form.Item
              name="qaIds"
              label="买家咨询内容"
              extra="分段式选择：先在上面选一个模板分类，再在该分类下勾选内容；支持输入关键词搜索，选择多个买家咨询内容将生成多个剧本"
              rules={[{ required: true, message: '请选择咨询内容' }]}
            >
              <Select
                mode="multiple"
                maxTagCount="responsive"
                placeholder={qaCatFilter ? `请在「${qaCatFilter}」分类下选择咨询内容` : '请先在上面选择一个模板分类'}
                options={qaCatFilter ? groupByCategory(filteredContents, 'templateName') : []}
                optionFilterProp="label"
              />
            </Form.Item>
            {ruleMode === 'semantic' && (
              <Alert
                type="info"
                showIcon
                style={{ marginTop: 16 }}
                message="系统会自动整理语义目标"
                description="创建时根据所选咨询内容的问题和考核要点，为每轮生成初始目标与认可说法，并结合买家背景标注场景。生成后可在剧本列表打开“预览”，点击“配置语义目标”进行调整。"
              />
            )}
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
              生成数量 = 背景数 × 内容数；买家沟通风格按《沟通风格》中的占比自动分配，提问序列不足 6 轮时由补充追问池自动补足。
            </Typography.Paragraph>
          </div>
        </Form>
      </Modal>

      <Drawer open={!!detail} title="剧本预览" width={620} onClose={() => setDetail(null)}>
        {detail && (
          <>
            <Typography.Title level={5}>{detail.name}</Typography.Title>
            <Space wrap style={{ marginBottom: 12 }}>
              <Tag>{detail.scriptNo}</Tag>
              {detail.category ? <Tag color="geekblue">{detail.category}</Tag> : null}
              <Tag color="blue">{detail.stage === 'aftersale' ? '售后' : '售前'}</Tag>
              <Tag color="purple">{detail.styleName}</Tag>
              <Tag>{detail.roundsWarning || '轮数符合要求'}</Tag>
            </Space>
            <Typography.Paragraph type="secondary">
              买家背景：{detail.bgName}
              <br />
              咨询内容：{detail.qaTemplate}
              <br />
              买家接受方案：{detail.acceptedAnswer || '未填写'}
            </Typography.Paragraph>
            <Button style={{ marginBottom: 12 }} onClick={() => void openGoalConfig()}>配置语义目标</Button>
            <Timeline
              items={(detail.questionSeq || []).map((q: any) => ({
                color: 'blue',
                children: (
                  <div>
                    <Typography.Text strong>
                      第 {q.seq} 轮：{q.question}
                    </Typography.Text>
                    <div style={{ fontSize: 12, color: '#8c8c8c' }}>期望要点：{q.keyPoints.join('、')}</div>
                  </div>
                ),
              }))}
            />
          </>
        )}
      </Drawer>

      <Modal
        open={goalConfigOpen}
        title="配置语义目标"
        width={880}
        onCancel={() => setGoalConfigOpen(false)}
        onOk={saveGoalConfig}
        confirmLoading={savingGoals}
        okText="保存配置"
      >
        <Form form={goalForm} layout="vertical">
          <div style={{ maxHeight: '65vh', overflowY: 'auto', paddingRight: 8 }}>
            <SemanticGoalBuilder
              roundLabels={Object.fromEntries((detail?.questionSeq || []).map((question: any) => [question.seq, question.question]))}
            />
          </div>
        </Form>
      </Modal>

      {/* 剧本统计（方案 F3-12）：被练次数、平均分、超时率，用来识别难点剧本 */}
      <Drawer open={!!stats} title="剧本统计" width={760} onClose={() => setStats(null)}>
        {stats && (
          <>
            <Space size={24} style={{ marginBottom: 16 }} wrap>
              <Typography.Text>
                剧本总数 <b>{stats.totals.scripts}</b>
              </Typography.Text>
              <Typography.Text>
                练过的剧本 <b>{stats.totals.practicedScripts}</b>
              </Typography.Text>
              <Typography.Text>
                累计会话 <b>{stats.totals.sessions}</b>
              </Typography.Text>
              <Typography.Text>
                整体超时率 <b>{stats.totals.timeoutRate}%</b>
              </Typography.Text>
              <Typography.Text>
                平均分 <b>{stats.totals.avgScore ?? '—'}</b>
              </Typography.Text>
            </Space>
            {stats.totals.sessions === 0 ? (
              <Alert
                type="info"
                showIcon
                message="还没有已结束的接待，练过之后这里会给出每个剧本的被练次数、平均分与超时率。"
              />
            ) : (
              <>
                <Typography.Title level={5}>最需要补练的剧本</Typography.Title>
                <Table
                  rowKey="id"
                  size="small"
                  pagination={false}
                  style={{ marginBottom: 20 }}
                  dataSource={stats.hardest}
                  columns={[
                    { title: '剧本', dataIndex: 'name', ellipsis: true },
                    { title: '被练次数', dataIndex: 'practicedCount', width: 100 },
                    {
                      title: '超时率',
                      dataIndex: 'timeoutRate',
                      width: 100,
                      render: (value: number) => <Tag color={value >= 30 ? 'red' : value > 0 ? 'orange' : 'green'}>{value}%</Tag>,
                    },
                    { title: '平均分', dataIndex: 'avgScore', width: 100, render: (value: any) => value ?? '—' },
                  ]}
                />
                <Typography.Title level={5}>
                  剧本明细（按被练次数排序，展示前 {stats.totals.listed ?? stats.rows.length} 个）
                </Typography.Title>
                <Table
                  rowKey="id"
                  size="small"
                  dataSource={stats.rows}
                  pagination={{ pageSize: 10, showTotal: (t) => `共 ${t} 个剧本` }}
                  columns={[
                    { title: '编号', dataIndex: 'scriptNo', width: 150 },
                    { title: '剧本', dataIndex: 'name', ellipsis: true },
                    { title: '分类', dataIndex: 'category', width: 110 },
                    { title: '被练次数', dataIndex: 'practicedCount', width: 100 },
                    { title: '会话数', dataIndex: 'sessionCount', width: 90 },
                    { title: '超时会话', dataIndex: 'timeoutSessions', width: 100 },
                    {
                      title: '超时率',
                      dataIndex: 'timeoutRate',
                      width: 90,
                      render: (value: number) => `${value}%`,
                    },
                    { title: '平均分', dataIndex: 'avgScore', width: 90, render: (value: any) => value ?? '—' },
                  ]}
                />
              </>
            )}
          </>
        )}
      </Drawer>

      {/* 使用说明（2026-10-08 客户新增）：剧本管理操作说明卡 */}
      <Modal
        open={guideOpen}
        title="剧本管理 · 使用说明"
        onCancel={() => setGuideOpen(false)}
        footer={null}
        width={560}
        destroyOnClose
      >
        <div style={{ maxHeight: '70vh', overflow: 'auto', textAlign: 'center' }}>
          <img src="/guide/script-manage-guide.png" alt="剧本管理使用说明" style={{ width: '100%', maxWidth: 460 }} />
        </div>
      </Modal>
    </Card>
  );
}
