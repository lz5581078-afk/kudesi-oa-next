/**
 * 采购申请（流程模板 purchase-request）的共享规则：状态结构、数量/金额计算、条件流转。前后端共用。
 *
 * 业务一句话：运营提采购需求（商品+数量+要求到货日）→ 采购完善方案（供应商、仓库、单价、货款安排）→ 审批 →
 * 出纳登记货款（生成预付款单）→ 财务确认预付款使用 → 按批次：跟进发货 → 登记到货 → 核对实收 → 质检 →（异常处理）→
 * 申报运费装卸费 → 财务结算（生成采购入库单，冲抵预付款，更新商品采购价与物流成本）→ 支付费用（生成费用单）→ 还有未到货的就回到发货。
 * 谁办哪一步、多久办完由流程定义配置；这里只描述“数量、金额、事实 → 下一步”的规则。
 *
 * 金额一律整数分；单价按 unit-price.ts 保留到分的万分之一；数量最多 4 位小数，数量乘单价后才结算到分。
 */
import { settledLineCents } from './unit-price';

export const PURCHASE_TEMPLATE = 'purchase-request';

export type PurchaseStepKey =
  | 'apply' | 'plan' | 'approve' | 'pay' | 'prepay_review' | 'dispatch' | 'arrival' | 'receive' | 'quality'
  | 'exception' | 'refund' | 'expense' | 'settle' | 'expense_pay' | 'end';

/** 每一步在界面上的标题、说明、要做的事（沿用旧系统 purchase-step-ui） */
export const PURCHASE_STEP_GUIDE: Record<Exclude<PurchaseStepKey, 'end'>, { title: string; description: string; tasks: string[]; action: string; noteLabel?: string }> = {
  apply: { title: '提交采购需求', description: '选择要采购的商品，填写数量和要求到货日期。', tasks: ['选商品并填写采购数量', '填写要求到货日期'], action: '提交采购需求' },
  plan: { title: '完善采购方案', description: '确认供应商、采购单价、收货仓库和收款资料，再提交配置的审批人审核。', tasks: ['确定供应商、仓库和商品单价', '填写货款方式及收款资料'], action: '提交采购方案', noteLabel: '方案备注' },
  approve: { title: '审核采购方案', description: '核对本次采购方案，决定批准或退回补充。', tasks: ['核对商品、数量、单价及货款合计', '核对供应商与收款资料', '批准或退回补充'], action: '批准采购', noteLabel: '审批意见' },
  pay: { title: '登记采购货款', description: '登记本次实际安排的货款。', tasks: ['核对批准金额和收款账户', '登记新付款或选择已有预付款', '上传实际付款凭证'], action: '确认货款安排并记账', noteLabel: '付款备注' },
  prepay_review: { title: '核对预付款使用', description: '确认本次使用的预付款与供应商一致。', tasks: ['核对预付款来源及金额', '确认对应供应商'], action: '确认预付款使用', noteLabel: '复核备注' },
  dispatch: { title: '跟进供应商发货', description: '按供应商实际发货情况登记。', tasks: ['未发货：登记承诺发货时间', '已发货：填写本批数量和物流凭证'], action: '确认已发货', noteLabel: '发货备注' },
  arrival: { title: '登记本批到货', description: '确认货物已到仓；实收数量由下一步核对。', tasks: ['确认本批到仓', '上传到货凭证'], action: '确认本批到货', noteLabel: '到货备注' },
  receive: { title: '核对实收数量', description: '核对仓库实际收到的数量。', tasks: ['逐项填写实收数量', '有短缺或多收时说明差异'], action: '确认收货核对', noteLabel: '差异说明' },
  quality: { title: '登记质检结果', description: '登记本批质检合格数量。', tasks: ['逐项填写合格数量', '不合格时说明原因并上传凭证'], action: '确认质检结果', noteLabel: '质检说明' },
  exception: { title: '处理采购异常', description: '处理本批数量或质检差异。', tasks: ['核对差异及质检资料', '选择处置方式并说明原因'], action: '确认异常处置', noteLabel: '处理原因' },
  refund: { title: '确认预付款退款', description: '确认退款实际到账。', tasks: ['逐笔核对退款金额', '登记退款流水和凭证'], action: '确认退款到账并记账', noteLabel: '退款备注' },
  expense: { title: '申报本批运费和装卸费', description: '只申报本批实际发生的物流费用。', tasks: ['填写运费、装卸费及收款资料', '无费用时填写原因'], action: '提交费用申报', noteLabel: '费用备注' },
  settle: { title: '核对到货并结算', description: '核对本批合格货款与费用后完成结算。', tasks: ['核对本批合格数量、货款和费用', '确认预付款冲抵金额及费用分摊'], action: '确认结算并更新成本', noteLabel: '复核备注' },
  expense_pay: { title: '登记本批费用付款', description: '登记运费或装卸费的实际支付记录。', tasks: ['核对已申报费用与收款人', '填写付款金额、账户、流水和凭证'], action: '确认费用付款并记账', noteLabel: '付款备注' },
};

