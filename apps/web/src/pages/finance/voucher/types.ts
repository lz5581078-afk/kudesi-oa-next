/** 开单页的明细行状态（界面里的字符串，保存时才转成分/数量） */
export interface LineState {
  unit: string;
  productId: number | null; productName: string; feeItemId: number | null; feeItemName: string; qty: string; price: string; memo: string;
  /** 赠品：单价强制为 0，不能改价（管家婆 F7） */
  gift: boolean;
  /** 费用/收入行的挂账节点和对象 */
  node: string; relatedId: number | null; relatedName: string; needObject: boolean;
}
export interface AcctState { id: number; name: string; amount: string }
export interface MoneyLine { item: string; amount: string; memo: string }
export const emptyMoney = (): MoneyLine => ({ item: '', amount: '', memo: '' });
export const emptyLine = (): LineState => ({ unit: '', productId: null, productName: '', feeItemId: null, feeItemName: '', qty: '1', price: '', memo: '', gift: false, node: '', relatedId: null, relatedName: '', needObject: false });
export const emptyLines = (n: number) => Array.from({ length: n }, emptyLine);

/** 金额类单据明细行的“项目”常用词（旧系统同款，输入时可直接选） */
export const MONEY_SUGGEST: Record<string, string[]> = {
  'advance-receipt': ['预收货款', '预收定金', '预收订单款'], receipt: ['客户回款', '补收货款', '补差价', '其他应收款'],
  payment: ['货款', '运费', '加工费', '预付货款', '退款', '其他'], prepayment: ['预付货款', '定金', '锁定商品预付'], transfer: ['资金调拨', '店铺提现转入', '备用金划转', '还款划转'],
};
