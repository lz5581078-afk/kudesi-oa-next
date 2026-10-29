import { validUnitCents, settledLineCents } from './unit-price';
/**
 * 财务单据（制单中心）：13 种单据的定义和过账规则，前后端共用。
 *
 * 状态：草稿 draft → 已开立 issued（未过账）→ 已过账 posted；红冲：生成一张金额取反的单据，原单变为已红冲 reversed。
 * 过账：把单据转成“分录”。借方为正、贷方为负，一张单据的分录合计必须为 0（借贷平衡）。
 * 金额一律是整数分，数量是小数（最多 4 位）。
 *
 * 科目（account kind）：
 *  bank 银行账户 · receivable 应收（客户）· payable 应付（供应商）· advance_receipt 预收款（客户）· prepayment 预付款（供应商）
 *  inventory 库存（仓库+商品，带数量）· revenue 销售收入 · cogs 销售成本 · expense 费用 · other_income 其他收入
 *  finance_cost 财务费用（借正贷负：收款优惠/转款手续费是借方=费用，付款优惠是贷方=获得折扣）· in_transit 在途资金（转款已转出、对方未确认到账；账户 id 是转入账户）
 */

/** 公司在国内，“今天”按北京时间算（不能用 UTC，否则凌晨制的单会记到前一天） */
export const todayInChina = (): string => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });

export type DocType =
  | 'sale' | 'online-sale' | 'sale-return' | 'advance-receipt' | 'receipt' | 'payment'
  | 'transfer' | 'prepayment' | 'purchase-in' | 'purchase-return' | 'other-income' | 'expense' | 'withdrawal';

export type DocStatus = 'draft' | 'issued' | 'posted' | 'reversed';

export type AccountKind =
  | 'bank' | 'receivable' | 'payable' | 'advance_receipt' | 'prepayment'
  | 'inventory' | 'revenue' | 'cogs' | 'expense' | 'other_income' | 'opening' | 'finance_cost' | 'in_transit';

/** 往来对象来源：客户档案 / 店铺档案 / 供应商档案（资料里的三份档案，id 在资料表里全局唯一） */
export type PartyKind = 'customer' | 'store' | 'supplier' | 'employee';
export const PARTY_KIND_LABEL: Record<PartyKind, string> = { customer: '客户', store: '店铺', supplier: '供应商', employee: '员工' };
export const PARTY_KIND_RESOURCE: Record<PartyKind, string> = { customer: 'finance-customers', store: 'stores', supplier: 'finance-suppliers', employee: 'finance-employee-parties' };

/** 开单时的结算方式（管家婆式）：全款 / 部分 / 欠款 / 预收预付冲抵 */
export type PayMode = 'full' | 'part' | 'credit' | 'offset';

export interface DocTypeDef {
  type: DocType;
  label: string;
  prefix: string;
  /** 单据要选的往来方（主类型；可选来源见 partyKinds） */
  party: 'customer' | 'supplier' | null;
  /** 往来对象可以从哪几份档案里选，第一个是默认 */
  partyKinds: PartyKind[];
  /** 开单时直接结算：in 表示收到钱（实收），out 表示付出钱（实付）；余额挂应收/应付 */
  settle?: 'in' | 'out';
  /** 界面文案 */
  ui: { partyLabel: string; warehouseLabel: string; amountLabel: string; accountLabel: string; totalLabel: string; saveText: string; detailTitle: string; moneyItemLabel?: string; payModes: Array<{ mode: PayMode; label: string }> };
  partyRequired: boolean;
  /** 明细行：商品行 / 费用行 / 没有（直接填金额） */
  lines: 'product' | 'fee' | null;
  /** 需要选仓库（库存变动） */
  warehouse: boolean;
  /** 银行账户：收款 in / 付款 out / 无 */
  bank: 'in' | 'out' | 'none' | 'transfer';
  /** 可以用 预收/预付 冲抵一部分 */
  offset: 'advance_receipt' | 'prepayment' | null;
  /** 一句话说明过账结果 */
  posting: string;
  /** 费用行方向 */
  feeDirection?: 'expense' | 'income';
  /** 库存方向 */
  stock?: 'in' | 'out';
  /** 要选店铺，并登记平台流水号（店铺提现） */
  store?: boolean;
}