/** 涉及金额、单价的步骤：这些步骤的办理人（以及有成本查看权限的人）能看到价格和付款 */
export const PURCHASE_MONEY_STEPS: readonly PurchaseStepKey[] = ['plan', 'approve', 'pay', 'prepay_review', 'refund', 'settle', 'expense_pay'];

export const PAYMENT_MODE_LABEL = { new: '新付款', existing: '使用已有预付款', mixed: '新付款＋已有预付款' } as const;
export type PaymentMode = keyof typeof PAYMENT_MODE_LABEL;
export const ALLOCATION_LABEL = { value: '按货值', quantity: '按数量', weight: '按重量' } as const;
export type AllocationMethod = keyof typeof ALLOCATION_LABEL;
export const FEE_TYPE_LABEL = { freight: '运费', handling: '装卸费' } as const;
export type FeeType = keyof typeof FEE_TYPE_LABEL;
export const EXCEPTION_LABEL = {
  reinspect: '重新检验',
  replace: '不合格部分退回换货 / 短缺部分补发',
  accept_discount: '批准折价接收',
  cancel_remaining: '终止未到货部分并退款',
} as const;
export type ExceptionResolution = keyof typeof EXCEPTION_LABEL;

/** 采购需求里的一行（申请时填；名称、编码、单位、重量由服务端按商品档案补全） */
export interface PurchaseLine {
  productId: number;
  qty: number;
  unit: string;
  name: string;
  code: string;
  /** 原料可选的成品名（马甲）；商品档案里有成品名时必须选一个 */
  aliasName?: string;
  weightG: number;
}
export interface QtyRow { productId: number; qty: number }

export interface PayRecord { docId: number; docNo: string; amountCents: number; bankAccountId: number; reference: string; files: number[]; payeeName: string; payeeAccount: string }
export interface Shipment { id: string; lines: QtyRow[]; logisticsNo: string; expectedArrivalAt: string; files: number[]; closedMissing: Record<string, number>; returned: Record<string, number> }
export interface FeeRecord { id: string; type: FeeType; amountCents: number; payeeName: string; payeeAccount: string; files: number[]; paid: boolean; paymentDocId?: number; paymentDocNo?: string; paymentFiles?: number[] }
export interface AcceptedRow extends QtyRow { unitPriceCents: number }
export interface CostPublication { productId: number; purchasePriceCents: number; freightCents: number; handlingCents: number }
export interface Batch {
  id: string;
  shipmentId: string;
  shipment: QtyRow[];
  logisticsNo: string;
  expectedArrivalAt: string;
  dispatchFiles: number[];
  arrived?: boolean;
  arrivalFiles?: number[];
  received?: QtyRow[];
  originalReceived?: QtyRow[];
  receiptFiles?: number[];
  difference?: string;
  deliveryShortage?: QtyRow[];
  deliveryShortageResolved?: boolean;
  accepted?: AcceptedRow[];
  qualityFiles?: number[];
  qualityComment?: string;
  pendingException?: boolean;
  resolution?: ExceptionResolution;
  resolutionComment?: string;
  resolutionFiles?: number[];
  discountApproval?: boolean;
  returnedLines?: QtyRow[];
  retryShipment?: boolean;
  returnedToSupplier?: boolean;
  fees: FeeRecord[];
  feesDeclared?: boolean;
  zeroReason?: string;
  allocationMethod?: AllocationMethod;
  posted?: boolean;
  goodsCents?: number;
  offsetCents?: number;
  docId?: number;
  docNo?: string;
  /** 结算时每个商品发布的单位成本（分，4 位小数） */
  costPublication?: CostPublication[];
}
export interface Followup { at: string; promisedShipAt: string; comment: string; byName: string }

