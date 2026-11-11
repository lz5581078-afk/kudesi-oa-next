/** 网页可见字段白名单；不接收 HTML、Cookie、链接或浏览器存储。 */
const AFTER_SALES_TEXT_FIELDS = ['订单时间', '申请时间', '线上类型', '商品信息', '线上状态', '售后单状态', '货物状态', '原订单下单金额', '线上申请金额', '实退金额', '售后标签', '原订单标签', '售后分类', '退货快递单号', '快递拦截状态', '解决方案', '拦截失败原因', '快递拦截时间', '收货仓', '仓库', '线上订单号', '线上售后单号', '售后问题类型', '售后问题登记', '店铺', '买家留言', '卖家备注', '支付金额', '售后日志', '订单操作日志', '订单状态', '买家账号', '下单时间', '发货时间', '支付时间', '支付方式', '收货人', '手机号', '收货地址', '快递公司', '快递单号', '物流状态', '商品明细', '商品总数量', '商品总成交金额', '优惠抵扣金额', '运费', '应付总金额', '实际已付', '供分销备注', '聚工单', '异常状态', '确认时间', '原订单状态', '订单状态快照', '发货快递单号', '原订单采购金额', '申请退货数量', '原订单发货仓库', '原订单备注/旗帜', '原订单线下备注', '原订单业务员', '实际收货金额', '实退数量', '创建人', '修改人', '平台售后详情', '仲裁状态', '备注','业务类型','退货签收时间','商家实退','线上商品应退金额','线上退运费','商品应退金额','优惠/差额','卖家应补','卖家应退运费','换货金额','买家应补','买家退款账号','卖家退款账号','退款原因','处理结果','退款状态','售后异常','供销外部处理状态','供销退款状态','分销商','已提交分销商','买家图片凭证','原订单类型','原订单赠品','最后修改日期','登记时间','超时时间','自动化推送状态','原始线上单号','外部交易单号','供应商售后单状态','供应商退款状态','修改时间','付款时间','退货金额','买家应补运费','拒绝原因','平台卖家退货地址','退货物流状态','售后商品明细','实退金额明细','退货物流明细','发货物流明细','平台售后记录'] as const;
export const AFTER_SALES_FIELDS = [...AFTER_SALES_TEXT_FIELDS, '原订单旗帜', '原订单下单金额明细', '拒绝原因明细', '售后标签样式', '原订单标签样式', '售后问题附件', '供分销备注附件', '原列表可编辑字段',
  '快递登记', '订单来源', '买家已付运费', '订单包材', '订单支付金额', '订单支付日期', '线上原始金额', '支付优惠', '店铺优惠',
  '售后详情商品明细', '售后详情商品汇总', '售后详情操作日志', '单据收货人', '售后线上金额说明', '订单优惠明细'] as const;
export type AfterSalesField = typeof AFTER_SALES_FIELDS[number];
export const AFTER_SALES_PRIORITIES = ['普通', '关注', '紧急', '特急'] as const;
export const AFTER_SALES_COLUMNS = ['售后单号', '内部订单号', ...AFTER_SALES_TEXT_FIELDS, 'OA处理进度', '负责人', '紧急度', '下次跟进'] as const;
export const JST_AFTER_SALES_COLUMNS = [
  '售后单号', '内部订单号', '订单时间', '申请时间', '线上类型', '商品信息', '线上状态', '售后单状态',
  '货物状态', '原订单下单金额', '线上申请金额', '实退金额', '快递拦截状态', '解决方案', '售后标签',
  '原订单标签', '售后分类', '退货快递单号', '拦截失败原因', '快递拦截时间', '收货仓', '仓库',
  '线上订单号', '线上售后单号', '售后问题类型', '售后问题登记', '供分销备注', '供应商售后单状态',
  '聚工单', '买家账号', '收货人', '店铺', '异常状态', '供应商退款状态', '登记时间', '确认时间',
  '修改时间', '原订单状态', '订单状态快照', '发货快递单号', '发货时间', '原订单采购金额', '申请退货数量',
  '付款时间', '原订单发货仓库', '原订单备注/旗帜', '原订单线下备注', '原订单业务员', '实际收货金额',
  '实退数量', '创建人', '修改人', '平台售后详情', '退货金额', '换货金额', '买家应补运费', '卖家应退运费',
  '卖家应补', '处理结果', '拒绝原因', '备注', '退款原因', '平台卖家退货地址', '仲裁状态', '退货物流状态',
] as const satisfies readonly AfterSalesColumn[];
/** ERP cells that can be located for inspection or manual edits. */
export const JST_AFTER_SALES_ORIGINAL_COLUMNS = [
  '商品信息', '原订单下单金额', '实退金额', '发货快递单号', '平台售后详情',
  '售后标签', '原订单标签', '售后分类', '退货快递单号', '仓库',
  '售后问题类型', '售后问题登记', '供分销备注', '聚工单', '买家账号',
  '原订单备注/旗帜', '原订单线下备注', '买家应补运费', '卖家应退运费', '卖家应补', '处理结果', '备注', '拒绝原因', '操作',
] as const satisfies readonly (AfterSalesColumn | '操作')[];
export type JstAfterSalesOriginalColumn = typeof JST_AFTER_SALES_ORIGINAL_COLUMNS[number];