export const DOC_TYPES: readonly DocTypeDef[] = [
  { type: 'sale', label: '普通销售单', prefix: 'XS', party: 'customer', partyKinds: ['customer'], partyRequired: true, lines: 'product', warehouse: true, bank: 'none', settle: 'in', offset: 'advance_receipt', stock: 'out',
    posting: '借：应收账款 贷：销售收入；借：销售成本 贷：库存；收到的钱：借：银行 贷：应收账款',
    ui: { partyLabel: '客户', warehouseLabel: '出货仓库', amountLabel: '收到金额', accountLabel: '收款账户', totalLabel: '本单销售合计', saveText: '保存销售单', detailTitle: '商品明细', payModes: [{ mode: 'full', label: '收了全款' }, { mode: 'part', label: '收了部分款' }, { mode: 'credit', label: '欠款' }, { mode: 'offset', label: '用预收款结算' }] } },
  { type: 'online-sale', label: '网店销售单', prefix: 'WDXS', party: 'customer', partyKinds: ['store'], partyRequired: true, lines: 'product', warehouse: true, bank: 'none', settle: 'in', offset: null, stock: 'out',
    posting: '借：应收账款（平台/店铺）贷：销售收入；借：销售成本 贷：库存；平台回款：借：银行 贷：应收账款',
    ui: { partyLabel: '销售店铺', warehouseLabel: '出货仓库', amountLabel: '收到金额', accountLabel: '收款账户', totalLabel: '本单销售合计', saveText: '保存网店销售单', detailTitle: '商品明细', payModes: [{ mode: 'full', label: '收了全款' }, { mode: 'part', label: '收了部分款' }, { mode: 'credit', label: '欠款' }] } },
  { type: 'sale-return', label: '销售退货单', prefix: 'XSTH', party: 'customer', partyKinds: ['customer', 'store'], partyRequired: true, lines: 'product', warehouse: true, bank: 'none', settle: 'out', offset: null, stock: 'in',
    posting: '借：销售收入 贷：应收账款；借：库存 贷：销售成本；退回的钱：借：应收账款 贷：银行',
    ui: { partyLabel: '客户', warehouseLabel: '退回仓库', amountLabel: '退款金额', accountLabel: '退款账户', totalLabel: '本单退货合计', saveText: '保存销售退货单', detailTitle: '退货商品明细', payModes: [{ mode: 'full', label: '退了全款' }, { mode: 'part', label: '退了部分款' }, { mode: 'credit', label: '暂不退款' }] } },
  { type: 'advance-receipt', label: '预收款单', prefix: 'YS', party: 'customer', partyKinds: ['customer', 'store'], partyRequired: true, lines: null, warehouse: false, bank: 'in', offset: null,
    posting: '借：银行 贷：预收款',
    ui: { partyLabel: '客户', warehouseLabel: '', amountLabel: '收到金额', accountLabel: '收款账户', totalLabel: '本单预收合计', saveText: '保存预收款单', detailTitle: '预收款明细', moneyItemLabel: '预收项目', payModes: [] } },
  { type: 'receipt', label: '收款单', prefix: 'SK', party: 'customer', partyKinds: ['customer', 'store'], partyRequired: true, lines: null, warehouse: false, bank: 'in', offset: 'advance_receipt',
    posting: '借：银行（及预收冲抵）贷：应收账款',
    ui: { partyLabel: '客户', warehouseLabel: '', amountLabel: '到账金额', accountLabel: '收款账户', totalLabel: '本单收款合计', saveText: '保存收款单', detailTitle: '收款明细', moneyItemLabel: '收款来源', payModes: [] } },
  { type: 'payment', label: '付款单', prefix: 'FK', party: 'supplier', partyKinds: ['supplier', 'customer', 'employee'], partyRequired: true, lines: null, warehouse: false, bank: 'out', offset: 'prepayment',
    posting: '借：应付账款 贷：银行（及预付冲抵）',
    ui: { partyLabel: '收款方', warehouseLabel: '', amountLabel: '付款金额', accountLabel: '付款账户', totalLabel: '本单付款合计', saveText: '保存付款单', detailTitle: '付款明细', moneyItemLabel: '付款用途', payModes: [] } },
  { type: 'withdrawal', label: '店铺提现', prefix: 'TX', party: 'customer', partyKinds: ['store'], partyRequired: false, store: true, lines: null, warehouse: false, bank: 'in', offset: null,
    posting: '借：银行（提现到账）贷：应收账款（平台货款）。在店铺登录后远程提现，提现一笔登记一笔',
    ui: { partyLabel: '平台货款往来（选填）', warehouseLabel: '', amountLabel: '到账金额', accountLabel: '收款账户', totalLabel: '本单提现合计', saveText: '保存提现单', detailTitle: '提现明细', payModes: [] } },
  { type: 'transfer', label: '转款单', prefix: 'ZK', party: null, partyKinds: [], partyRequired: false, lines: null, warehouse: false, bank: 'transfer', offset: null,
    posting: '借：转入账户 贷：转出账户',
    ui: { partyLabel: '', warehouseLabel: '', amountLabel: '转款金额', accountLabel: '转出账户', totalLabel: '本单转款合计', saveText: '保存转款单', detailTitle: '转款明细', moneyItemLabel: '转款用途', payModes: [] } },
  { type: 'prepayment', label: '预付款单', prefix: 'YF', party: 'supplier', partyKinds: ['supplier'], partyRequired: true, lines: null, warehouse: false, bank: 'out', offset: null,
    posting: '借：预付款 贷：银行',
    ui: { partyLabel: '供应商', warehouseLabel: '', amountLabel: '付款金额', accountLabel: '付款账户', totalLabel: '本单预付合计', saveText: '保存预付款单', detailTitle: '预付款明细', moneyItemLabel: '预付项目', payModes: [] } },
  { type: 'purchase-in', label: '采购入库单', prefix: 'CGRK', party: 'supplier', partyKinds: ['supplier'], partyRequired: true, lines: 'product', warehouse: true, bank: 'none', settle: 'out', offset: 'prepayment', stock: 'in',
    posting: '借：库存 贷：应付账款（及预付冲抵）；付出的钱：借：应付账款 贷：银行',
    ui: { partyLabel: '供应商', warehouseLabel: '入库仓库', amountLabel: '付款金额', accountLabel: '付款账户', totalLabel: '本单采购合计', saveText: '保存采购入库单', detailTitle: '入库商品明细', payModes: [{ mode: 'full', label: '付了全款' }, { mode: 'part', label: '付了部分款' }, { mode: 'credit', label: '欠款' }, { mode: 'offset', label: '用预付款结算' }] } },
  { type: 'purchase-return', label: '采购退货单', prefix: 'CGTH', party: 'supplier', partyKinds: ['supplier'], partyRequired: true, lines: 'product', warehouse: true, bank: 'none', settle: 'in', offset: null, stock: 'out',
    posting: '借：应付账款 贷：库存；收到的退款：借：银行 贷：应付账款',
    ui: { partyLabel: '供应商', warehouseLabel: '退货仓库', amountLabel: '收到退款', accountLabel: '收款账户', totalLabel: '本单退货合计', saveText: '保存采购退货单', detailTitle: '退货商品明细', payModes: [{ mode: 'full', label: '已退全款' }, { mode: 'part', label: '退了部分款' }, { mode: 'credit', label: '暂未退款' }] } },
  { type: 'other-income', label: '其他收入单', prefix: 'QTSR', party: 'customer', partyKinds: ['customer', 'store', 'supplier', 'employee'], partyRequired: false, lines: 'fee', warehouse: false, bank: 'none', settle: 'in', offset: null, feeDirection: 'income',
    posting: '借：银行 贷：其他收入；没收齐的部分挂应收（要选往来对象）',
    ui: { partyLabel: '来源对象（选填）', warehouseLabel: '', amountLabel: '收到金额', accountLabel: '收款账户', totalLabel: '本单收入合计', saveText: '保存其他收入单', detailTitle: '收入明细', moneyItemLabel: '收入项目', payModes: [{ mode: 'full', label: '已收全款' }, { mode: 'part', label: '收了部分' }, { mode: 'credit', label: '暂未收款' }] } },
  { type: 'expense', label: '费用单', prefix: 'FY', party: 'supplier', partyKinds: ['supplier', 'customer', 'store', 'employee'], partyRequired: false, lines: 'fee', warehouse: false, bank: 'none', settle: 'out', offset: 'prepayment', feeDirection: 'expense',
    posting: '借：费用 贷：银行（及预付冲抵）；没付清的部分挂应付（要选往来对象）。不选往来对象就是现金费用单，必须当场付清',
    ui: { partyLabel: '收费单位（选填）', warehouseLabel: '', amountLabel: '实付金额', accountLabel: '付款账户', totalLabel: '本单费用合计', saveText: '保存费用单', detailTitle: '费用明细', moneyItemLabel: '费用项目', payModes: [{ mode: 'full', label: '已付全款' }, { mode: 'part', label: '付了部分' }, { mode: 'credit', label: '暂未付款（挂应付）' }, { mode: 'offset', label: '用预付款结算' }] } },
];

