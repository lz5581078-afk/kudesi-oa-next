/** 24 号岗位模板的入口对应新版导航。缺少的业务不生成空链接。 */
const people = ['resource.employees', 'resource.org-tree', 'resource.position-profiles'];
const content = ['resource.self-media', 'resource.wechat', 'resource.trademarks'];
const warehouse = ['finance.inventory', 'finance.finance-bundles', 'after-sales.table'];

export const LEGACY_DESK_PROFILES: Readonly<Record<string, { focus: string; links: string[]; pending?: string[] }>> = {
  assistant: { focus: '经营跟进 · 资料协调', links: ['workbench.boss', 'resource.org-tree', 'resource.licenses'] },
  customer_service: { focus: '售后处理 · 订单申诉', links: ['after-sales.table', 'after-sales.appeals', 'resource.stores'] },
  customer_manager: { focus: '售后复核 · 团队异常', links: ['after-sales.table', 'supervision.center', 'after-sales.appeals'] },
  general_admin: { focus: '经营资料 · 账号与资产', links: ['resource.stores', 'resource.licenses', 'resource.phones', 'resource.qualifications', 'resource.memos', 'resource.fixed-assets'] },
  hr_admin: { focus: '人员档案 · 组织与岗位', links: people },
  hr_manager: { focus: '组织维护 · 人员与交接', links: people },
  warehouse_manager: { focus: '发货组成 · 库存与异常', links: [...warehouse, 'supervision.center'], pending: ['仓库收发货汇总'] },
  warehouse: { focus: '发货组成 · 收货任务', links: warehouse, pending: ['收发货明细'] },
  print_clerk: { focus: '发货任务 · 面单交接', links: ['resource.stores'], pending: ['订单打单', '面单异常与批次交接'] },
  shipping_staff: { focus: '人员协调 · 发货任务', links: ['resource.employees', 'resource.position-profiles'], pending: ['发货排班与人力安排'] },
  logistics_safety: { focus: '异常件跟进 · 售后资料', links: ['after-sales.table', 'finance.finance-express-prices', 'supervision.center'] },
  design: { focus: '设计任务 · 素材交付', links: ['resource.trademarks', 'resource.locations'], pending: ['设计素材与版本交付'] },
  content: { focus: '内容任务 · 自媒体账号', links: content, pending: ['内容排期与发布记录'] },
  content_manager: { focus: '内容协调 · 账号与素材', links: content, pending: ['短视频排期与发布汇总'] },
  technology: { focus: '技术任务 · 接口维护', links: ['system.integrations', 'system.ai-api', 'system.ocr'] },
  technology_manager: { focus: '开发协调 · 接口维护', links: ['system.integrations', 'system.ai-api', 'resource.memos'] },
  automation_operator: { focus: '执行任务 · 运行资料', links: ['resource.memos', 'resource.locations'] },
  branch_manager: { focus: '经营资料 · 业务跟进', links: ['resource.stores', 'finance.finance-customers', 'finance.history'] },
  sales: { focus: '客户资料 · 销售跟进', links: ['finance.finance-customers', 'finance.finance-products', 'finance.doc-sale'] },
  retail: { focus: '门市资料 · 销售单据', links: ['finance.finance-products', 'finance.doc-sale', 'finance.doc-sale-return'] },
  finance_manager: { focus: '财务复核 · 经营核对', links: ['finance.overview', 'finance.cost-table', 'finance.history', 'finance.cash-bank', 'finance.drafts'] },
  operations_manager: { focus: '经营跟进 · 申请复核', links: ['resource.stores', 'finance.pricing-debug', 'finance.overview'] },
  personal: { focus: '个人任务 · 申请与待办', links: [] },
};