export interface PurchaseState {
  supplierId?: number;
  supplierName?: string;
  warehouseId?: number;
  warehouseName?: string;
  paymentMode?: PaymentMode;
  payeeName?: string;
  payeeAccount?: string;
  planNote?: string;
  planFiles?: number[];
  planReady?: boolean;
  /** 商品单价（分，最多 4 位小数），键是商品档案 id */
  prices: Record<string, number>;
  approved?: boolean;
  approvedCents?: number | null;
  approvalComment?: string;
  payments: PayRecord[];
  /** 本采购占用的供应商已有预付款（分） */
  prepayClaimCents: number;
  /** 已释放回供应商余额的占用（分）：终止、完结时没用完的部分 */
  releasedCents: number;
  paymentReopened?: boolean;
  prepayReviewed?: boolean;
  shipments: Shipment[];
  batches: Batch[];
  cancelledQty: Record<string, number>;
  cancelRequested?: boolean;
  cancelRequestComment?: string;
  cancelApproved?: boolean;
  cancelApprovalComment?: string;
  cancelFiles?: number[];
  cancelledRemaining?: boolean;
  amendOpen?: boolean;
  amendments: Array<{ at: string; byName: string; comment: string; lines: PurchaseLine[]; approvedCents: number | null }>;
  refunds: Array<{ docId: number; docNo: string; sourceDocId: number; amountCents: number; reference: string; files: number[] }>;
  followups: Followup[];
}

export const emptyPurchaseState = (): PurchaseState => ({
  prices: {}, payments: [], prepayClaimCents: 0, releasedCents: 0, shipments: [], batches: [], cancelledQty: {}, amendments: [], refunds: [], followups: [],
});

export const q4 = (n: number): number => Math.round((n + Number.EPSILON) * 10_000) / 10_000;
export const pkey = (id: number): string => String(id);
export const currentBatch = (s: PurchaseState): Batch | undefined => s.batches[s.batches.length - 1];

/** 已入库（已过账批次的合格数量）的合计 */
export function receivedQty(s: PurchaseState, productId: number): number {
  return q4(s.batches.filter((b) => b.posted).reduce((sum, b) => sum + (b.accepted?.find((l) => l.productId === productId)?.qty ?? 0), 0));
}
/** 还要到货的数量 = 采购数量 - 已入库 - 已终止 */
export function remainingQty(s: PurchaseState, line: Pick<PurchaseLine, 'productId' | 'qty'>): number {
  return q4(line.qty - receivedQty(s, line.productId) - (s.cancelledQty[pkey(line.productId)] ?? 0));
}
/** 还没安排发货的数量（已发货但退回换货、确认缺失的数量会重新算回来） */
export function toShipQty(s: PurchaseState, line: Pick<PurchaseLine, 'productId' | 'qty'>): number {
  const shipped = s.shipments.reduce((sum, sh) => sum + (sh.lines.find((l) => l.productId === line.productId)?.qty ?? 0) - (sh.returned[pkey(line.productId)] ?? 0) - (sh.closedMissing[pkey(line.productId)] ?? 0), 0);
  return q4(line.qty - shipped - (s.cancelledQty[pkey(line.productId)] ?? 0));
}
/** 一个已发货批次里还没收到的数量（按原始收货数量算，退回换货的部分要补发所以算回来） */
export function shipmentOutstanding(s: PurchaseState, sh: Shipment, productId: number): number {
  const sent = sh.lines.find((l) => l.productId === productId)?.qty ?? 0;
  const got = s.batches.filter((b) => b.shipmentId === sh.id).reduce((sum, b) => sum + ((b.originalReceived ?? b.received)?.find((r) => r.productId === productId)?.qty ?? 0), 0);
  return q4(sent - (sh.closedMissing[pkey(productId)] ?? 0) - got);
}
/** 还有没收完的已发货批次 */
export const pendingShipments = (s: PurchaseState): Shipment[] => s.shipments.filter((sh) => sh.lines.some((l) => shipmentOutstanding(s, sh, l.productId) > 0));