export const DOC_TYPE_MAP = new Map(DOC_TYPES.map((d) => [d.type, d]));

/** 经营历程的“收支方向”（沿用旧系统各单据的方向）：收入 / 支出 / 内部流转（转款、提现是自己的钱换个地方） */
export type DocDirection = 'in' | 'out' | 'internal';
export const DOC_DIRECTION_LABEL: Record<DocDirection, string> = { in: '收入', out: '支出', internal: '内部流转' };
export const DOC_DIRECTION: Record<DocType, DocDirection> = {
  sale: 'in', 'online-sale': 'in', 'sale-return': 'out', 'advance-receipt': 'in', receipt: 'in', payment: 'out', transfer: 'internal',
  prepayment: 'out', 'purchase-in': 'out', 'purchase-return': 'in', 'other-income': 'in', expense: 'out', withdrawal: 'internal',
};
export const docTypesOfDirection = (d: DocDirection): DocType[] => DOC_TYPES.filter((t) => DOC_DIRECTION[t.type] === d).map((t) => t.type);

/** 单据是否有“银行流水号”：提现单必填（平台提现流水号），其他会动钱的收付款类单据选填；同一个流水号全公司只能登记一次 */
export const hasBankRef = (def: DocTypeDef): boolean => !!def.store || def.bank === 'in' || def.bank === 'out' || !!def.settle;
export const DOC_STATUS_LABEL: Record<DocStatus, string> = { draft: '草稿', issued: '已开立', posted: '已过账', reversed: '已红冲' };
export const ACCOUNT_LABEL: Record<AccountKind, string> = {
  bank: '银行账户', receivable: '应收账款', payable: '应付账款', advance_receipt: '预收款', prepayment: '预付款',
  opening: '期初', inventory: '库存', revenue: '销售收入', cogs: '销售成本', expense: '费用', other_income: '其他收入',
  finance_cost: '财务费用（现金折扣/手续费）', in_transit: '在途资金',
};

/** 收款单、付款单可以填“优惠金额”：给/得到对方的优惠，冲减往来余额，同时计入财务费用（管家婆 A8 收付款单“优惠金额”） */
export const MONEY_DISCOUNT_TYPES: readonly DocType[] = ['receipt', 'payment'];
export const hasMoneyDiscount = (type: DocType): boolean => MONEY_DISCOUNT_TYPES.includes(type);

/**
 * 多账户收付款：这种单据的钱进（in）还是出（out）银行账户，null 表示不支持分账户（转款单有自己的转出/转入账户；店铺提现单只有一个到账账户）。
 * 单据上每个账户一行（账户 + 金额），合计 = 实收/实付（有商品明细的单据）或单据金额（收款单、付款单这类没有挂账的单据）。
 */