export const AFTER_SALES_SORT_COLUMNS = ['申请时间', '售后单号', '内部订单号', '紧急度', '负责人', '下次跟进'] as const;
export const AFTER_SALES_PAGE_SIZE = 30;
export const AFTER_SALES_MAX_FILTERS = 12;
export type AfterSalesColumn = typeof AFTER_SALES_COLUMNS[number];
export interface AfterSalesColumnFilter { column: AfterSalesColumn; value: string }
export interface DesktopSaleSnapshot {
  afterSaleId: string;
  internalOrderId: string;
  sourceCompany: string;
  capturedAt: string;
  fields: Partial<Record<AfterSalesField, string>>;
}
export interface DesktopSaleFieldChange {
  field: AfterSalesField; before: string; after: string;
}
export const DESKTOP_SALE_CLICK_LABELS={
  open_case:'打开售后处理',
  open_shared:'打开协作售后',
  leave_case:'离开售后处理',
  view_oa_history:'查看 OA 处理记录',
  view_source_history:'查看聚水潭字段变更',
  view_source:'查看聚水潭明细',
  view_order:'查看内部订单',
  view_video:'查看视频监控',
  view_discount:'查看订单优惠明细',
  copy_number:'复制单号',
  refresh_archive:'刷新档案版本',
  load_history:'加载更早记录',
  choose_people:'打开选人列表',
  select_department:'选择通知部门',
  select_recipient:'选择通知对象',
  retry_source:'重查聚水潭',
  start_screenshot:'点击截图',
  view_file:'查看凭证',
  open_notice:'打开通知表单',
  cancel_notice:'取消通知',
  start_close:'点击完结',
  cancel_close:'取消完结',
  confirm_close:'确认完结',
  click_tear:'点击撕单',
  click_send_notice:'点击发送通知',
  click_save_follow:'点击保存跟进',
  click_reply:'点击提交回复',
} as const;
export type DesktopSaleClick=keyof typeof DESKTOP_SALE_CLICK_LABELS;

export interface DesktopSaleEvent {
  id: number; kind: string; content: string; actorName: string; createdAt: string;
  actorId?: number;
  action?: string;
  changes?: DesktopSaleFieldChange[];
  fileIds?: number[];
  nextAt?: string | null;
  nextOwnerName?: string;
}
export const DESKTOP_SALE_WORKSPACE_STATES=['open','tear','closed'] as const;
export type DesktopSaleWorkspaceState=typeof DESKTOP_SALE_WORKSPACE_STATES[number];

export interface DesktopSaleArchive {
  id: number; storeId: number | null; storeName: string; version: number;
  snapshot: DesktopSaleSnapshot;
  progress: string; ownerId: number | null; ownerName: string; nextAt: string | null;
  updatedAt: string;
  nextEventsBefore?:number|null;
  priority?:number; rowColor?:string|null; report?:string; flowRunId?:number|null; sourceSeenAt?:string|null;
  workspaceState?: DesktopSaleWorkspaceState;
  pendingFileIds?: number[];
  canCloseTear?: boolean;
  closed?: { reason: string; actorName: string; createdAt: string } | null;
  events: DesktopSaleEvent[];
  files: Array<{ id: number; name: string; mime: string; size: number }>;
}
export interface DesktopSaleListRow {
  id:number; afterSaleId:string; internalOrderId:string; sourceCompany:string;
  storeId:number|null; storeName:string; ownerId:number|null; ownerName:string;
  progress:string; nextAt:string|null; version:number; updatedAt:string;
  snapshot:DesktopSaleSnapshot; priority?:number; rowColor?:string|null;
}