/** 一行的货款（分）：数量 × 单价后才结算到分 */
export const lineCents = (qty: number, unitPriceCents: number): number => settledLineCents(unitPriceCents, qty);

/** 批准金额 = 已过账批次的货款 + 剩余未到货数量 × 单价；有商品没定价返回 null */
export function approvalCents(lines: readonly PurchaseLine[], s: PurchaseState): number | null {
  if (!lines.length || lines.some((l) => !(s.prices[pkey(l.productId)] > 0))) return null;
  const posted = s.batches.filter((b) => b.posted).reduce((sum, b) => sum + (b.goodsCents ?? 0), 0);
  return posted + lines.reduce((sum, l) => sum + lineCents(Math.max(0, remainingQty(s, l)), s.prices[pkey(l.productId)]), 0);
}

export interface PurchaseFacts { remaining: boolean; pendingException: boolean; retryShipment: boolean; refundNeeded: boolean; feeDue: boolean }
export function purchaseFacts(lines: readonly PurchaseLine[], s: PurchaseState): PurchaseFacts {
  const b = currentBatch(s);
  return {
    remaining: lines.some((l) => remainingQty(s, l) > 0),
    pendingException: !!b?.pendingException,
    retryShipment: !!b?.retryShipment,
    refundNeeded: !!s.cancelApproved,
    feeDue: !!b?.fees.some((f) => !f.paid),
  };
}

export interface PrepayUsage {
  /** 本采购新付的预付款合计、占用的已有预付款、合计 */
  newCents: number; claimCents: number; reservedCents: number;
  /** 已被各批入库冲抵的合计、已释放的合计、还没用掉的合计 */
  consumedCents: number; releasedCents: number; unusedCents: number;
  /** 每笔新付款还没用掉的金额（冲抵先用新付款，按付款先后；用完再用已有预付款） */
  perDoc: Array<{ docId: number; docNo: string; amountCents: number; unusedCents: number }>;
  /** 占用的已有预付款里没用掉、可释放回供应商余额的部分 */
  unusedClaimCents: number;
}
export function prepayUsage(s: PurchaseState): PrepayUsage {
  const newCents = s.payments.reduce((a, p) => a + p.amountCents, 0);
  const consumed = s.batches.reduce((a, b) => a + (b.offsetCents ?? 0), 0);
  let rest = consumed;
  const perDoc = s.payments.map((p) => { const used = Math.min(rest, p.amountCents); rest -= used; return { docId: p.docId, docNo: p.docNo, amountCents: p.amountCents, unusedCents: p.amountCents - used }; });
  const unusedClaim = Math.max(0, s.prepayClaimCents - rest);
  const reserved = newCents + s.prepayClaimCents;
  return {
    newCents, claimCents: s.prepayClaimCents, reservedCents: reserved, consumedCents: consumed, releasedCents: s.releasedCents,
    unusedCents: Math.max(0, reserved - consumed - s.releasedCents), perDoc, unusedClaimCents: unusedClaim,
  };
}

/** 把一笔金额（分）按权重分摊：最大余数法，保证各份加起来正好等于总额。权重全为 0 返回 null。 */
export function allocateCents(total: number, weights: readonly number[]): number[] | null {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (weights.some((w) => !Number.isFinite(w) || w < 0) || !(sum > 0)) return null;
  const shares = weights.map((w, i) => { const raw = (total * w) / sum; return { i, floor: Math.floor(raw), frac: raw - Math.floor(raw) }; });
  let left = total - shares.reduce((a, s) => a + s.floor, 0);
  const ranked = [...shares].sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % ranked.length) { ranked[k].floor += 1; left -= 1; }
  return shares.map((s) => s.floor);
}