export function payRole(def: Pick<DocTypeDef, 'bank' | 'settle' | 'store'>): 'in' | 'out' | null {
  if (def.bank === 'transfer' || def.store) return null;
  if (def.bank === 'in' || def.bank === 'out') return def.bank;
  return def.settle === 'in' ? 'in' : def.settle === 'out' ? 'out' : null;
}

export interface DocLineInput {
  productId?: number | null;
  feeItemId?: number | null;
  qty: number;
  /** 单价，分 */
  unitPriceCents: number;
  /** 销售类：该行成本单价（分）；不填则取商品当前成本 */
  unitCostCents?: number | null;
  memo?: string;
  /** 费用/收入行的“挂账节点”（公司、店铺、人员、营业执照……）和具体对象；有对应资料的选 id，没有的只写名字 */
  relatedNode?: string | null;
  relatedId?: number | null;
  relatedName?: string | null;
  /** 没有商品/费用项目的金额类单据（收款、付款、预收、预付、转款）的明细行：项目名称，金额放 unitPriceCents（数量固定 1） */
  itemName?: string | null;
  /** 商品行的单位（文字，开单时从商品档案带出，可改） */
  unit?: string | null;
}

/** 转款单的账户分配：可以多个账户转出、多个账户转入，两边金额合计必须相等 */
export interface TransferAccount { role: 'out' | 'in'; bankAccountId: number; amountCents: number }

export interface DocInput {
  type: DocType;
  date: string;
  partyId?: number | null;
  /** 往来对象来自哪份档案；不填取单据类型的默认来源 */
  partyKind?: PartyKind | null;
  bankAccountId?: number | null;
  toBankAccountId?: number | null;
  warehouseId?: number | null;
  /** 店铺提现：店铺档案 id 和平台提现流水号 */
  storeId?: number | null;
  refNo?: string | null;
  /**
   * 多账户分配。转款单：多个转出、多个转入账户（不填则用 bankAccountId → toBankAccountId 加 amountCents 的单账户写法）；
   * 收付款类单据：分几个账户收/付（role 固定为 payRole，不填就是 bankAccountId 单账户，老单据都是这种）。
   */
  accounts?: TransferAccount[] | null;
  /** 没有明细行的单据：金额，分 */
  amountCents?: number | null;
  /** 冲抵的预收/预付金额，分 */
  offsetCents?: number | null;
  /**
   * 优惠金额，分。商品类单据（管家婆“优惠金额/抹零”）：单据金额 = 明细合计 − 优惠，销售收入/应收/采购成本都按优惠后计；
   * 收款单/付款单（A8 收付款“优惠金额”）：到账/付出金额之外，再冲减往来余额这么多，同时计入财务费用（收款优惠借记、付款优惠贷记）。
   */
  discountCents?: number | null;
  /** 转款手续费，分；由 feeBearer 指定的一方（转出方 out / 转入方 in）的第一个账户扣，计入财务费用 */
  feeCents?: number | null;
  feeBearer?: 'out' | 'in' | null;
  /** 转款先登记为“在途”：只从转出账户扣，转入账户等对方确认到账后（确认入账）才增加 */
  inTransit?: boolean | null;
  /** 经手人：员工 id（服务端取员工姓名存到 handler）；老数据只有 handler 文字 */
  handlerId?: number | null;
  /** 开单时当场结算的金额（实收/实付），分；其余挂应收/应付。只有 settle 类单据用 */
  paidCents?: number | null;
  /** 经办人、归属部门（文字，管家婆开单页上的“经办人/部门”） */
  handler?: string | null;
  department?: string | null;
  /** 手工指定单据编号；不填按“前缀+日期+流水”自动生成 */
  docNo?: string | null;
  lines?: DocLineInput[];
  /** 收款单/付款单的结算方式：amount 按金额（直接冲往来余额）· doc 按单据结算 · product 按商品结算 */
  settleBy?: SettleBy | null;
  /** 按单据/按商品结算时，这次的钱分给了哪些单据（按商品还要写商品）；合计必须等于本次结算金额（收付款金额 + 预收/预付冲抵） */
  settlements?: SettlementInput[] | null;
}

export type SettleBy = 'amount' | 'doc' | 'product';
export const SETTLE_BY_LABEL: Record<SettleBy, string> = { amount: '按金额结算', doc: '按单据结算', product: '按商品结算' };
export interface SettlementInput { sourceDocId: number; productId?: number | null; amountCents: number }
/** 能做按单/按商品结算的单据 */
export const SETTLEMENT_DOC_TYPES: readonly DocType[] = ['receipt', 'payment'];

export interface Entry {
  kind: AccountKind;
  /** 银行账户/客户/供应商/商品/费用项 的 id；没有则 0 */
  accountId: number;
  /** 库存：仓库 id */
  subId: number;
  /** 借正贷负，整数分 */
  amount: number;
  /** 库存数量变化（入库正、出库负） */
  qty: number | null;
}

export const lineAmount = (l: Pick<DocLineInput, 'qty' | 'unitPriceCents'>): number => { try { return settledLineCents(l.unitPriceCents, l.qty); } catch { return NaN; } };

