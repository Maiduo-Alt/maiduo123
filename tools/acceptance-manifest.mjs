/**
 * 验收清单的「证据映射」：把方案里的每条功能点，对到当前代码库里可核查的证据。
 *
 * 条目本身不在这里维护 —— `tools/acceptance-audit.mjs` 会直接从
 * `docs/方案源稿.md` 的 F 编号表里解析出 id / 名称 / 范围，
 * 这里只负责「这条功能，用哪些文件、接口、用例来证明它存在」。
 *
 * 证据类型：
 *   file   文件存在
 *   dir    目录下至少有一个 .ts
 *   route  `METHOD /path` 出现在后端 controller 里
 *   ui     前端文件存在，可写成 `path#关键字` 表示文件里必须出现该关键字
 *   test   测试文件存在，可写成 `path#用例名关键字`
 */

/** 模块级默认证据：模块里所有条目先按这个算，条目自己有覆盖就用条目的。 */
export const MODULE_EVIDENCE = {
  F1: [
    { kind: 'file', value: 'backend/src/modules/reception/reception.service.ts' },
    { kind: 'file', value: 'backend/src/modules/reception/reception.gateway.ts' },
    { kind: 'ui', value: 'frontend/src/pages/Reception.tsx' },
    { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts' },
  ],
  F2: [
    { kind: 'file', value: 'backend/src/modules/records/records.service.ts' },
    { kind: 'ui', value: 'frontend/src/pages/Records.tsx' },
    { kind: 'ui', value: 'frontend/src/pages/RecordDetail.tsx' },
    { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts' },
  ],
  F3: [
    { kind: 'file', value: 'backend/src/modules/materials/materials.service.ts' },
    { kind: 'file', value: 'backend/src/modules/scripts/scripts.service.ts' },
    { kind: 'ui', value: 'frontend/src/pages/Backgrounds.tsx' },
    { kind: 'ui', value: 'frontend/src/pages/Scripts.tsx' },
    { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts' },
  ],
  F4: [
    { kind: 'file', value: 'backend/src/modules/products/products.service.ts' },
    { kind: 'ui', value: 'frontend/src/pages/Products.tsx' },
    { kind: 'test', value: 'backend/test/common/xlsx.spec.ts' },
    { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts' },
  ],
  F5: [
    { kind: 'file', value: 'backend/src/modules/cases/cases.service.ts' },
    { kind: 'ui', value: 'frontend/src/pages/Cases.tsx' },
    { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts' },
  ],
  F6: [
    { kind: 'file', value: 'backend/src/modules/tasks/tasks.service.ts' },
    { kind: 'ui', value: 'frontend/src/pages/Tasks.tsx' },
    { kind: 'test', value: 'backend/test/e2e/tasks.e2e-spec.ts' },
  ],
  F7: [
    { kind: 'file', value: 'backend/src/modules/styles/styles.service.ts' },
    { kind: 'file', value: 'backend/src/domain/style-ratio.ts' },
    { kind: 'file', value: 'backend/src/domain/emotion.ts' },
    { kind: 'ui', value: 'frontend/src/pages/Styles.tsx' },
    { kind: 'test', value: 'backend/test/domain/style-ratio.spec.ts' },
  ],
  F8: [
    { kind: 'file', value: 'backend/src/modules/accounts/accounts.service.ts' },
    { kind: 'file', value: 'backend/src/modules/auth/auth.service.ts' },
    { kind: 'file', value: 'backend/src/modules/settings/settings.service.ts' },
    { kind: 'file', value: 'backend/src/modules/phrases/phrases.service.ts' },
    { kind: 'ui', value: 'frontend/src/pages/Accounts.tsx' },
    { kind: 'ui', value: 'frontend/src/pages/Settings.tsx' },
    { kind: 'ui', value: 'frontend/src/pages/Phrases.tsx' },
  ],
};

/** 条目级覆盖：写得越具体，「已实现」的结论就越经得起追问。 */
export const ITEM_EVIDENCE = {
  // ---- F1 在线模拟接待 ----
  'F1-01': [
    { kind: 'route', value: 'GET /api/receptions/levels' },
    { kind: 'file', value: 'backend/src/domain/params.ts' },
    { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#难度解锁状态返回四档' },
    { kind: 'test', value: 'backend/test/e2e/client-requirements.e2e-spec.ts#接入人数可按档位配置' },
  ],
  'F1-02': [
    { kind: 'route', value: 'POST /api/receptions' },
    { kind: 'ui', value: 'frontend/src/pages/Reception.tsx#source' },
    { kind: 'test', value: 'backend/test/e2e/client-requirements.e2e-spec.ts#客服调自由练习被拦' },
    // 难度逐步解锁：后端开工前强制校验 + 界面上未解锁档位禁用（用户 2026-10-02 反馈的缺陷回归）
    { kind: 'test', value: 'backend/test/e2e/client-requirements.e2e-spec.ts#难度逐步解锁' },
    { kind: 'ui', value: 'frontend/src/pages/Reception.tsx#未解锁' },
  ],
  'F1-03': [
    { kind: 'file', value: 'backend/src/modules/reception/reception.service.ts' },
    { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#并发' },
  ],
  'F1-04': [
    { kind: 'ui', value: 'frontend/src/pages/Reception.tsx#conversation-item' },
    { kind: 'ui', value: 'frontend/src/styles.css#.reception-queue' },
    // 队列项含编号与商品标签、可点击切换（同一条浏览器用例覆盖 F1-04 / F1-05）
    { kind: 'test', value: 'tools/flow-check.mjs#会话队列与切换' },
  ],
  'F1-05': [
    { kind: 'ui', value: 'frontend/src/pages/Reception.tsx#selectSession' },
    { kind: 'ui', value: 'frontend/src/styles.css#.unread-dot' },
    // 浏览器里真的点第二个会话：顶部昵称跟着变、两个会话都还在（切换不丢状态）
    { kind: 'test', value: 'tools/flow-check.mjs#会话队列与切换' },
  ],
  'F1-06': [
    { kind: 'file', value: 'backend/src/domain/question-seq.ts' },
    { kind: 'file', value: 'backend/src/modules/reception/reception.gateway.ts' },
    { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#完整跑通一次接待' },
    { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#买家追加升级追问' },
    { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#剧本风格会影响买家消息的语气' },
  ],
  'F1-07': [
    { kind: 'route', value: 'GET /api/phrases' },
    { kind: 'ui', value: 'frontend/src/pages/Reception.tsx#insertPhrase' },
    { kind: 'test', value: 'backend/test/e2e/phrases.e2e-spec.ts' },
  ],
  'F1-08': [
    { kind: 'ui', value: 'frontend/src/pages/Reception.tsx#sendProductCard' },
    { kind: 'ui', value: 'frontend/src/styles.css#.consult-card' },
    // 浏览器里真的点「插入商品卡片」→ 输入框出现卡片文本 → 发送后对话流出现商品卡片气泡
    { kind: 'test', value: 'tools/flow-check.mjs#商品卡片插入对话' },
  ],
  'F1-09': [
    { kind: 'file', value: 'backend/src/domain/order.ts' },
    { kind: 'ui', value: 'frontend/src/components/OrderCard.tsx' },
    { kind: 'ui', value: 'frontend/src/pages/Reception.tsx#order-status-tabs' },
    { kind: 'ui', value: 'frontend/src/styles.css#.order-status-tabs' },
    { kind: 'test', value: 'backend/test/domain/order.spec.ts#三种状态的字段与参考图一致' },
    // 售后会话的订单卡要带「下单时间、金额、状态」
    { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#订单卡片的下单时间' },
    // 浏览器里真点开右栏「订单」页签：卡片字段齐全、状态与问题阶段一致、卡片里的「发送」能进输入框
    { kind: 'test', value: 'tools/flow-check.mjs#右栏订单卡片与问题阶段一致' },
    { kind: 'test', value: 'tools/render-check.mjs#订单状态与问题阶段对应' },
  ],
  'F1-10': [
    { kind: 'file', value: 'backend/src/modules/reception/reception.service.ts' },
    { kind: 'ui', value: 'frontend/src/pages/Reception.tsx#beep' },
    { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#超时' },
  ],
  'F1-11': [
    { kind: 'route', value: 'POST /api/receptions/:id/sessions/:sessionId/transfer' },
    { kind: 'route', value: 'POST /api/receptions/:id/sessions/:sessionId/finish' },
    // 「需转交的问题在客服点击转交后判定为正确处理」——scoring 规则此前没有用例
    { kind: 'test', value: 'backend/test/domain/scoring.spec.ts#需转交的问题' },
  ],
  'F1-12': [
    { kind: 'file', value: 'backend/src/domain/scoring.ts' },
    { kind: 'route', value: 'POST /api/receptions/:id/finish' },
    { kind: 'test', value: 'backend/test/domain/scoring.spec.ts' },
  ],
  'F1-13': [
    { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#重启' },
    { kind: 'file', value: 'backend/src/modules/reception/reception.gateway.ts' },
  ],
  'F1-14': [
    { kind: 'route', value: 'POST /api/records/:id/annotations' },
    { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#批注' },
  ],

  // ---- F2 模拟接待明细 ----
  'F2-01': [
    { kind: 'route', value: 'GET /api/records' },
    { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#完整跑通一次接待' },
    { kind: 'test', value: 'backend/test/e2e/reporting.e2e-spec.ts#明细导出为 Excel' },
  ],
  'F2-02': [
    { kind: 'ui', value: 'frontend/src/pages/Records.tsx#name="accountId"' },
    { kind: 'ui', value: 'frontend/src/pages/Records.tsx#DatePicker.RangePicker' },
    { kind: 'ui', value: 'frontend/src/pages/Records.tsx#name="conclusion"' },
    { kind: 'route', value: 'GET /api/records' },
    // 导出用例会逐项验证过滤条件对列表与导出同时生效
    { kind: 'test', value: 'backend/test/e2e/reporting.e2e-spec.ts#过滤条件与列表一致' },
  ],
  'F2-03': [
    { kind: 'route', value: 'GET /api/records/:id' },
    { kind: 'file', value: 'backend/src/domain/scoring.ts' },
    { kind: 'test', value: 'backend/test/e2e/reporting.e2e-spec.ts#明细详情带出会话级四维得分' },
    { kind: 'test', value: 'backend/test/domain/scoring.spec.ts#及时且完整回应时应接近满分' },
  ],
  'F2-04': [
    { kind: 'ui', value: 'frontend/src/pages/RecordDetail.tsx#会话回放' },
    { kind: 'test', value: 'tools/smoke-test.mjs#明细详情可回放' },
  ],
  'F2-05': [
    { kind: 'route', value: 'POST /api/records/annotations/:annotationId/reply' },
    { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#权限矩阵' },
  ],
  'F2-08': [
    { kind: 'route', value: 'GET /api/records/export' },
    { kind: 'ui', value: 'frontend/src/pages/Records.tsx#导出 Excel' },
    { kind: 'file', value: 'backend/src/common/xlsx-writer.ts' },
    { kind: 'test', value: 'backend/test/e2e/reporting.e2e-spec.ts#明细导出为 Excel' },
  ],

  // ---- F3 客户问题剧本 ----
  'F3-01': [
    { kind: 'route', value: 'POST /api/backgrounds' },
    { kind: 'test', value: 'backend/test/e2e/acceptance.e2e-spec.ts#被剧本引用的背景与内容不可删除' },
  ],
  'F3-02': [
    { kind: 'route', value: 'POST /api/contents' },
    { kind: 'test', value: 'backend/test/e2e/acceptance.e2e-spec.ts#被剧本引用的背景与内容不可删除' },
  ],
  'F3-03': [
    { kind: 'route', value: 'GET /api/categories' },
    { kind: 'route', value: 'PUT /api/categories/reorder' },
    { kind: 'ui', value: 'frontend/src/pages/Backgrounds.tsx#dropCategory' },
    // 新建分类 / 改名级联 / 分类列表（覆盖 F3-03 的分类维护）
    { kind: 'test', value: 'backend/test/e2e/admin-features.e2e-spec.ts#数据字典' },
  ],
  'F3-04': [
    { kind: 'route', value: 'POST /api/backgrounds/batch-delete' },
    { kind: 'route', value: 'POST /api/contents/batch-delete' },
    { kind: 'test', value: 'backend/test/e2e/acceptance.e2e-spec.ts#被剧本引用的背景与内容不可删除' },
  ],
  'F3-05': [
    { kind: 'route', value: 'POST /api/scripts' },
    { kind: 'test', value: 'backend/test/e2e/admin-features.e2e-spec.ts#按案例创建剧本' },
    // 参考图 4：新建剧本弹窗要分「基础设置 / 剧本信息 / 剧本内容」三段
    { kind: 'test', value: 'tools/flow-check.mjs#新建剧本弹窗' },
  ],
  'F3-06': [
    { kind: 'route', value: 'POST /api/scripts/batch-generate' },
    { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#剧本批量生成：背景 × 内容 交叉生成并按占比分配风格' },
    { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#4 背景 × 10 内容生成 40 个剧本' },
  ],
  'F3-08': [
    { kind: 'ui', value: 'frontend/src/pages/Scripts.tsx#售后' },
    { kind: 'test', value: 'backend/test/domain/extraction.spec.ts#L1 优先售前剧本，L3 优先售后剧本' },
    { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#4 背景 × 10 内容生成 40 个剧本' },
  ],
  'F3-09': [
    { kind: 'file', value: 'backend/src/modules/scripts/scripts.service.ts' },
    { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#商品与风格齐全' },
    { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#商品关联剧本数按数组元素精确统计' },
  ],
  'F3-10': [
    { kind: 'file', value: 'backend/src/domain/style-ratio.ts' },
    { kind: 'test', value: 'backend/test/domain/style-ratio.spec.ts' },
  ],
  'F3-11': [
    { kind: 'route', value: 'GET /api/scripts/:id/preview' },
    { kind: 'ui', value: 'frontend/src/pages/Scripts.tsx#preview' },
  ],
  'F3-13': [
    { kind: 'route', value: 'PUT /api/scripts/:id' },
    { kind: 'ui', value: 'frontend/src/pages/Scripts.tsx#status' },
    { kind: 'test', value: 'backend/test/e2e/acceptance.e2e-spec.ts#剧本全部停用后无法开局' },
  ],
  'F3-12': [
    { kind: 'route', value: 'GET /api/scripts/stats' },
    { kind: 'ui', value: 'frontend/src/pages/Scripts.tsx#剧本统计' },
    { kind: 'test', value: 'backend/test/e2e/reporting.e2e-spec.ts#剧本统计' },
  ],

  // ---- F4 商品库 ----
  'F4-01': [
    { kind: 'route', value: 'POST /api/products' },
    { kind: 'route', value: 'POST /api/uploads' },
    // 商品全字段创建（导入路径）与主图/详情图上传
    { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#图片上传' },
    { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#商品导入：Excel(.xlsx) 与 CSV' },
  ],
  'F4-02': [
    { kind: 'route', value: 'GET /api/products' },
    { kind: 'test', value: 'backend/test/e2e/reporting.e2e-spec.ts#商品导出为 Excel，列头与导入模板一致' },
    { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#100 条商品导入成功率' },
  ],
  'F4-03': [
    { kind: 'route', value: 'PUT /api/products/:id' },
    { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#下架商品不能用于新剧本' },
  ],
  'F4-04': [
    { kind: 'ui', value: 'frontend/src/pages/Products.tsx#场景' },
    { kind: 'route', value: 'GET /api/categories' },
    { kind: 'test', value: 'backend/test/e2e/admin-features.e2e-spec.ts#商品场景标签' },
    { kind: 'test', value: 'backend/test/e2e/admin-features.e2e-spec.ts#数据字典' },
  ],
  'F4-05': [
    { kind: 'ui', value: 'frontend/src/pages/Products.tsx#placeholder="最低价"' },
    { kind: 'ui', value: 'frontend/src/pages/Products.tsx#placeholder="状态"' },
    { kind: 'route', value: 'GET /api/products' },
    { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#商品列表支持关键词' },
  ],
  'F4-06': [
    { kind: 'route', value: 'POST /api/products/import' },
    { kind: 'route', value: 'GET /api/products/import-template' },
    { kind: 'test', value: 'backend/test/common/xlsx.spec.ts' },
  ],
  'F4-08': [
    { kind: 'ui', value: 'frontend/src/pages/Products.tsx#剧本' },
    { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#商品关联剧本数按数组元素精确统计' },
  ],
  'F4-09': [
    { kind: 'ui', value: 'frontend/src/pages/Reception.tsx#sendProductCard' },
    { kind: 'test', value: 'tools/flow-check.mjs#商品卡片插入对话' },
  ],
  'F4-07': [
    { kind: 'route', value: 'GET /api/products/export' },
    { kind: 'ui', value: 'frontend/src/pages/Products.tsx#导出 Excel' },
    { kind: 'test', value: 'backend/test/e2e/reporting.e2e-spec.ts#商品导出为 Excel' },
  ],

  // ---- F5 案例收藏 ----
  'F5-02': [
    { kind: 'route', value: 'POST /api/cases/import/text' },
    { kind: 'test', value: 'backend/test/e2e/cases.e2e-spec.ts#导入时可以打标签' },
  ],
  'F5-01': [
    { kind: 'route', value: 'POST /api/cases/import/file' },
    { kind: 'route', value: 'GET /api/cases/import/template' },
    { kind: 'ui', value: 'frontend/src/pages/Cases.tsx#导入文件' },
    { kind: 'test', value: 'backend/test/e2e/cases.e2e-spec.ts#文件导入' },
  ],
  'F5-03': [
    { kind: 'file', value: 'backend/src/domain/case-adapters.ts' },
    { kind: 'route', value: 'GET /api/cases/adapters' },
    { kind: 'test', value: 'backend/test/domain/case-adapters.spec.ts#平台适配器可以按同一接口注册进来' },
  ],
  'F5-06': [
    { kind: 'route', value: 'POST /api/cases/:id/to-content' },
    // 提取「买家咨询内容 + 买家接受方案」（此前只提问题、接受方案是占位提示）
    { kind: 'test', value: 'backend/test/e2e/cases.e2e-spec.ts#优秀回复会作为' },
  ],
  'F5-07': [
    { kind: 'route', value: 'POST /api/cases/messages/:messageId/excellent' },
    // 标记后要被真正用起来（作为转内容的参考答案话术），并有界面入口
    { kind: 'test', value: 'backend/test/e2e/cases.e2e-spec.ts#优秀回复会作为' },
    { kind: 'ui', value: 'frontend/src/pages/Cases.tsx#标为优秀回复' },
  ],
  'F5-04': [
    { kind: 'file', value: 'backend/src/modules/cases/cases.service.ts' },
    { kind: 'test', value: 'tools/smoke-test.mjs#案例文本导入成功' },
  ],
  'F5-05': [
    { kind: 'route', value: 'PUT /api/cases/:id' },
    { kind: 'ui', value: 'frontend/src/pages/Cases.tsx#mode="tags"' },
    { kind: 'test', value: 'backend/test/e2e/cases.e2e-spec.ts#导入时可以打标签' },
  ],
  'F5-08': [
    { kind: 'ui', value: 'frontend/src/pages/Cases.tsx#placeholder="标签"' },
    { kind: 'ui', value: 'frontend/src/pages/Cases.tsx#DatePicker.RangePicker' },
    { kind: 'test', value: 'backend/test/e2e/cases.e2e-spec.ts#列表能按标签' },
  ],
  'F5-09': [
    { kind: 'route', value: 'POST /api/cases/from-attempt' },
    { kind: 'ui', value: 'frontend/src/pages/RecordDetail.tsx#转为案例' },
    { kind: 'test', value: 'backend/test/e2e/cases.e2e-spec.ts#训练明细可以转为案例' },
  ],

  // ---- F6 回复模拟任务 ----
  'F6-01': [
    { kind: 'route', value: 'POST /api/tasks' },
    { kind: 'test', value: 'backend/test/e2e/tasks.e2e-spec.ts#带教下发的任务只对指定客服可见' },
  ],
  'F6-02': [{ kind: 'test', value: 'backend/test/e2e/tasks.e2e-spec.ts#targets' }],
  'F6-04': [
    { kind: 'test', value: 'backend/test/e2e/tasks.e2e-spec.ts#只对指定客服可见' },
    { kind: 'ui', value: 'frontend/src/pages/Tasks.tsx#assignees' },
  ],
  'F6-07': [
    { kind: 'file', value: 'backend/src/modules/tasks/tasks.service.ts' },
    { kind: 'test', value: 'backend/test/e2e/tasks.e2e-spec.ts#全部达标后任务自动标记完成' },
  ],
  'F6-08': [
    { kind: 'file', value: 'backend/src/modules/tasks/tasks.service.ts' },
    // 全部参与者达标后任务自动标记完成
    { kind: 'test', value: 'backend/test/e2e/tasks.e2e-spec.ts#全部达标后任务自动标记完成' },
    // 方案 3.6「截止后任务自动关闭」：自动关闭 + 过期不能开局（用户验收反馈同类问题的回归）
    { kind: 'test', value: 'backend/test/e2e/tasks.e2e-spec.ts#截止后任务自动关闭' },
    { kind: 'ui', value: 'frontend/src/pages/Tasks.tsx#截止' },
  ],
  'F6-09': [
    { kind: 'route', value: 'GET /api/tasks/:id/report' },
    // 方案 F6-09 明确要求「参与者、完成率、平均分、未通过名单」——补齐后加运行时断言
    { kind: 'test', value: 'backend/test/e2e/tasks.e2e-spec.ts#完成率与未通过名单' },
    { kind: 'ui', value: 'frontend/src/pages/Tasks.tsx#未通过名单' },
  ],
  'F6-03': [
    { kind: 'file', value: 'backend/src/domain/task-scope.ts' },
    { kind: 'ui', value: 'frontend/src/pages/Tasks.tsx#scopeType' },
    { kind: 'test', value: 'backend/test/domain/task-scope.spec.ts' },
    { kind: 'test', value: 'backend/test/e2e/tasks.e2e-spec.ts#只抽任务范围内的剧本' },
  ],
  'F6-05': [
    { kind: 'ui', value: 'frontend/src/pages/Dashboard.tsx#我的任务' },
    { kind: 'ui', value: 'frontend/src/pages/Reception.tsx#taskIdFromUrl' },
    { kind: 'ui', value: 'frontend/src/layouts/AppLayout.tsx#我的任务' },
    { kind: 'test', value: 'backend/test/e2e/admin-features.e2e-spec.ts#任务催办' },
  ],
  'F6-06': [
    { kind: 'ui', value: 'frontend/src/pages/Reception.tsx#task-card' },
    { kind: 'ui', value: 'frontend/src/styles.css#.task-card' },
    { kind: 'test', value: 'backend/test/e2e/tasks.e2e-spec.ts#快照' },
  ],
  'F1-15': [
    { kind: 'file', value: 'backend/src/domain/types.ts' },
    { kind: 'ui', value: 'frontend/src/pages/Settings.tsx#提示模式' },
    { kind: 'ui', value: 'frontend/src/pages/Reception.tsx#hintMode' },
    { kind: 'test', value: 'backend/test/e2e/admin-features.e2e-spec.ts#提示模式参数默认关闭' },
  ],
  'F2-06': [
    { kind: 'ui', value: 'frontend/src/pages/RecordDetail.tsx#标记为典型案例' },
    { kind: 'test', value: 'backend/test/e2e/cases.e2e-spec.ts#典型' },
  ],
  'F2-07': [
    { kind: 'ui', value: 'frontend/src/pages/Records.tsx#对比所选' },
    { kind: 'ui', value: 'frontend/src/pages/Records.tsx#接待对比' },
    { kind: 'test', value: 'backend/test/e2e/reporting.e2e-spec.ts#明细详情带出会话级四维得分' },
  ],
  'F2-09': [
    { kind: 'route', value: 'GET /api/records/trend' },
    { kind: 'ui', value: 'frontend/src/pages/Dashboard.tsx#成长曲线' },
    { kind: 'file', value: 'frontend/src/components/TrendChart.tsx' },
    { kind: 'test', value: 'backend/test/e2e/reporting.e2e-spec.ts#个人成长曲线' },
    // 默认口径已改为「当天每次模拟」（用户反馈：按天平均对新人没意义），按天仍可切换
    { kind: 'test', value: 'backend/test/e2e/reporting.e2e-spec.ts#当天每次模拟' },
    { kind: 'ui', value: 'frontend/src/pages/Dashboard.tsx#当天每次模拟' },
  ],
  'F3-07': [
    { kind: 'route', value: 'POST /api/scripts/from-case' },
    { kind: 'ui', value: 'frontend/src/pages/Scripts.tsx#根据聊天案例创建' },
    { kind: 'test', value: 'backend/test/e2e/admin-features.e2e-spec.ts#按案例创建剧本' },
  ],
  'F6-10': [
    { kind: 'route', value: 'GET /api/tasks/reminders' },
    { kind: 'ui', value: 'frontend/src/pages/Dashboard.tsx#训练任务催办' },
    { kind: 'test', value: 'backend/test/e2e/admin-features.e2e-spec.ts#任务催办' },
  ],
  'F7-08': [
    { kind: 'ui', value: 'frontend/src/pages/Styles.tsx#新建风格' },
    { kind: 'test', value: 'backend/test/e2e/admin-features.e2e-spec.ts#自定义风格模板' },
  ],
  'F8-10': [
    { kind: 'file', value: 'backend/src/modules/auth/auth.service.ts' },
    { kind: 'ui', value: 'frontend/src/layouts/AppLayout.tsx#请先修改密码' },
    { kind: 'ui', value: 'frontend/src/pages/Settings.tsx#登录失败锁定阈值' },
    { kind: 'test', value: 'backend/test/e2e/admin-features.e2e-spec.ts#登录安全策略' },
  ],
  'F8-11': [
    { kind: 'route', value: 'PUT /api/categories/:id' },
    { kind: 'ui', value: 'frontend/src/pages/Dictionary.tsx' },
    { kind: 'test', value: 'backend/test/e2e/admin-features.e2e-spec.ts#数据字典' },
    // 不变量：字典必须覆盖各类数据里「实际在用」的分类（剧本分类曾整个对不上）
    { kind: 'test', value: 'backend/test/e2e/admin-features.e2e-spec.ts#数据字典必须覆盖各类数据里实际在用的分类' },
  ],

  // ---- F7 沟通风格 ----
  'F7-01': [
    { kind: 'route', value: 'POST /api/styles' },
    { kind: 'test', value: 'backend/test/e2e/admin-features.e2e-spec.ts#自定义风格模板' },
    { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#沟通风格默认占比与方案 10.3 一致' },
  ],
  'F7-02': [
    { kind: 'route', value: 'PUT /api/styles/ratios' },
    { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#沟通风格占比校验' },
    { kind: 'test', value: 'backend/test/domain/style-ratio.spec.ts#占比总和超过 100%' },
  ],
  'F7-03': [
    { kind: 'file', value: 'backend/src/domain/style-ratio.ts' },
    { kind: 'test', value: 'backend/test/domain/style-ratio.spec.ts#100' },
  ],
  'F7-04': [
    { kind: 'file', value: 'backend/src/domain/style-ratio.ts' },
    // 「接待中按风格影响消息语气」（情绪化风格还会追加一句）
    { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#剧本风格会影响买家消息的语气' },
  ],
  'F7-05': [
    { kind: 'file', value: 'backend/src/domain/emotion.ts' },
    { kind: 'test', value: 'backend/test/domain/emotion.spec.ts' },
  ],
  'F7-06': [{ kind: 'test', value: 'backend/test/domain/style-ratio.spec.ts' }],
  'F7-07': [
    { kind: 'route', value: 'GET /api/styles/stats' },
    { kind: 'ui', value: 'frontend/src/pages/Styles.tsx#达标率' },
    { kind: 'test', value: 'backend/test/e2e/reporting.e2e-spec.ts#风格效果统计' },
  ],

  // 注意：F1-15 / F2-06 / F2-07 / F2-09 / F6-10 这几条「业务方确认不验收、但功能已实现」的条目，
  // 证据统一写在上面各自的位置（含 test 用例），**不要在这里再写一份**——
  // 同一个对象字面量里重复的 key 会被后面的覆盖，之前就是因为这里写了一份更简略的，
  // 把上面带用例的证据整份盖掉了（看板上表现为"这些条目的证据里没有 test"）。
  // 「不列入验收范围」这个状态由下面的 NOT_REQUIRED 表达，不需要靠重复定义来标记。

  // ---- F8 账号 ----
  'F8-01': [
    { kind: 'route', value: 'POST /api/auth/login' },
    { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#登录与鉴权' },
    { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#接口清单补齐：令牌续签' },
  ],
  'F8-02': [
    { kind: 'route', value: 'POST /api/accounts' },
    { kind: 'route', value: 'POST /api/accounts/:id/reset-password' },
    { kind: 'test', value: 'backend/test/e2e/acceptance.e2e-spec.ts#停用后无法登录' },
    { kind: 'test', value: 'backend/test/e2e/admin-features.e2e-spec.ts#登录安全策略' },
  ],
  'F8-03': [
    { kind: 'file', value: 'backend/src/common/decorators.ts' },
    { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#权限矩阵' },
  ],
  'F8-04': [
    { kind: 'route', value: 'GET /api/groups' },
    { kind: 'route', value: 'POST /api/groups' },
    { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#小组更新' },
  ],
  'F3-11': [
    { kind: 'route', value: 'GET /api/scripts/:id/preview' },
    { kind: 'ui', value: 'frontend/src/pages/Scripts.tsx#preview' },
    { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#剧本预览按对话流给出提问序列' },
  ],
  'F8-05': [
    { kind: 'route', value: 'GET /api/accounts/me' },
    { kind: 'file', value: 'backend/src/common/mask.ts' },
      { kind: 'ui', value: 'frontend/src/layouts/AppLayout.tsx#个人资料' },
      { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#个人资料：可保存昵称' },
    ],
  'F8-06': [
    { kind: 'route', value: 'POST /api/auth/change-password' },
    { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#支持自助修改密码' },
  ],
  'F8-07': [
    { kind: 'route', value: 'PUT /api/settings' },
    { kind: 'file', value: 'backend/src/domain/params.ts' },
    { kind: 'test', value: 'backend/test/domain/params.spec.ts' },
  ],
  'F8-08': [
    { kind: 'route', value: 'GET /api/phrases' },
    { kind: 'route', value: 'POST /api/phrases/:id/use' },
    { kind: 'ui', value: 'frontend/src/pages/Phrases.tsx' },
    { kind: 'file', value: 'backend/src/domain/phrase-vars.ts' },
    { kind: 'test', value: 'backend/test/e2e/phrases.e2e-spec.ts' },
  ],
  'F8-09': [
    { kind: 'file', value: 'backend/src/common/audit.interceptor.ts' },
    // 写操作落 action_logs、且不记录密码等敏感字段（用例本来就有，之前没登记）
    { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#操作审计' },
  ],
};

/**
 * 二期条目（以及个别一期条目）的补充说明。
 * 目的是让「没做」和「做了一半」都能说清楚，而不是只给一个红点。
 */
export const ITEM_NOTES = {
  'F1-09':
    '已实现（客户 2026-10-03 第三轮点名要求，从二期提前做掉）：右栏「订单」页签按三张参考图还原三态卡片——' +
    '待支付 / 待发货 / 已发货，字段与操作随状态变；推送问题时按问题阶段自动带出对应状态的订单；' +
    '售后入口以「代客发起售后」按钮呈现（话术动作），改价 / 去发货等平台侧写操作按占位禁用处理。',
  'F1-15': '已实现：系统参数里可开启「提示模式」并设置触发秒数；开启后客服长时间未回复会在输入区上方看到话术思路提示（仅教学用，不影响评分，默认关闭）。',
  'F1-02': '客户 2026-10-02 确认：任务训练与自由练习都计入解锁进度（方案原写「自由练习不计入」）；客服侧已不开放自由练习，新人实际由任务训练解锁。',
  'F2-06': '已实现：明细详情页可一键「标记为典型案例」，推入案例收藏并打上「典型案例」标签，可在案例页按标签筛选。',
  'F2-07': '已实现：明细列表勾选两次接待后「对比所选」，并排看总分、结论、四维得分与会话数。',
  'F2-08': '未做：暂无 Excel 明细或 PDF 报告导出。',
  'F2-09': '已实现：首页「我的成长曲线」按天展示最近 30 天总分 / 首响时长 / 超时次数，可切换指标；带教可指定查看某个客服。',
  'F3-07': '已实现：新建剧本弹窗支持「根据聊天案例创建」，案例的买家消息先沉淀成咨询内容再生成剧本。',
  'F3-12': '已实现：剧本列表可打开「剧本统计」，给出每个剧本的被练次数、平均分、超时率与难点剧本排行。',
  'F4-07': '已实现：商品库支持按当前筛选条件导出 Excel，列头与导入模板一致，改完能直接导回来。',
  'F5-01': '已实现：支持上传 Excel/CSV 会话文件导入（表头角色+内容，或单列「买家:内容」），并带失败行号与原因；提供模板下载。',
  'F5-03': '已实现适配器接口与注册点：解析逻辑抽象为 CaseImportAdapter，内置通用适配器，拿到抖店/千牛样例后按同一接口注册即可，页面「导入格式」会自动多一项。',
  'F5-05': '部分：案例表已有 tags 字段并在列表展示，但导入表单没有打标签入口。',
  'F5-08': '部分：接口支持关键词与阶段过滤，案例页尚未提供检索条。',
  'F5-09': '未做：明细页没有「把这次接待转为案例」的入口。',
  'F6-03': '已实现：任务可限定「全部 / 按剧本分类 / 按关联商品 / 指定剧本清单」，接待抽取剧本时按范围过滤。',
  'F6-05': '已实现：首页「我的任务」与接待页任务卡都会显示进度与截止倒计时，《回复模拟任务》对客服开放「我的任务」入口。',
  'F6-06': '已实现：任务训练时右栏常驻任务卡（任务名、达标条件、完成进度、截止倒计时）；自由练习不展示，符合一期「只预留、不展示」的口径。',
  'F6-10': '已实现：首页对「24 小时内到期 / 已过期但仍未完成」的任务给出催办提醒（站内提醒，不发短信邮件）。',
  'F7-07': '已实现：沟通风格页展示每种风格被练次数与达标率，并给出「最难应对的买家类型」。',
  'F7-08': '已实现：沟通风格页可新增自定义风格（编码、名称、特征、语气示例、情绪基线、是否情绪化）。',
  'F8-10': '已实现：连续登录失败锁定、密码有效期、管理员重置后强制首次改密；参数都在系统参数页可配。',
  'F8-11': '已实现：新增「数据字典」页统一维护背景/内容/剧本/商品分类与商品场景标签，改名会级联更新已引用它的素材。',
};

/**
 * 业务方明确「不做」的条目（2026-10-02 确认）。
 * 这些条目不再计入待办，也不再算进「还需交付」的分母；
 * 标记出来是为了防止以后换人接手时又被当成缺口去排期。
 */
export const EXCLUDED_ITEMS = {
  // 目前为空：原先标为「不做」的 5 条，主线程已经把功能做出来了，
  // 2026-10-02 业务方确认改按「已实现但不验收」处理（见 NOT_REQUIRED）。
  // 保留这个映射是为了以后真的有「业务方决定不做、代码也不存在」的条目时有地方登记。
};

/**
 * 业务方确认「不需要」、但功能已经做完的条目（2026-10-02）。
 * 与 EXCLUDED_ITEMS 的区别：这些**代码与数据都保留**，只是不列入验收范围，
 * 因此状态仍然是「已实现」，只额外打一个「不验收」的标记。
 */
export const NOT_REQUIRED = {
  'F2-05': '业务方确认不需要，不列入验收范围（功能保留：接口、页面、历史批注数据都不动）。',
  'F1-15': '业务方确认不需要，不列入验收范围（功能已实现并保留：系统参数页可开关「提示模式」，接待页在客服超时未回复时给出话术思路）。',
  'F2-06': '业务方确认不需要，不列入验收范围（功能已实现并保留：明细详情页可「标记为典型案例」）。',
  'F2-07': '业务方确认不需要，不列入验收范围（功能已实现并保留：明细列表可勾选两次接待做并排指标对比）。',
  'F2-09': '业务方确认不需要，不列入验收范围（功能已实现并保留：首页个人成长曲线 + GET /api/records/trend）。',
  'F6-10': '业务方确认不需要，不列入验收范围（功能已实现并保留：首页任务催办提醒 + GET /api/tasks/reminders）。',
};

/** 方案 9.1 / 9.2 / 9.3 的验收条目，同样对到可核查的证据。 */
/**
 * 方案外、由客户新增或变更的需求（登记在 docs/客户新增需求.md）。
 * 它们不在方案 F 编号里，但验收时要看得到，所以单独一栏展示。
 * status：done=已实现待验收 / skipped=客户确认不做。
 */
export const CLIENT_REQUIREMENTS = [
  {
    id: 'C1',
    type: '变更',
    title: '难度解锁条件：连续 2 次达标 → 达标 1 次',
    status: 'done',
    note: '任务训练与自由练习都计入解锁进度（方案 F1-02 原写「自由练习不计入」，已按客户口径覆盖）',
    evidence: [
      { kind: 'file', value: 'backend/src/domain/types.ts' },
      { kind: 'test', value: 'backend/test/domain/params.spec.ts#客户确认' },
      { kind: 'test', value: 'backend/test/e2e/client-requirements.e2e-spec.ts#达标 1 次即解锁下一档' },
    ],
  },
  {
    id: 'C2',
    type: '新增',
    title: '客服不开放模拟训练，入口只留管理员/主管',
    status: 'done',
    note: '菜单 / 接待页 / 首页三处入口收敛 + 后端开局校验返回 1003',
    evidence: [
      { kind: 'test', value: 'backend/test/e2e/client-requirements.e2e-spec.ts#客服调自由练习被拦' },
      { kind: 'ui', value: 'frontend/src/pages/Dashboard.tsx#模拟训练只对带教/管理员开放' },
      { kind: 'ui', value: 'frontend/src/pages/Reception.tsx#从《我的任务》进入训练' },
      // 运行时证据：真实浏览器里断言客服菜单没有「在线模拟接待」、首页没有快速开始
      { kind: 'test', value: 'tools/flow-check.mjs#入口收敛（无在线模拟接待）' },
    ],
  },
  {
    id: 'C3',
    type: '新增',
    title: '管理账号可设置各难度接入人数（口径①）',
    status: 'done',
    note: 'levelConcurrent 默认 1/2/3/4，实际接入 = min(本档人数, 并发接待上限)',
    evidence: [
      { kind: 'test', value: 'backend/test/e2e/client-requirements.e2e-spec.ts#接入人数可按档位配置' },
      { kind: 'ui', value: 'frontend/src/pages/Settings.tsx#接入人数' },
    ],
  },
  {
    id: 'C4',
    type: '不做',
    title: '首页新人引导',
    status: 'skipped',
    note: '客户确认由带教在训练前线下说明，不做页面引导',
    evidence: [],
  },
  {
    id: 'C5',
    type: '新增',
    title: '各档位可设「本次模拟总接待人数」（口径③）',
    status: 'done',
    note:
      '客户 2026-10-03 第三轮确认默认 10 人（此前是「默认空 = 回落接入人数」）；总量超过同时在线时，' +
      '多出的买家以「待接入」排队，**空位即补**（有会话进终态就补一个，几秒内进线——按赤兔火眼实测对齐）；' +
      '结束条件为「无待接入且全部终态」；服务重启后按同时在线重新补位',
    evidence: [
      { kind: 'test', value: 'backend/test/e2e/client-requirements.e2e-spec.ts#合计接待人数默认 10 人' },
      { kind: 'test', value: 'backend/test/e2e/client-requirements.e2e-spec.ts#总接待人数大于同时在线' },
      { kind: 'ui', value: 'frontend/src/pages/Settings.tsx#总接待人数' },
      { kind: 'ui', value: 'frontend/src/pages/Reception.tsx#剩余会话' },
    ],
  },
  {
    id: 'C6',
    type: '新增',
    title: '无效 / 敷衍回复判定 + 实时预警',
    status: 'done',
    note:
      '总开关默认关闭；重复判定（完全相同 / 连续 N 次，2～10）+ 未解决判定（连续 N 轮命中要点为 0，近似官方' +
      '「买家要求后仍未改善」）+ 业务方自定义敷衍词表（与禁用词库分离）；命中当场提醒并给该条消息打标，' +
      '明细页标注被判无效的轮次与依据，带教可按「含无效回复」筛选复盘；无效回复不计响应时长（回退到首条有效回复，' +
      '始终没有则记 600 秒）',
    evidence: [
      { kind: 'file', value: 'backend/src/domain/reply-validity.ts' },
      { kind: 'test', value: 'backend/test/domain/reply-validity.spec.ts#完全相同' },
      { kind: 'test', value: 'backend/test/e2e/client-requirements.e2e-spec.ts#重复回复被判无效' },
      { kind: 'ui', value: 'frontend/src/pages/Settings.tsx#非平台官方口径' },
      { kind: 'ui', value: 'frontend/src/pages/Records.tsx#invalid' },
    ],
  },
  {
    id: 'C7',
    type: '变更',
    title: '合计接待人数默认 10 人，管理员可提前设置',
    status: 'done',
    note:
      'DEFAULT_LEVEL_TOTAL = 10（四档都 10）；系统参数页预填 10、清空也回到 10；' +
      '管理员/主管仍可在开局时当场指定本局的合计人数与接入人数',
    evidence: [
      { kind: 'file', value: 'backend/src/domain/types.ts' },
      { kind: 'test', value: 'backend/test/domain/params.spec.ts' },
      { kind: 'ui', value: 'frontend/src/pages/Settings.tsx#总接待人数' },
      { kind: 'test', value: 'tools/demo-data.mjs#已还原合计接待人数设置' },
    ],
  },
  {
    id: 'C8',
    type: '新增',
    title: '订单三态 + 售前/售后以「发货」为节点自动带出订单',
    status: 'done',
    note:
      '售后问题 → 已发货；售前问发货/物流/时效 → 待发货；其余售前 → 待支付。' +
      '推送问题是每推一条就按该问的阶段重建订单（同一局同一笔订单在推进，下单时间以会话接入时间为锚点不漂移）；' +
      '平台侧写操作（改价/催付/去发货/改地址）点击后记为一次业务动作，不接平台写操作（见 C10）',
    evidence: [
      { kind: 'file', value: 'backend/src/domain/order.ts' },
      { kind: 'ui', value: 'frontend/src/components/OrderCard.tsx' },
      { kind: 'ui', value: 'frontend/src/pages/Reception.tsx#OrderCard' },
      { kind: 'test', value: 'backend/test/domain/order.spec.ts#推送哪条问题就配哪一态的订单' },
      { kind: 'test', value: 'tools/flow-check.mjs#右栏订单卡片与问题阶段一致' },
    ],
  },
  {
    id: 'C10',
    type: '新增',
    title: '订单卡片的平台侧操作「点击后记为一次业务动作」',
    status: 'done',
    note:
      '催付 / 改价 / 去发货 / 发货协商 / 代客发起售后 / 发售后卡 / 发物流卡 等按钮点了之后：' +
      '① 落一条 session_actions 记录（复盘里能看到这次接待点过哪些动作）；② 按动作给买家发一句标准话术' +
      '（复用回复链路，响应时长与要点命中照常算）；③ 业务动作话术不参与「无效/敷衍」判定——连点两次催付是正常操作。' +
      '动作与订单状态绑定：待支付才有催付/改价，待发货才有去发货/发货协商/发售后卡，已发货才有发物流卡。',
    evidence: [
      { kind: 'file', value: 'backend/src/domain/business-actions.ts' },
      { kind: 'route', value: 'POST /api/receptions/:id/sessions/:sessionId/actions' },
      { kind: 'file', value: 'backend/src/modules/records/records.service.ts' },
      { kind: 'test', value: 'backend/test/domain/business-actions.spec.ts#按钮按订单状态分组' },
      { kind: 'test', value: 'backend/test/e2e/client-requirements.e2e-spec.ts#C8：订单卡片的平台侧操作点击后记为一次业务动作' },
      { kind: 'test', value: 'tools/flow-check.mjs#业务动作「' },
    ],
  },
  {
    id: 'C9',
    type: '修正',
    title: '《我的训练》= 训练任务，《在线模拟接待》= 模拟训练',
    status: 'done',
    note:
      '首页原本摆着「难度档位与快速开始」卡（一键开自由练习），与页面语义相反；' +
      '现已移除；先换成一张「自由练习已统一放在《在线模拟接待》里」的提示卡，客户当天又要求整块删掉——' +
      '现在《我的训练》只留「我的任务」「我的最近接待」（+成长曲线），难度与开局统一收在《在线模拟接待》',
    evidence: [
      // 首页不再有难度卡/提示卡：Dashboard 里只保留客服侧那张「开始训练」卡
      { kind: 'ui', value: 'frontend/src/pages/Dashboard.tsx#开始训练' },
      // render-check 用「不应出现」的关键字反向锁住这次删除（难度卡、提示卡、去自由练习都不许再出现）
      { kind: 'test', value: 'tools/render-check.mjs#自由练习已统一放在《在线模拟接待》里' },
      { kind: 'test', value: 'tools/render-check.mjs#难度档位与快速开始' },
      { kind: 'test', value: 'tools/flow-check.mjs#入口收敛（无在线模拟接待）' },
    ],
  },
  {
    id: 'C11',
    type: '变更',
    title: '补位 = 空位即补；接待买家 = 累计已进线（按赤兔火眼实测对齐）',
    status: 'done',
    note:
      'Codex 在抖店工作台·赤兔火眼里完整跑完一场自由练习（10 个买家 / 最多同时 3 个）后实测：' +
      '赤兔是「空位即补」（任意一个买家结束，几秒内补进下一个，实测新买家等待时长 1～6 秒），' +
      '且左栏「接待买家」= 累计已进线（满足 接待买家 = 正在接待 + 已结束 + 转交），界面上没有排队名单。' +
      '据此把上一版的「整批换新」改回「空位即补」，并给新买家留 1.5～4.5 秒进线；' +
      '接待页「接待买家」改为已进线数（排队人数仍单独看「剩余会话 / 待接入」）。观察记录见 docs/赤兔火眼补位规则观察.md',
    evidence: [
      { kind: 'test', value: 'backend/test/e2e/client-requirements.e2e-spec.ts#空位即补（对齐赤兔火眼）' },
      { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#重启' },
      { kind: 'test', value: 'tools/flow-check.mjs#接待买家=累计已进线' },
      { kind: 'file', value: 'docs/赤兔火眼补位规则观察.md' },
    ],
  },
  {
    id: 'C12',
    type: '变更',
    title: '界面术语：「自由练习」统一改叫「模拟训练」',
    status: 'done',
    note:
      '客户 2026-10-03：「自由训练修改为模拟训练」——界面上原来叫「自由练习」的这套入口与来源标记，' +
      '统一改成「模拟训练」（与方案源稿 4 节的「模拟训练」说法一致）。改动范围：' +
      '接待页开局界面标题、客服引导页文案、首页客服侧提示、明细列表的来源列/筛选项/两次接待对比、' +
      '明细详情的来源、后端「客服暂未开放模拟训练」报错文案、明细导出的来源列。' +
      '「任务训练」保持不变；方案源稿（客户原始文档）里的「自由练习」原文不动，差异登记在这里。',
    evidence: [
      { kind: 'ui', value: 'frontend/src/pages/Reception.tsx#模拟训练（管理员 / 带教）' },
      { kind: 'ui', value: 'frontend/src/pages/Records.tsx#模拟训练' },
      { kind: 'ui', value: 'frontend/src/pages/Dashboard.tsx#模拟训练只对带教/管理员开放' },
      { kind: 'test', value: 'backend/test/e2e/client-requirements.e2e-spec.ts#模拟训练' },
      { kind: 'test', value: 'tools/render-check.mjs#模拟训练（管理员 / 带教）' },
    ],
  },
  {
    id: 'C13',
    type: '新增',
    title: '会话页对齐飞鸽 + 商品「规格/属性」显示商品库真实信息',
    status: 'done',
    note:
      '① 商品卡（买家首条「咨询宝贝」与客服插入的商品卡）统一渲染成飞鸽式卡片：图片 / 标题 / 价格 / 库存 / ' +
      '服务承诺标签 / 发货说明 / 动作按钮（… / 计算价格 / 邀请下单 / 规格·属性）；' +
      '② 会话头新增信息标签行（模拟训练或任务训练 + 商品ID + 更多）；' +
      '③ 输入区改成飞鸽文案「发送给 X，使用 Enter 发送消息…」并加字数计数；' +
      '④ 右栏「订单」页签顶部补「咨询宝贝」块；' +
      '⑤ 点「规格/属性」弹出**管理员在《商品库》配的真实商品信息**（规格 SKU 表、售价与划线价、库存、分类、' +
      '上架状态、服务承诺、适用场景、详情图），数据来自会话快照里的商品（pickProduct 已带全字段）；' +
      '⑥ 《商品库》商品编辑弹窗新增「规格（SKU）」维护入口（规格名/价格/库存，可增删），编辑回填与提交都带 skus。' +
      '注：左栏计数与三页签是 C5/C11 的客户要求，保持不动。',
    evidence: [
      { kind: 'file', value: 'frontend/src/components/ProductSpecModal.tsx' },
      { kind: 'ui', value: 'frontend/src/components/ProductSpecModal.tsx#规格（SKU）' },
      { kind: 'ui', value: 'frontend/src/pages/Reception.tsx#feige-product-card' },
      { kind: 'ui', value: 'frontend/src/pages/Products.tsx#添加规格' },
      { kind: 'file', value: 'backend/src/modules/reception/reception.service.ts' },
      // 客户 2026-10-03 修正：「订单」页签保留咨询宝贝，「商品」页签改成《商品库》的商品
      { kind: 'ui', value: 'frontend/src/pages/Reception.tsx#商品库' },
      { kind: 'test', value: 'tools/flow-check.mjs#商品「规格/属性」显示商品库真实信息' },
      { kind: 'test', value: 'tools/flow-check.mjs#商品库 · 编辑弹窗可维护规格（SKU）' },
      { kind: 'test', value: 'tools/flow-check.mjs#飞鸽版式元素' },
    ],
  },
  {
    id: 'C14',
    type: '新增',
    title: '推送问题按比例混合售前 / 售后（默认两成是「买完商品后」的订单类问题）',
    status: 'done',
    note:
      '客户 2026-10-03：「弹出的问题我需要增加设定，分为售前/售后两方面……推送的大部分为没有订单、咨询商品信息的问题，' +
      '小部分为买完商品后需要咨询订单修改、修改快递、催发货相关的问题。」' +
      '实现：新增系统参数 aftersaleQuestionRatio（默认 20%，0～80 可在系统参数页改）——' +
      '会话的问题序列以剧本本身的话题为主体（开场不动），把靠后的约 N% 轮次替换成另一阶段的题库：' +
      '售前剧本混入「买完商品后」的订单类问题（改收货地址 / 改快递 / 催发货 / 改单 / 改电话 / 备注配送），' +
      '售后剧本反向混入商品咨询类问题；题库见 db/seed-content.ts 的 ORDER_AFTERSALE_QUESTIONS / PRESALE_PRODUCT_QUESTIONS。' +
      '订单卡片跟着问题走，并顺带细化了售后口径：催发货 / 改地址 / 改快递这类「还没发货」的给待发货，' +
      '物流 / 签收 / 退换 / 质量这类「已经发出」的才给已发货（对应三张参考图）。',
    evidence: [
      { kind: 'file', value: 'backend/src/domain/question-seq.ts' },
      { kind: 'file', value: 'backend/src/db/seed-content.ts' },
      { kind: 'file', value: 'backend/src/domain/types.ts' },
      { kind: 'ui', value: 'frontend/src/pages/Settings.tsx#售后问题占比' },
      { kind: 'test', value: 'backend/test/domain/question-seq.spec.ts#售前 / 售后按比例混合' },
      { kind: 'test', value: 'backend/test/e2e/client-requirements.e2e-spec.ts#C14：售前 / 售后问题按比例混合' },
      { kind: 'test', value: 'backend/test/domain/order.spec.ts#还没发货」的订单类问题配待发货' },
    ],
  },
  {
    id: 'C15',
    type: '新增',
    title: '任务按商品种类下发 + 问题与商品强一致（不允许出现不一致）',
    status: 'done',
    note:
      '客户 2026-10-03：「商品设定种类，比如男装类、女装类等等分类，问题在推送的时候根据管理员发放培训任务时' +
      '设定的商品种类进行推送问题」＋「不可出现商品问题和实际商品需求进行的行为不一致的情况」。' +
      '实现：① 任务范围新增「按商品种类（男装/女装…）」——只抽「关联商品的分类」命中所选种类的剧本，' +
      '推送的问题也就围绕这些品类的商品；UI 里每个品类都标出当前有几个剧本可用，选到没有剧本的品类会明确报错。' +
      '② 新增 domain/product-consistency.ts 的品类一致性规则（服饰专属词只能配服饰类商品、鞋码→鞋靴、保质期→食品、' +
      '保修/续航→数码家电、孕期→母婴童装、肤质→美妆，其余通用问题任何品类都成立），并三处落地：' +
      'seed 生成剧本时按一致性挑商品、接待抽剧本时兜底过滤不一致的历史数据、测试里全量扫描锁不变量。' +
      '③ 剧本范围从「只做服装」放开到商品库全部 13 个品类，剧本仍是 900 条，且**全量扫描 0 条不一致**。' +
      '④ C14 的混合题库也收紧成「与品类无关」的问法（去掉尺码/面料类），避免补进来的问题与商品冲突。',
    evidence: [
      { kind: 'file', value: 'backend/src/domain/product-consistency.ts' },
      { kind: 'file', value: 'backend/src/domain/task-scope.ts' },
      { kind: 'file', value: 'backend/src/db/seed-content.ts' },
      { kind: 'file', value: 'backend/src/db/seed.ts' },
      { kind: 'ui', value: 'frontend/src/pages/Tasks.tsx#按商品种类' },
      { kind: 'test', value: 'backend/test/domain/product-consistency.spec.ts#内置内容库里的每条内容都能找到兼容的商品品类' },
      { kind: 'test', value: 'backend/test/domain/product-consistency.spec.ts#混合题库（C14）与全部商品品类都兼容' },
      { kind: 'test', value: 'backend/test/domain/task-scope.spec.ts#按商品种类' },
      { kind: 'test', value: 'backend/test/e2e/client-requirements.e2e-spec.ts#C15：任务按商品种类限定' },
    ],
  },
  {
    id: 'C16',
    type: '新增',
    title: '下发回复模拟任务时「剧本 + 商品」可同时多选（列表带「范围」列）',
    status: 'done',
    note:
      '客户 2026-10-03：「我指的是在设置回复接待任务的时候剧本和商品能够多选」。' +
      '任务范围的「剧本范围」新增一档 **指定剧本 + 商品（都能多选）**（scope 类型 scripts_products）：' +
      '两个条件同时生效——只抽「所选剧本里、关联了所选商品」的剧本；任一侧留空表示该维度不限制；' +
      '组合不可能满足时开局返回明确提示「任务限定的「剧本 + 商品」组合下没有可用剧本」。' +
      '前端两个多选框都带搜索，商品后括注分类；顺带把《客户问题剧本》批量生成的口径说清楚：' +
      '组合仍是「背景 × 内容」，商品按序轮转，但**每条内容只在与其兼容的已选商品里分配**' +
      '（配不到就跳过并在返回里给出 skipped 原因），单个创建时不匹配直接报错——' +
      '这样「多选商品」不会造出「问题与商品不一致」的剧本。' +
      '另外按客户追加要求，任务列表新增「**范围**」列：按类型显示成「剧本 2 个 × 商品 3 个」「商品种类：女装、男装」' +
      '「剧本分类：售后」「关联商品 3 个」「剧本清单 2 个」「全部剧本」，悬停可看具体选中了哪些剧本/商品/分类；' +
      '顺带修掉一个真问题——加列后 1366 宽下没设宽度的列（任务名称/目标）被挤成 0 宽，现在每列都给足宽度并让表格内部横向滚动。',
    evidence: [
      { kind: 'file', value: 'backend/src/domain/task-scope.ts' },
      { kind: 'ui', value: 'frontend/src/pages/Tasks.tsx#指定剧本 + 商品（都能多选）' },
      { kind: 'test', value: 'backend/test/domain/task-scope.spec.ts#剧本 + 商品同时多选' },
      { kind: 'test', value: 'backend/test/e2e/client-requirements.e2e-spec.ts#C16：下发任务时「剧本 + 商品」可同时多选' },
      { kind: 'file', value: 'backend/src/modules/scripts/scripts.service.ts' },
      { kind: 'ui', value: 'frontend/src/pages/Tasks.tsx#范围' },
      { kind: 'test', value: 'tools/render-check.mjs#带教任务列表' },
    ],
  },
];

export const ACCEPTANCE = [
  {
    group: '9.1 功能验收标准',
    items: [
      {
        id: 'AC-1.1',
        title: '在线模拟接待：四档难度可开局且并发数正确；计时与服务端一致；切换不丢状态；断线重连不丢数据；结束 3 秒内出结果',
        evidence: [
          { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#难度解锁状态返回四档' },
          { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#重启' },
          { kind: 'file', value: 'backend/src/modules/reception/reception.gateway.ts' },
        ],
      },
      {
        id: 'AC-1.2',
        title: '客户问题剧本：批量生成命名/商品/风格正确；被引用素材不可删除；停用剧本不再被抽取',
        evidence: [
          { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#剧本批量生成：背景 × 内容 交叉生成' },
          { kind: 'test', value: 'backend/test/e2e/acceptance.e2e-spec.ts#被剧本引用的背景与内容不可删除' },
          { kind: 'test', value: 'backend/test/e2e/acceptance.e2e-spec.ts#剧本全部停用后无法开局' },
        ],
      },
      {
        id: 'AC-1.3',
        title: '商品库：全字段保存回显；100 条导入成功率 ≥99%；重复商品ID 跳过；下架商品不出现在新剧本',
        evidence: [
          { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#导入' },
          { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#下架' },
        ],
      },
      {
        id: 'AC-1.4',
        title: '模拟接待明细：明细与结果页一致；回放顺序正确；批注权限正确；筛选排序准确',
        evidence: [
          { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#明细' },
          { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#批注' },
        ],
      },
      {
        id: 'AC-1.5',
        title: '沟通风格：占比超 100% 被拦截；100 个剧本风格分布偏差 ≤±5%；情绪值可升可降并触发升级追问',
        evidence: [
          { kind: 'test', value: 'backend/test/domain/style-ratio.spec.ts' },
          { kind: 'test', value: 'backend/test/domain/emotion.spec.ts' },
        ],
      },
      {
        id: 'AC-1.6',
        title: '账号：三角色权限与权限矩阵一致；改权重只影响新接待；停用账号无法登录且历史保留',
        evidence: [
          { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#受限写接口对无权角色一律返回 1003' },
          { kind: 'test', value: 'backend/test/e2e/acceptance.e2e-spec.ts#改考核权重只影响新接待' },
          { kind: 'test', value: 'backend/test/e2e/acceptance.e2e-spec.ts#停用后无法登录' },
        ],
      },
    ],
  },
  {
    group: '9.2 关键测试场景',
    items: [
      {
        id: 'SC-1',
        title: '场景 1：四档难度并发接待（进线数量、间隔、商品卡片、超时阈值符合配置）',
        evidence: [{ kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#并发' }],
      },
      {
        id: 'SC-2',
        title: '场景 2：超时与计时准确性（180 秒触发、记超时、扣分、服务端计时权威）',
        evidence: [
          { kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#超时' },
          { kind: 'file', value: 'backend/src/modules/reception/reception.service.ts' },
        ],
      },
      {
        id: 'SC-3',
        title: '场景 3：问题解决率判定（完整/部分/答非所问/不回答四类回复）',
        evidence: [{ kind: 'test', value: 'backend/test/domain/scoring.spec.ts' }],
      },
      {
        id: 'SC-4',
        title: '场景 4：情绪安抚（安抚下降、禁用词上升、80 触发升级追问）',
        evidence: [{ kind: 'test', value: 'backend/test/domain/emotion.spec.ts' }],
      },
      {
        id: 'SC-5',
        title: '场景 5：断线续接（关 30 秒重开恢复、关 90 秒标记异常中止计 0 分）',
        evidence: [{ kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#断线' }],
      },
      {
        id: 'SC-6',
        title: '场景 6：批量生成与抽取（连续开局不重复用同一内容、优先抽被练次数少的）',
        evidence: [
          { kind: 'test', value: 'backend/test/domain/extraction.spec.ts#优先抽取被练次数少的剧本' },
          { kind: 'test', value: 'backend/test/e2e/acceptance.e2e-spec.ts#剧本全部停用后无法开局' },
        ],
      },
      {
        id: 'SC-7',
        title: '场景 7：导入异常处理（重复商品ID、价格非法、分类不存在的行号与原因准确）',
        evidence: [{ kind: 'test', value: 'backend/test/e2e/reception.e2e-spec.ts#导入' }],
      },
    ],
  },
];

/**
 * 9.3 性能与安全验收：这些无法靠「文件存在」证明，靠一次完整的验证运行产出证据
 * （`tools/run-verification.mjs` 会把结果写进 docs/验收证据.json）。
 */
export const PERF_SECURITY = [
  { id: 'PS-1', title: '50 人同时在线 / 10 人 4 路并发的推送延迟与接口 P95', key: 'load', note: '本机压测脚本结果' },
  {
    id: 'PS-2',
    title: '连续运行 72 小时无内存泄漏；worker 重启后延迟队列任务不丢失',
    key: 'soak',
    // 2026-10-02 业务方确认：设备无法腾出 72 小时空档，该项按「接受残留风险」处理，不再安排长跑。
    // 已用可自动化的部分替代：并发压测（PS-1）+ 「服务重启恢复」用例 + 断线超时用例。
    acceptedRisk: true,
    note: '残留风险·已接受：设备腾不出 72 小时空档，未做长跑。已覆盖：并发压测、服务重启恢复（接待不被中止、定时推送重挂）、断线超时中止；未覆盖：慢速内存泄漏、跨天定时任务。',
  },
  { id: 'PS-3', title: '越权返回 1003 / 密码非明文 / 手机号脱敏 / SQL 注入与 XSS 防护', key: 'security', note: '本地探测与用例' },
  { id: 'PS-4', title: '消息与评分同事务落库；数据库备份可成功恢复', key: 'backup', note: '备份恢复演练' },
  { id: 'PS-5', title: 'Chrome / Edge 最新两个版本布局正常；1366×768 下接待页可用', key: 'compat', note: '浏览器实测' },
];

/** 方案 3.8 / 一期范围里明确要求的页面，逐个核对是否真的有页面。 */
export const PAGES = [
  { key: 'reception', name: '在线模拟接待', route: '/reception', ui: 'frontend/src/pages/Reception.tsx' },
  { key: 'records', name: '模拟接待明细', route: '/records', ui: 'frontend/src/pages/Records.tsx' },
  { key: 'recordDetail', name: '明细详情与复盘', route: '/records/:id', ui: 'frontend/src/pages/RecordDetail.tsx' },
  { key: 'library', name: '客户问题剧本（背景 / 内容）', route: '/library', ui: 'frontend/src/pages/Backgrounds.tsx' },
  { key: 'scripts', name: '剧本列表', route: '/scripts', ui: 'frontend/src/pages/Scripts.tsx' },
  { key: 'products', name: '商品库', route: '/products', ui: 'frontend/src/pages/Products.tsx' },
  { key: 'cases', name: '案例收藏', route: '/cases', ui: 'frontend/src/pages/Cases.tsx' },
  { key: 'tasks', name: '回复模拟任务', route: '/tasks', ui: 'frontend/src/pages/Tasks.tsx' },
  { key: 'styles', name: '沟通风格', route: '/styles', ui: 'frontend/src/pages/Styles.tsx' },
  { key: 'phrases', name: '快捷短语', route: '/phrases', ui: 'frontend/src/pages/Phrases.tsx' },
  { key: 'accounts', name: '账号', route: '/accounts', ui: 'frontend/src/pages/Accounts.tsx' },
  { key: 'settings', name: '系统参数', route: '/settings', ui: 'frontend/src/pages/Settings.tsx' },
  { key: 'dashboard', name: '我的训练（首页）', route: '/', ui: 'frontend/src/pages/Dashboard.tsx' },
];

/**
 * 方案 10.3「默认参数总表」→ 代码里的参数名。
 * 核对脚本会拿方案表里的默认值和 `domain/types.ts` 的 DEFAULT_PARAMS 逐个比。
 */
/**
 * 客户覆盖值（2026-10-02）：客户明确要求改掉方案默认值的参数。
 * 审计里会用这里的值去比代码，并把偏差登记成「客户覆盖」，而不是长期报「与方案不一致」。
 */
export const CLIENT_OVERRIDES = {
  unlockConsecutive: {
    value: 1,
    reason: '客户 2026-10-02 确认：达标 1 次即解锁下一档（方案 10.3 原值「连续 2 次达标」）。',
  },
  messageMaxLength: {
    value: 800,
    reason: '客户 2026-10-03 确认：对齐飞鸽会话页的输入上限，单条消息从 500 字调到 800 字（方案 10.3 原值 500）。',
  },
};

export const PLAN_PARAM_MAP = [
  { plan: '首次响应时长上限', code: 'firstResponseLimitSec', value: 30 },
  { plan: '平均响应时长上限', code: 'avgResponseLimitSec', value: 60 },
  { plan: '3 分钟回复率下限', code: 'replyRateLimitPct', value: 90 },
  { plan: '超时判定阈值', code: 'timeoutSec', value: 180 },
  { plan: '单次超时扣分', code: 'timeoutPenalty', value: 3 },
  { plan: '评分权重', code: 'weights', value: { response: 40, solving: 35, wording: 15, emotion: 10 } },
  { plan: '达标线', code: 'passLine', value: 80 },
  { plan: '难度解锁条件（连续达标次数）', code: 'unlockConsecutive', value: 2 },
  { plan: '并发接待上限', code: 'maxConcurrent', value: 4 },
  { plan: '单会话问题轮数', code: 'levelRounds', value: [6, 10] },
  { plan: '买家响应等待口径', code: 'waitToleranceFactor', value: { L1: 1.5, L2: 1, L3: 1, L4: 1 } },
  { plan: '进线间隔（秒）', code: 'levelJoinDelaySec', value: [10, 30] },
  { plan: '高难度风格权重上浮', code: 'highLevelStyleBoost', value: 1.5 },
  { plan: '情绪值升级阈值', code: 'emotionEscalateThreshold', value: 80 },
  {
    plan: '情绪值单次变化幅度（安抚下降 / 负面上升中位值）',
    code: 'emotionSootheStep+emotionNegativeStep',
    value: [15, 20],
  },
  { plan: '默认聊天占比', code: 'defaultStyleRatio', value: { friendly: 30, impatient: 15, direct: 20, hesitant: 20, silent: 15 } },
  { plan: '无情绪化场景时的情绪分按满分计入', code: 'emotionNeutralFullScore', value: true },
  { plan: '单条消息长度上限', code: 'messageMaxLength', value: 500 },
  { plan: '断线判定时长', code: 'disconnectGraceSec', value: 60 },
  { plan: '批量生成异步阈值', code: 'batchAsyncThreshold', value: 100 },
];

/**
 * 方案 7.2 接口清单与实现的**形态差异**说明。
 * 键是方案里写的 `方法 路径`，值说明本版为什么换了个形状（有意的，不是漏做）。
 */
/** 方案 10.2「待确认事项清单」：这些不是代码能单方面收口的，需要业务方给输入。 */
export const OPEN_QUESTIONS = [
  {
    id: 'Q1',
    title: '抖店客服工作台考核细则原文',
    need: '业务方（截图或规则文档）',
    status: '已获取',
    // 官方正文（抖店学习中心两处公式逐字一致），2026-10-02 取得
    resolution:
      '飞鸽平均响应时长 = 近30天工作时间消费者与商家飞鸽对话轮次的回复时长之和 ÷ 近30天工作时间人工咨询对话轮次总数；' +
      '只考核 8:00:00–22:59:59 发起的人工客服会话（含智能客服转人工，纯智能客服不考核）；' +
      '未回复本轮记 600 秒；消极敷衍回复判无效回复，后续有有效回复则本轮记「用户发消息到首条有效回复」的时长，仍无有效回复记 600 秒（2026-09-29 生效）。' +
      '官方未公布「≤N 秒」合格线——现有 60 秒是本项目自填默认值，可在系统参数里调。' +
      '来源：school.jinritemai.com/doudian/web/article/aJYrJhaZXdL1、/103956、/aJqQgPuh9FqV',
    current: '已按官方公式改造平均响应口径（轮次加权 + 未回复记 600 秒 + 无效回复回退到首条有效回复）；合格线仍是可配的项目自填值',
  },
  { id: 'Q2', title: '真实会话记录导出文件样例', need: '业务方（1～3 份样例文件）', current: '案例只做了文本粘贴导入；文件导入适配器等样例后再实现（F5-01 / F5-03）' },
  { id: 'Q3', title: '买家沟通风格的最终清单与默认占比', need: '业务方确认', current: '采用五种内置风格与 30/15/20/20/15 默认占比' },
  { id: 'Q4', title: '是否需要「看板 / 排行榜」等激励功能', need: '业务负责人', current: '本版未实现，属二期范围' },
  { id: 'Q5', title: '优秀客服参考话术来源（话术规范关键词库）', need: '业务方 / 带教组长', current: '先用通用问候语、结束语、禁用词库' },
  { id: 'Q6', title: '内网部署服务器规格与是否已有 PostgreSQL / Redis', need: '运维', current: '按 Docker Compose 单机部署（含 PostgreSQL 与 Redis）' },
  { id: 'Q7', title: '是否需要与人事系统对接账号', need: '业务方 / IT', current: '账号手工维护，已预留单点登录接口位置' },
];

export const API_SHAPE_EXCEPTIONS = {
  'DELETE /api/accounts/:id': '账号不做物理删除：方案 3.8 F8-02 只要求「停用」，停用走 PUT /api/accounts/:id { status: 0 }，历史接待保留。',
  'DELETE /api/backgrounds/:id': '批量删除接口统一为 POST /api/backgrounds/batch-delete（支持一次删多条，并在被剧本引用时返回 3001）。',
  'DELETE /api/contents/:id': '同上，统一为 POST /api/contents/batch-delete。',
  'PUT /api/categories/:id': '分类的「改」只涉及改名字与排序：改名走 POST 重名校验，排序走 PUT /api/categories/reorder。',
  'POST /api/scripts/batch-generate/async': '没有单独的 async 路径：POST /api/scripts/batch-generate 在数量超过 batchAsyncThreshold 时自动转为异步任务，进度与取消走 /api/scripts/batch-generate/tasks/:id。',
  'PUT /api/tasks/:id': '任务属二期，本版只做了创建、列表、报表与删除，没有做修改。',
  'POST /api/cases/:id/to-script': '案例转出的是「买家咨询内容」而不是剧本：POST /api/cases/:id/to-content，先沉淀进内容库，再由《客户问题剧本》批量生成剧本（方案 3.5 的两条路径等效，且更可控）。',
};
