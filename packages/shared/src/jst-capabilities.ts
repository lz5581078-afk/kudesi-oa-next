/**
 * 聚水潭同步能力中心（只读展示）的静态说明：接口能力分组、旧系统实测记录、同步任务计划、写入保护规则。
 * 这些是“规划与记录”，不是新系统的真实连接状态：新系统目前只有“商品/组合装上传、基本售价、分类同步”走出站队列，
 * 其余能力都还没接入。真实状态（总开关、队列积压、失败）由服务端 `/api/system/jst-center` 实时给出。
 */

/** 新系统对这一组能力的接入程度 */
export type JstReadiness = 'queue' | 'planned' | 'none';
export const JST_READINESS_LABEL: Record<JstReadiness, string> = {
  queue: '已做：出站队列（默认关）',
  planned: '规划：只读同步，未接入',
  none: '未开始',
};

export interface JstCapabilityGroup {
  name: string;
  /** 旧系统页面上的状态：active 已启用 / testing 测试中 */
  status: 'active' | 'testing';
  summary: string;
  /** 旧系统实测过的接口 */
  tested: string[];
  systemUse: string;
  syncPlan: string;
  readiness: JstReadiness;
  /** 新系统现在对这一组做了什么（一句话） */
  newSystem: string;
}

export const JST_CAPABILITY_GROUPS: readonly JstCapabilityGroup[] = [
  {
    name: '基础资料', status: 'active', summary: '店铺、仓库、物流公司、供应商和商家用户信息。',
    tested: ['/open/shops/query', '/open/wms/partner/query', '/open/logisticscompany/query'],
    systemUse: '同步店铺档案、仓库基础资料、物流公司字典，作为后续订单和库存同步的匹配底座。',
    syncPlan: '每日同步一次；店铺和仓库也支持手工立即同步。',
    readiness: 'planned', newSystem: '店铺、仓库、供应商档案在本系统手工维护；尚未从聚水潭读取。',
  },
  {
    name: '商品资料', status: 'active', summary: '普通商品、店铺商品、组合装、商品类目、成本价和BOM。',
    tested: ['/open/sku/query', '/open/skumap/query', '/open/mall/item/query', '/open/combine/sku/query', '/open/category/query'],
    systemUse: '落到财务基础资料的商品档案、SKU成本表、店铺商品映射和后续利润核算。',
    syncPlan: '商品主数据每日同步；成本和映射变更支持按需同步。',
    readiness: 'queue', newSystem: '基础编码、组合装上传，基本售价同步和分类同步已做成出站任务；总开关默认关闭，且还没有接入真实发送器。',
  },
  {
    name: '订单履约', status: 'active', summary: '订单查询、订单上传、订单取消、发货回传、备注、标签和异常单。',
    tested: ['/open/orders/single/query', '/open/orders/out/simple/query', '/open/logistic/query'],
    systemUse: '同步销售订单、发货状态、物流单号和售后申诉的原始订单线索。',
    syncPlan: '按15到30分钟增量同步，按聚水潭7天查询窗口切片分页拉取。',
    readiness: 'none', newSystem: '还没有订单模块。',
  },
  {
    name: '售后退款', status: 'active', summary: '退款查询、售后收货、售后上传、确认收货、售后标签、取消确认。',
    tested: ['/open/refund/single/query', '/open/aftersale/received/query'],
    systemUse: '同步售后工单、退货入库、退款金额和客服未完结监督。',
    syncPlan: '30分钟增量同步；超72小时未完结转监督。',
    readiness: 'none', newSystem: '售后模块还没有做。',
  },
  {
    name: '采购入库', status: 'active', summary: '采购单、供应商、预约入库、采购入库查询、采购入库取消和收货回传。',
    tested: ['/open/supplier/query', '/open/purchase/query'],
    systemUse: '支撑采购流程、预付款冲抵、入库成本和供应商档案。',
    syncPlan: '采购和入库每小时同步；流程写入必须先经过审批节点。',
    readiness: 'none', newSystem: '采购申请在本系统走流程并生成采购入库单，不向聚水潭写采购单；聚水潭采购单也还没有读入。',
  },
  {
    name: '库存 / WMS', status: 'active', summary: '库存查询、盘点、箱及仓位库存、播种、波次、序列号和仓位操作。',
    tested: ['/open/inventory/query', '/open/inventory/count/query'],
    systemUse: '库存看板、缺货预警、采购提醒、仓库工作台和盘点任务。',
    syncPlan: '库存15分钟同步；WMS操作类接口暂按只读调研，不直接自动写入。',
    readiness: 'none', newSystem: '库存查询来自本系统的单据过账，没有读聚水潭库存。',
  },
  {
    name: '财务 / 胜算', status: 'testing', summary: '应付、付款、经营费用、财务项目、胜算成本费用数据接入。',
    tested: ['/open/api/fmsopen/querypayable', '/open/api/fmsopen/querypayment', '/open/api/fmsopen/queryoperatingfee'],
    systemUse: '费用归集、付款核对、利润核算和店铺经营费用同步。',
    syncPlan: '先做只读同步和差异核对；写入类接口必须人工确认。',
    readiness: 'none', newSystem: '财务单据在本系统记账，没有读聚水潭财务数据。',
  },
];

