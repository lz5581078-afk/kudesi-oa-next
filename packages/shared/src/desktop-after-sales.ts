/** 网页可见字段白名单；不接收 HTML、Cookie、链接或浏览器存储。 */
export const AFTER_SALES_FIELDS = ['订单时间', '申请时间', '线上类型', '商品信息', '线上状态', '售后单状态', '货物状态', '原订单下单金额', '线上申请金额', '实退金额', '售后标签', '原订单标签', '售后分类', '退货快递单号', '快递拦截状态', '拦截失败原因', '快递拦截时间', '收货仓', '仓库', '线上订单号', '线上售后单号', '售后问题类型', '售后问题登记', '店铺', '买家留言', '卖家备注', '支付金额', '售后日志', '订单操作日志', '订单状态', '买家账号', '下单时间', '发货时间', '支付时间', '支付方式', '收货人', '手机号', '收货地址', '快递公司', '快递单号', '物流状态', '商品明细', '商品总数量', '商品总成交金额', '优惠抵扣金额', '运费', '应付总金额', '实际已付', '供分销备注', '聚工单', '异常状态', '确认时间', '原订单状态', '订单状态快照', '发货快递单号', '原订单采购金额', '申请退货数量', '原订单发货仓库', '原订单备注/旗帜', '原订单线下备注', '原订单业务员', '实际收货金额', '实退数量', '创建人', '修改人', '平台售后详情', '仲裁状态', '备注','业务类型','退货签收时间','商家实退','线上商品应退金额','线上退运费','商品应退金额','优惠/差额','卖家应补','卖家应退运费','换货金额','买家应补','买家退款账号','卖家退款账号','退款原因','处理结果','退款状态','售后异常','供销外部处理状态','供销退款状态','分销商','已提交分销商','买家图片凭证','原订单类型','原订单赠品','最后修改日期','登记时间','超时时间','自动化推送状态','原始线上单号','外部交易单号'] as const;
export type AfterSalesField = typeof AFTER_SALES_FIELDS[number];
export const AFTER_SALES_PRIORITIES = ['普通', '关注', '紧急', '特急'] as const;
export const AFTER_SALES_COLUMNS = ['售后单号', '内部订单号', ...AFTER_SALES_FIELDS, 'OA处理进度', '负责人', '紧急度', '下次跟进'] as const;
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
export interface DesktopSaleArchive {
  id: number; storeId: number | null; storeName: string; version: number;
  snapshot: DesktopSaleSnapshot;
  progress: string; ownerId: number | null; ownerName: string; nextAt: string | null;
  updatedAt: string;
  nextEventsBefore?:number|null;
  priority?:number; rowColor?:string|null; report?:string; flowRunId?:number|null; sourceSeenAt?:string|null;
  events: Array<{ id: number; kind: string; content: string; actorName: string; createdAt: string }>;
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

export function afterSalesCell(row: DesktopSaleListRow, column: AfterSalesColumn): string {
  switch (column) {
    case '售后单号': return row.afterSaleId;
    case '内部订单号': return row.internalOrderId;
    case 'OA处理进度': return row.progress;
    case '负责人': return row.ownerName;
    case '紧急度': return AFTER_SALES_PRIORITIES[row.priority ?? 0] ?? '';
    case '下次跟进': return row.nextAt ? FOLLOW_DATE_FORMAT.format(new Date(row.nextAt)) : '';
    default: return row.snapshot.fields[column] ?? '';
  }
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