export interface AllocLine { productId: number; qty: number; unitPriceCents: number; weightG: number }
/** 运费、装卸费分摊到每个合格商品：返回每行的运费合计、装卸费合计（分）。依据缺失返回 null。 */
export function allocateFees(lines: readonly AllocLine[], fees: ReadonlyArray<{ type: FeeType; amountCents: number }>, method: AllocationMethod): Array<{ freightCents: number; handlingCents: number }> | null {
  const out = lines.map(() => ({ freightCents: 0, handlingCents: 0 }));
  const weights = lines.map((l) => (method === 'quantity' ? l.qty : method === 'weight' ? l.qty * l.weightG : lineCents(l.qty, l.unitPriceCents)));
  for (const fee of fees) {
    const shares = allocateCents(fee.amountCents, weights);
    if (!shares) return null;
    shares.forEach((c, i) => { if (fee.type === 'freight') out[i].freightCents += c; else out[i].handlingCents += c; });
  }
  return out;
}

/** 单位成本（分，最多 4 位小数）：某行分摊到的费用 ÷ 数量 */
export const perUnitCents = (totalCents: number, qty: number): number => (qty > 0 ? Math.round((totalCents / qty) * 10_000) / 10_000 : 0);

/**
 * 条件流转：这一步办完以后去哪一步（沿用旧系统的路由）。返回 undefined 表示按流程定义里的顺序走下一步。
 * 收货、质检发现异常 → 异常处理；异常处理后：终止退款 → 退款确认；整批要重发 → 发货；否则回到质检；
 * 结算后：有费用待付 → 支付费用；还有未到货的 → 回到发货；都完了 → 结束。
 */
export function nextStepKey(step: PurchaseStepKey, lines: readonly PurchaseLine[], s: PurchaseState): PurchaseStepKey | undefined {
  const f = purchaseFacts(lines, s);
  switch (step) {
    case 'receive': return f.pendingException ? 'exception' : 'quality';
    case 'quality': return f.pendingException ? 'exception' : 'expense';
    case 'exception': return f.refundNeeded ? 'refund' : f.retryShipment ? 'dispatch' : 'quality';
    case 'refund': return 'end';
    case 'settle': return f.feeDue ? 'expense_pay' : f.remaining ? 'dispatch' : 'end';
    case 'expense_pay': return f.remaining ? 'dispatch' : 'end';
    default: return undefined;
  }
}

/** 退回到哪一步（沿用旧系统的“退回上一环节”）：没有可退回的返回 undefined。 */
export const RETURN_TARGET: Partial<Record<PurchaseStepKey, PurchaseStepKey>> = {
  plan: 'apply', approve: 'plan', pay: 'approve', receive: 'arrival', quality: 'receive', expense: 'quality', settle: 'expense',
};

/** 有不可撤销的业务事实后，不能退回：返回原因，null 表示可以退回。 */
export function returnBlockedReason(step: PurchaseStepKey, s: PurchaseState): string | null {
  const target = RETURN_TARGET[step];
  if (!target) return '这一步不能退回';
  const b = currentBatch(s);
  if (b?.returnedLines?.length && target === 'receive') return '本批已退回换货，不能再退回收货核对';
  if (['settle', 'expense_pay'].includes(step) && b?.posted) return '本批已入库过账，不能退回';
  if (s.payments.length && ['apply', 'plan', 'approve', 'pay', 'prepay_review', 'dispatch'].includes(target)) return '货款已安排，不能退回到付款前；需要变更请由申请人发起“申请变更采购内容”';
  return null;
}

/** 批次进度的人话，用在列表和详情里 */
export function batchStageLabel(b: Batch): string {
  if (b.posted) return b.fees.some((f) => !f.paid) ? '已入库，待付费用' : '已入库';
  if (b.returnedToSupplier) return '已终止';
  if (b.pendingException) return '异常处理中';
  if (b.accepted) return b.feesDeclared ? '待财务结算' : '待申报费用';
  if (b.received) return '待质检';
  if (b.arrived) return '待核对实收';
  return '运输中';
}