export interface JstTestResult { module: string; endpoint: string; result: '已测通' | '测试中'; sample: string }
/** 旧系统在真实授权下记录的只读接口实测结果（历史记录；新系统没有连接聚水潭，不会重新测试）。 */
export const JST_TEST_RESULTS: readonly JstTestResult[] = [
  { module: '基础资料', endpoint: '/open/shops/query', result: '已测通', sample: '返回店铺列表' },
  { module: '基础资料', endpoint: '/open/logisticscompany/query', result: '已测通', sample: '返回物流公司列表' },
  { module: '基础资料', endpoint: '/open/wms/partner/query', result: '已测通', sample: '返回仓库列表' },
  { module: '订单', endpoint: '/open/orders/single/query', result: '已测通', sample: '返回订单列表' },
  { module: '订单', endpoint: '/open/orders/out/simple/query', result: '已测通', sample: '返回出库订单列表' },
  { module: '商品', endpoint: '/open/sku/query', result: '已测通', sample: '返回普通商品' },
  { module: '商品', endpoint: '/open/skumap/query', result: '已测通', sample: '返回店铺商品' },
  { module: '商品', endpoint: '/open/combine/sku/query', result: '已测通', sample: '返回组合装商品' },
  { module: '商品', endpoint: '/open/category/query', result: '已测通', sample: '返回商品类目' },
  { module: '售后', endpoint: '/open/refund/single/query', result: '已测通', sample: '返回退款单' },
  { module: '售后', endpoint: '/open/aftersale/received/query', result: '已测通', sample: '返回售后收货' },
  { module: '采购', endpoint: '/open/supplier/query', result: '已测通', sample: '返回供应商' },
  { module: '库存', endpoint: '/open/inventory/query', result: '已测通', sample: '返回库存' },
  { module: '库存', endpoint: '/open/inventory/count/query', result: '已测通', sample: '返回盘点单' },
  { module: '调拨', endpoint: '/open/allocate/query', result: '已测通', sample: '可查，当前样本为空' },
];

export interface JstSyncTask { name: string; frequency: string; target: string; level: '基础' | '核心' | '流程' | '财务' }
export const JST_SYNC_TASKS: readonly JstSyncTask[] = [
  { name: '店铺资料同步', frequency: '每天 / 手工立即', target: '店铺档案、聚水潭状态、店铺映射', level: '基础' },
  { name: '商品与SKU同步', frequency: '每天', target: '商品档案、店铺商品、组合装、类目', level: '基础' },
  { name: '订单同步', frequency: '15-30分钟', target: '销售订单、发货状态、订单申诉线索', level: '核心' },
  { name: '售后退款同步', frequency: '30分钟', target: '售后表格、退款、退货收货、客服监督', level: '核心' },
  { name: '库存同步', frequency: '15分钟', target: '库存看板、缺货预警、采购提醒', level: '核心' },
  { name: '采购入库同步', frequency: '60分钟', target: '采购流程、供应商、入库成本', level: '流程' },
  { name: '财务费用同步', frequency: '每天', target: '经营费用、付款、利润核算', level: '财务' },
];

export interface JstRule { title: string; text: string }
export const JST_RULES: readonly JstRule[] = [
  { title: '只读先行', text: '第一阶段只同步查询类接口，先把订单、售后、商品、库存、采购和财务数据落库。' },
  { title: '切片分页', text: '订单、商品、售后等接口按7天窗口和页码拆分，避免一次请求过重或漏数据。' },
  { title: '幂等落库', text: '以聚水潭单号、内部单号、SKU、店铺编号等唯一键覆盖更新，不重复生成资料。' },
  { title: '写入审批', text: '订单上传、采购上传、入库、库存更新、发货回传等写入动作必须来自流程节点并保留操作日志。' },
  { title: '异常监督', text: '同步失败、权限不足、token过期、字段无法匹配时生成异常，进入接口对接监督视图。' },
  { title: '出站队列与总开关', text: '新系统的所有外部写入只能先进出站队列，由单一发送器按总开关发送；总开关默认关闭，公司管理员可随时一键停止。' },
];

/** 旧系统页面上写的“已读取授权能力”数量（页面确认过的可用 API 数，部分分类的明细还没补全）。 */
export const JST_GRANTED_ENDPOINT_COUNT = 132;

/** 出站任务类型的中文名（队列概览用） */
export const JST_JOB_KIND_LABEL: Record<string, string> = {
  base_code: '基础编码上传', normal_product: '普通商品上传', bundle_upsert: '组合装上传', bundle_replace: '组合装改码',
  bundle_price_update: '基本售价同步', bundle_disable: '组合装停用', category_sync: '分类同步',
};
