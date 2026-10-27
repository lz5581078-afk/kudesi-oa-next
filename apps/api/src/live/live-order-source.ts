/**
 * 聚水潭订单与退款的只读来源。本期没有授权接入真实的聚水潭读取，所以默认实现是“未接入”：
 * 报下播会明确提示原因，月结生成会提示“退款暂时查不到”，绝不放过去当作零退款。测试用假实现。
 * 真实实现只允许调用查询接口（订单查询、售后单查询），不得有任何写入。
 */
export interface LiveOrder { orderId: string; innerId: string; payTime: string | null; paid: boolean; amountCents: number; status: string; statusLabel: string; cancelled: boolean }
export interface LiveOrderCandidates {
  available: boolean;
  reason: string;
  shopId?: string;
  shopName?: string;
  window?: { start: string; end: string } | null;
  orders: LiveOrder[];
  truncated: boolean;
  queriedAt?: string;
}
export interface LiveRefund { cents: number; source: 'cancelled' | 'refund' | 'none'; details: Array<Record<string, unknown>> }

export abstract class LiveOrderSource {
  /** 本场（聚水潭店铺编号 + 上播到下播时间窗）的订单。 */
  abstract candidates(companyId: number, session: { id: number; shopId: string | null; startAt: string; endAt: string | null }, opts: { refresh: boolean }): Promise<LiveOrderCandidates>;
  /** 一个聚水潭店铺里这些订单的退款；任何一步查不到都必须抛错，不能当零退款。 */
  abstract refunds(companyId: number, shopId: string, orders: Array<{ orderId: string; amountCents: number }>): Promise<Map<string, LiveRefund>>;
}

export class UnconfiguredLiveOrderSource extends LiveOrderSource {
  async candidates(): Promise<LiveOrderCandidates> {
    return { available: false, reason: '聚水潭订单查询还没有接入（真实外部系统读取未授权），暂时不能从聚水潭勾选本场订单。请联系管理员。', window: null, orders: [], truncated: false };
  }
  async refunds(): Promise<Map<string, LiveRefund>> {
    throw new Error('聚水潭退款查询还没有接入（真实外部系统读取未授权）');
  }
}