/** 当场结算金额。费用单/其他收入单没填就当“当场付清/收齐”（现金费用）；其他单据没填就是 0（全部挂账）。 */
export function effectivePaid(def: DocTypeDef, input: Pick<DocInput, 'paidCents' | 'partyId'> & { accounts?: DocInput['accounts'] }, total: number): number {
  if (!def.settle) return 0;
  // 分了多个账户：实收实付就是各账户金额之和
  if (payRole(def) && input.accounts?.length) return input.accounts.reduce((s, a) => s + (Number.isFinite(a.amountCents) ? a.amountCents : 0), 0);
  if (input.paidCents === null || input.paidCents === undefined) return def.lines === 'fee' ? total : 0;
  return input.paidCents;
}

/** 明细合计（未扣优惠） */
export const grossTotal = (input: Pick<DocInput, 'lines'>): number => (input.lines ?? []).reduce((sum, l) => sum + lineAmount(l), 0);

/** 把整单优惠按各行金额比例摊到每一行（分），最后一个有金额的行补尾差；用于采购入库/退货把优惠摊进库存成本 */
export function allocateDiscount(amounts: number[], discount: number): number[] {
  const sum = amounts.reduce((a, b) => a + b, 0);
  if (!discount || sum <= 0) return amounts.map(() => 0);
  const out = amounts.map((a) => Math.floor((a * discount) / sum));
  let left = discount - out.reduce((a, b) => a + b, 0);
  for (let i = amounts.length - 1; i >= 0 && left > 0; i--) if (amounts[i] > 0) { out[i] += left; left = 0; }
  return out;
}

export function docTotal(def: DocTypeDef, input: Pick<DocInput, 'amountCents' | 'lines' | 'accounts' | 'discountCents'>): number {
  if (def.bank === 'transfer' && input.accounts?.length) return input.accounts.filter((a) => a.role === 'out').reduce((s, a) => s + a.amountCents, 0);
  if (def.lines) return grossTotal(input) - (def.lines === 'product' ? input.discountCents ?? 0 : 0);
  // 金额类单据可以写多行金额明细（旧系统同款），合计就是单据金额；不写明细则直接用 amountCents
  if (input.lines?.length) return input.lines.reduce((sum, l) => sum + lineAmount(l), 0);
  return input.amountCents ?? 0;
}

