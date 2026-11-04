/** 网页可见字段白名单；不接收 HTML、Cookie、链接或浏览器存储。 */
export const AFTER_SALES_FIELDS = ['订单时间', '申请时间', '线上类型', '商品信息', '线上状态', '售后单状态', '货物状态', '原订单下单金额', '线上申请金额', '实退金额', '售后标签', '原订单标签', '售后分类', '退货快递单号', '快递拦截状态', '拦截失败原因', '快递拦截时间', '收货仓', '仓库', '线上订单号', '线上售后单号', '售后问题类型', '售后问题登记', '店铺', '买家留言', '卖家备注', '支付金额', '售后日志', '订单操作日志', '订单状态', '买家账号', '下单时间', '发货时间', '支付时间', '支付方式', '收货人', '手机号', '收货地址', '快递公司', '快递单号', '物流状态', '商品明细', '商品总数量', '商品总成交金额', '优惠抵扣金额', '运费', '应付总金额', '实际已付'] as const;
export type AfterSalesField = typeof AFTER_SALES_FIELDS[number];
export interface DesktopSaleSnapshot {
  afterSaleId: string;
  internalOrderId: string;
  sourceCompany: string;
  capturedAt: string;
  fields: Partial<Record<AfterSalesField, string>>;
}
export interface DesktopSaleArchive {
  id: number; storeId: number; storeName: string; version: number;
  snapshot: DesktopSaleSnapshot;
  progress: string; ownerId: number | null; ownerName: string; nextAt: string | null;
  updatedAt: string;
  events: Array<{ id: number; kind: string; content: string; actorName: string; createdAt: string }>;
  files: Array<{ id: number; name: string; mime: string; size: number }>;
}