const FOLLOW_DATE_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short', hour12: false,
});

const SOURCE_DATE_COLUMNS: ReadonlySet<AfterSalesColumn | AfterSalesField> = new Set([
  '订单时间', '申请时间', '登记时间', '确认时间', '修改时间', '发货时间', '付款时间', '快递拦截时间',
  '支付时间', '下单时间', '最后修改日期', '退货签收时间', '超时时间',
]);

/** Native list values are already in ERP display format. Older archives may contain ISO timestamps. */
export function formatAfterSalesField(column: AfterSalesColumn | AfterSalesField, value: string): string {
  if (!SOURCE_DATE_COLUMNS.has(column) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    return value;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')
    : value;
}

export function afterSalesCell(row: DesktopSaleListRow, column: AfterSalesColumn): string {
  switch (column) {
    case '售后单号': return row.afterSaleId;
    case '内部订单号': return row.internalOrderId;
    case 'OA处理进度': return row.progress;
    case '负责人': return row.ownerName;
    case '紧急度': return AFTER_SALES_PRIORITIES[row.priority ?? 0] ?? '';
    case '下次跟进': return row.nextAt ? FOLLOW_DATE_FORMAT.format(new Date(row.nextAt)) : '';
    case '付款时间': return formatAfterSalesField(column, row.snapshot.fields['付款时间'] ?? row.snapshot.fields['支付时间'] ?? '');
    case '修改时间': return formatAfterSalesField(column, row.snapshot.fields['修改时间'] ?? row.snapshot.fields['最后修改日期'] ?? '');
    default: return formatAfterSalesField(column, row.snapshot.fields[column] ?? '');
  }
}

export const AFTER_SALES_COLUMNS_PREFERENCE='desktop-after-sales-columns';
export type AfterSalesWidthColumn = AfterSalesColumn | '序号' | '操作';
export type AfterSalesColumnWidths = Partial<Record<AfterSalesWidthColumn, number>>;
export const AFTER_SALES_MAX_COLUMN_WIDTH = 600;

export function afterSalesMinColumnWidth(column: AfterSalesWidthColumn) {
 if(column==='序号')return 40;
 if(column==='操作')return 142;
 if(column==='商品信息')return 136;
 return 72;
}

export function clampAfterSalesColumnWidth(column: AfterSalesWidthColumn, width: number) {
 return Math.min(AFTER_SALES_MAX_COLUMN_WIDTH, Math.max(afterSalesMinColumnWidth(column), Math.round(width)));
}

export function normalizeAfterSalesColumnWidths(value: unknown): AfterSalesColumnWidths {
 const widths: AfterSalesColumnWidths = {};
 if(!value || typeof value!=='object' || Array.isArray(value))return widths;
 for(const column of ['序号', ...AFTER_SALES_COLUMNS, '操作'] as const){
  if(!Object.hasOwn(value,column))continue;
  const width=(value as Record<string,unknown>)[column];
  if(typeof width==='number'&&Number.isFinite(width))widths[column]=clampAfterSalesColumnWidth(column,width);
 }
 return widths;
}

export interface AfterSalesColumnPreference {
 columns: AfterSalesColumn[];
 widths: AfterSalesColumnWidths;
}

export function normalizeAfterSalesColumns(value: unknown): AfterSalesColumn[] {
 const columns=Array.isArray(value)?[...new Set(value.filter((column):column is AfterSalesColumn=>AFTER_SALES_COLUMNS.includes(column)))]:[];
 if(!columns.length)return [...JST_AFTER_SALES_COLUMNS];
 return columns.includes('售后单号')?columns:['售后单号',...columns];
}

export interface DesktopCollectionSource {
 id:number;sourceCompany:string;enabled:boolean;intervalSeconds:number;
 health:'stopped'|'failed'|'starting'|'waiting'|'stale'|'healthy';
 lastSuccessAt:string|null;lastFailureAt:string|null;lastError:string|null;
 leaseUntil:string|null;collectedCount:number;
}
export interface DesktopCollectionLease {
 sourceId:number;sourceCompany:string;token:string;from:string;until:string;expiresAt:string;page:number;
 firstPageOnly?:boolean;
}