/** 草稿校验：返回错误文字列表，空表示可以开立。 */
export function validateDoc(input: DocInput): string[] {
  const def = DOC_TYPE_MAP.get(input.type);
  if (!def) return ['单据类型不认识'];
  const errors: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date ?? '')) errors.push('请选择单据日期');
  if (input.docNo && !/^[A-Za-z0-9_-]{1,32}$/.test(input.docNo)) errors.push('单据编号只能用字母、数字、横线、下划线，最多 32 位');
  if (def.party && def.partyRequired && !input.partyId) errors.push(`请选择${def.ui.partyLabel.replace(/（选填）/, '')}`);
  if (def.warehouse && !input.warehouseId) errors.push('请选择仓库');
  if (def.store) {
    if (!input.storeId) errors.push('请选择提现的店铺');
    if (!input.refNo?.trim()) errors.push('请填写平台提现流水号');
    else if (input.refNo.trim().length > 80) errors.push('平台提现流水号不超过 80 字');
  }
  if (!def.store && hasBankRef(def) && (input.refNo?.trim().length ?? 0) > 80) errors.push('银行流水号不超过 80 字');
  const multiRole = def.bank !== 'transfer' ? payRole(def) : null;
  const split = multiRole && input.accounts?.length ? input.accounts : null;
  if (def.bank === 'in' || def.bank === 'out') if (!input.bankAccountId && !split) errors.push(def.bank === 'in' ? '请选择收款银行账户' : '请选择付款银行账户');
  if (def.bank !== 'transfer' && input.accounts?.length) {
    if (!multiRole) errors.push('这种单据不能分多个账户');
    else {
      const accts = input.accounts;
      if (accts.some((a) => a.role !== multiRole)) errors.push(`分账户的方向不对（这种单据的钱${multiRole === 'in' ? '收进' : '付出'}账户）`);
      if (accts.some((a) => !a.bankAccountId || !Number.isInteger(a.amountCents) || a.amountCents <= 0)) errors.push('每个账户都要选好账户，并填大于 0 的金额');
      if (new Set(accts.map((a) => a.bankAccountId)).size !== accts.length) errors.push('同一个账户不能重复选');
    }
  }
  if (def.bank === 'transfer') {
    if (input.accounts?.length) {
      const outs = input.accounts.filter((a) => a.role === 'out'), ins = input.accounts.filter((a) => a.role === 'in');
      if (!outs.length || !ins.length) errors.push('请至少选一个转出账户和一个转入账户');
      if (input.accounts.some((a) => !a.bankAccountId || !Number.isInteger(a.amountCents) || a.amountCents <= 0)) errors.push('每个转款账户都要填大于 0 的金额');
      const so = outs.reduce((s, a) => s + a.amountCents, 0), si = ins.reduce((s, a) => s + a.amountCents, 0);
      if (outs.length && ins.length && so !== si) errors.push(`转出合计 ${(so / 100).toFixed(2)} 元和转入合计 ${(si / 100).toFixed(2)} 元不相等`);
      const outIds = new Set(outs.map((a) => a.bankAccountId));
      if (ins.some((a) => outIds.has(a.bankAccountId))) errors.push('同一个账户不能既转出又转入');
      if (new Set(outs.map((a) => a.bankAccountId)).size !== outs.length || new Set(ins.map((a) => a.bankAccountId)).size !== ins.length) errors.push('同一边不能重复选同一个账户');
    } else if (!input.bankAccountId || !input.toBankAccountId) errors.push('请选择转出和转入账户');
    else if (input.bankAccountId === input.toBankAccountId) errors.push('转出和转入不能是同一个账户');
  }
  const fee = input.feeCents ?? 0;
  if (fee) {
    if (def.bank !== 'transfer') errors.push('只有转款单能填手续费');
    else if (!Number.isInteger(fee) || fee < 0) errors.push('手续费金额不合法');
    else if (input.feeBearer !== 'out' && input.feeBearer !== 'in') errors.push('请选择手续费由转出方还是转入方承担');
  }
  if (input.inTransit && def.bank !== 'transfer') errors.push('只有转款单能登记为在途');
  if (def.lines) {
    const lines = input.lines ?? [];
    if (lines.length === 0) errors.push('至少要有一行明细');
    lines.forEach((l, i) => {
      const n = i + 1;
      if (def.lines === 'product' && !l.productId) errors.push(`第 ${n} 行请选择商品`);
      if (def.lines === 'fee' && !l.feeItemId) errors.push(`第 ${n} 行请选择费用项目`);
      if (!(l.qty > 0) || Math.round(l.qty * 10000) / 10000 !== l.qty) errors.push(`第 ${n} 行数量必须大于 0（最多 4 位小数）`);
      if (!validUnitCents(l.unitPriceCents) || l.unitPriceCents < 0) errors.push(`第 ${n} 行单价不合法`);
    });
  } else if (input.lines?.length) {
    input.lines.forEach((l, i) => {
      const n = i + 1;
      if (!l.itemName?.trim()) errors.push(`第 ${n} 行请填写${def.ui.moneyItemLabel ?? '项目'}`);
      if (!Number.isInteger(l.unitPriceCents) || l.unitPriceCents <= 0) errors.push(`第 ${n} 行金额必须大于 0（最多两位小数）`);
    });
    if (def.bank === 'transfer' && input.accounts?.length) {
      const so = input.accounts.filter((a) => a.role === 'out').reduce((s, a) => s + a.amountCents, 0), want = docTotal({ ...def, bank: 'none' }, input);
      if (so !== want) errors.push(`转出账户分配合计 ${(so / 100).toFixed(2)} 元要等于明细合计 ${(want / 100).toFixed(2)} 元`);
    }
  } else if (!(def.bank === 'transfer' && input.accounts?.length) && (!Number.isInteger(input.amountCents) || (input.amountCents as number) <= 0)) {
    errors.push('金额必须大于 0');
  }
  const total = docTotal(def, input);
  const discount = input.discountCents ?? 0;
  if (discount) {
    if (hasMoneyDiscount(input.type)) {
      if (!Number.isInteger(discount) || discount < 0) errors.push('优惠金额不合法');
      else if (!input.partyId) errors.push('填优惠金额要先选择往来对象（优惠冲减的是他的往来余额）');
    } else if (def.lines !== 'product') errors.push('只有商品类单据能填优惠金额（收款单、付款单也可以填）');
    else if (!Number.isInteger(discount) || discount < 0) errors.push('优惠金额不合法');
    else if (discount >= grossTotal(input)) errors.push('优惠金额必须小于明细合计');
  }
  // 分账户：没有挂账概念的收付款单据，各账户合计必须等于单据金额；有商品明细的单据，合计就是实收实付，已写明的实收实付要一致
  if (split) {
    const sum = split.reduce((s, a) => s + (Number.isFinite(a.amountCents) ? a.amountCents : 0), 0);
    if (def.settle) {
      if (input.paidCents !== null && input.paidCents !== undefined && input.paidCents !== sum) errors.push(`各账户金额合计 ${(sum / 100).toFixed(2)} 元，要等于${def.ui.amountLabel} ${(input.paidCents / 100).toFixed(2)} 元`);
    } else if (sum !== total) errors.push(`各账户金额合计 ${(sum / 100).toFixed(2)} 元，要等于本单金额 ${(total / 100).toFixed(2)} 元`);
  }
  if (def.lines && total <= 0) errors.push('单据金额必须大于 0');
  const offset = input.offsetCents ?? 0;
  if (offset) {
    if (!def.offset) errors.push('这种单据不能冲抵预收/预付');
    else if (!Number.isInteger(offset) || offset < 0) errors.push('冲抵金额不合法');
    else if ((def.lines && def.settle) && offset > total) errors.push('冲抵金额不能超过单据金额');
  }
  if (input.settleBy && input.settleBy !== 'amount') {
    if (!SETTLEMENT_DOC_TYPES.includes(input.type)) errors.push('只有收款单、付款单能按单据或按商品结算');
    else {
      const ss = input.settlements ?? [];
      if (!ss.length) errors.push(`${SETTLE_BY_LABEL[input.settleBy]}要选择结算的单据`);
      ss.forEach((x, i) => {
        if (!x.sourceDocId) errors.push(`结算第 ${i + 1} 行请选择单据`);
        if (!Number.isInteger(x.amountCents) || x.amountCents <= 0) errors.push(`结算第 ${i + 1} 行金额必须大于 0`);
        if (input.settleBy === 'product' && !x.productId) errors.push(`结算第 ${i + 1} 行请选择商品`);
      });
      const sum = ss.reduce((a, x) => a + (Number.isInteger(x.amountCents) ? x.amountCents : 0), 0);
      const want = total + (input.offsetCents ?? 0) + (hasMoneyDiscount(input.type) ? input.discountCents ?? 0 : 0);
      if (ss.length && sum !== want) errors.push(`结算单据合计 ${(sum / 100).toFixed(2)} 元，要等于本次结算金额 ${(want / 100).toFixed(2)} 元（收付款金额加预收/预付冲抵、优惠金额）`);
    }
  }
  const paid = effectivePaid(def, input, total);
  if (def.lines === 'fee' && def.settle && paid + offset < total && !input.partyId) errors.push(`没${def.settle === 'in' ? '收齐' : '付清'}的部分要挂账，请选择${def.ui.partyLabel.replace('（选填）', '')}（不挂账就必须当场${def.settle === 'in' ? '收齐' : '付清'}）`);
  if (offset && def.lines === 'fee' && !input.partyId) errors.push(`冲抵${ACCOUNT_LABEL[def.offset as AccountKind] ?? '预付款'}要先选择${def.ui.partyLabel.replace('（选填）', '')}`);
  if (paid) {
    if (!def.settle) errors.push('这种单据不能当场结算');
    else if (!Number.isInteger(paid) || paid < 0) errors.push(`${def.ui.amountLabel}不合法`);
    else {
      if (paid + (offset || 0) > total) errors.push(`${def.ui.amountLabel}加冲抵不能超过本单合计`);
      if (!input.bankAccountId && !split) errors.push(`请选择${def.ui.accountLabel}`);
    }
  }
  return errors;
}

/**
 * 把单据转成分录（红冲时对结果整体取反）。
 * costOf：销售类按商品取成本单价（分）；拿不到成本就抛错，由调用方转成提示。
 */
export function buildEntries(input: DocInput, costOf: (productId: number) => number | null): Entry[] {
  const def = DOC_TYPE_MAP.get(input.type);
  if (!def) throw new Error('单据类型不认识');
  const partyId = input.partyId ?? 0;
  const bank = input.bankAccountId ?? 0;
  const wh = input.warehouseId ?? 0;
  const total = docTotal(def, input);
  const offset = input.offsetCents ?? 0;
  const paid = effectivePaid(def, input, total);
  const e = (kind: AccountKind, accountId: number, amount: number, qty: number | null = null, subId = 0): Entry => ({ kind, accountId, subId, amount, qty });
  const out: Entry[] = [];
  // 分账户收付款：每个账户一条银行分录；没分账户就是单账户（bankAccountId）
  const split = def.bank !== 'transfer' && payRole(def) && input.accounts?.length ? input.accounts : null;
  const bankLegs = (sign: 1 | -1, amount: number): Entry[] => (split ? split.map((a) => e('bank', a.bankAccountId, sign * a.amountCents)) : amount ? [e('bank', bank, sign * amount)] : []);
  const moneyDiscount = hasMoneyDiscount(input.type) ? input.discountCents ?? 0 : 0;

  const stockLines = () => (input.lines ?? []).map((l) => {
    const productId = l.productId as number;
    const unit = l.unitCostCents ?? costOf(productId);
    if (unit === null || unit === undefined) throw new Error('COST_MISSING');
    return { productId, qty: l.qty, cost: settledLineCents(unit, l.qty) };
  });

  switch (input.type) {
    case 'sale':
    case 'online-sale':
      out.push(e('receivable', partyId, total), e('revenue', 0, -total));
      for (const s of stockLines()) out.push(e('cogs', s.productId, s.cost), e('inventory', s.productId, -s.cost, -s.qty, wh));
      // 当场收到的钱、用预收款结算的部分，从应收里减掉；剩下的就是欠款
      if (paid) out.push(...bankLegs(1, paid), e('receivable', partyId, -paid));
      if (offset) out.push(e('advance_receipt', partyId, offset), e('receivable', partyId, -offset));
      break;
    case 'sale-return':
      out.push(e('revenue', 0, total), e('receivable', partyId, -total));
      for (const s of stockLines()) out.push(e('inventory', s.productId, s.cost, s.qty, wh), e('cogs', s.productId, -s.cost));
      // 当场退出去的钱：把冲掉的应收再挂回来
      if (paid) out.push(e('receivable', partyId, paid), ...bankLegs(-1, paid));
      break;
    case 'advance-receipt':
      out.push(...bankLegs(1, total), e('advance_receipt', partyId, -total));
      break;
    case 'receipt':
      // 收款优惠：给对方让利，冲减应收但没收到钱，借记财务费用
      out.push(...bankLegs(1, total));
      if (offset) out.push(e('advance_receipt', partyId, offset));
      if (moneyDiscount) out.push(e('finance_cost', 0, moneyDiscount));
      out.push(e('receivable', partyId, -(total + offset + moneyDiscount)));
      break;
    case 'withdrawal':
      out.push(e('bank', bank, total), e('receivable', partyId, -total));
      break;
    case 'payment':
      // 付款优惠：对方给的折扣，冲减应付但没付钱，贷记财务费用
      out.push(e('payable', partyId, total + offset + moneyDiscount), ...bankLegs(-1, total));
      if (offset) out.push(e('prepayment', partyId, -offset));
      if (moneyDiscount) out.push(e('finance_cost', 0, -moneyDiscount));
      break;
    case 'transfer':
      out.push(...transferEntries(input, total, false));
      break;
    case 'prepayment':
      out.push(e('prepayment', partyId, total), ...bankLegs(-1, total));
      break;
    case 'purchase-in': {
      // 整单优惠摊进每行入库成本
      const cut = allocateDiscount((input.lines ?? []).map(lineAmount), input.discountCents ?? 0);
      (input.lines ?? []).forEach((l, i) => out.push(e('inventory', l.productId as number, lineAmount(l) - cut[i], l.qty, wh)));
      out.push(e('payable', partyId, -(total - offset)));
      if (offset) out.push(e('prepayment', partyId, -offset));
      if (paid) out.push(e('payable', partyId, paid), ...bankLegs(-1, paid));
      break;
    }
    case 'purchase-return': {
      out.push(e('payable', partyId, total));
      const cut = allocateDiscount((input.lines ?? []).map(lineAmount), input.discountCents ?? 0);
      (input.lines ?? []).forEach((l, i) => out.push(e('inventory', l.productId as number, -(lineAmount(l) - cut[i]), -l.qty, wh)));
      if (paid) out.push(...bankLegs(1, paid), e('payable', partyId, -paid));
      break;
    }
    case 'other-income':
      for (const l of input.lines ?? []) out.push(e('other_income', l.feeItemId as number, -lineAmount(l)));
      if (paid) out.push(...bankLegs(1, paid));
      if (total - paid) out.push(e('receivable', partyId, total - paid));
      break;
    case 'expense':
      for (const l of input.lines ?? []) out.push(e('expense', l.feeItemId as number, lineAmount(l)));
      if (paid) out.push(...bankLegs(-1, paid));
      if (offset) out.push(e('prepayment', partyId, -offset));
      if (total - paid - offset) out.push(e('payable', partyId, -(total - paid - offset)));
      break;
  }
  const sum = out.reduce((s, x) => s + x.amount, 0);
  if (sum !== 0) throw new Error(`借贷不平衡（差 ${sum} 分）`);
  return out;
}

const entry = (kind: AccountKind, accountId: number, amount: number): Entry => ({ kind, accountId, subId: 0, amount, qty: null });

/** 转款的转出/转入账户（多账户写法或单账户写法统一成列表） */
function transferLegs(input: DocInput, total: number): TransferAccount[] {
  if (input.accounts?.length) return input.accounts;
  return [{ role: 'out', bankAccountId: input.bankAccountId ?? 0, amountCents: total }, { role: 'in', bankAccountId: input.toBankAccountId ?? 0, amountCents: total }];
}

/**
 * 转款分录。普通转款：转出账户减、转入账户加。
 * 在途（inTransit）：转出账户减，转入侧先记“在途资金”（账户 id = 转入账户），等 buildTransferConfirmEntries 才转进银行。
 * 手续费：由承担方的第一个账户扣（银行减），对方科目是财务费用（借）。转入方承担且在途时，手续费等确认到账那一刻才扣。
 */
function transferEntries(input: DocInput, total: number, confirming: boolean): Entry[] {
  const legs = transferLegs(input, total);
  const out: Entry[] = [];
  const fee = input.feeCents ?? 0;
  const feeAcct = (role: 'out' | 'in') => legs.find((a) => a.role === role)?.bankAccountId ?? 0;
  const transit = !!input.inTransit;
  if (!confirming) {
    for (const a of legs) {
      if (a.role === 'out') out.push(entry('bank', a.bankAccountId, -a.amountCents));
      else if (transit) out.push(entry('in_transit', a.bankAccountId, a.amountCents));
      else out.push(entry('bank', a.bankAccountId, a.amountCents));
    }
    if (fee && (input.feeBearer !== 'in' || !transit)) out.push(entry('bank', feeAcct(input.feeBearer === 'in' ? 'in' : 'out'), -fee), entry('finance_cost', 0, fee));
  } else {
    for (const a of legs) if (a.role === 'in') out.push(entry('in_transit', a.bankAccountId, -a.amountCents), entry('bank', a.bankAccountId, a.amountCents));
    if (fee && input.feeBearer === 'in') out.push(entry('bank', feeAcct('in'), -fee), entry('finance_cost', 0, fee));
  }
  return out;
}

/** 确认入账时追加的分录：在途资金转入转入账户；转入方承担的手续费这时才扣。红冲整张单据时和原分录一起取反 */
export function buildTransferConfirmEntries(input: DocInput): Entry[] {
  const def = DOC_TYPE_MAP.get(input.type);
  if (!def || def.bank !== 'transfer') throw new Error('只有转款单能确认入账');
  const out = transferEntries({ ...input, inTransit: true }, docTotal(def, input), true);
  if (out.reduce((s, x) => s + x.amount, 0) !== 0) throw new Error('借贷不平衡');
  return out;
}

export const negateEntries = (entries: Entry[]): Entry[] => entries.map((x) => ({ ...x, amount: x.amount === 0 ? 0 : -x.amount, qty: x.qty === null ? null : -x.qty }));
