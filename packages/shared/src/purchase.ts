/**
 * 采购流程（purchase-request）的纯函数与常量：明细、单价、金额、验收累计。前后端共用，不依赖流程引擎。
 * 单价以“分”为基数、最多 4 位小数（走 unit-price.ts 的定点运算），数量最多 4 位小数，数量乘单价之后才结算到分。
 */
import { scaledDecimal, settledLineCents, validUnitCents } from './unit-price';

export const PURCHASE_TEMPLATE = 'purchase-request';
/** 单价、金额这类成本信息，要有这个权限才看得到、填得了（服务端强制） */
export const PURCHASE_COST_PERMISSION = 'product.cost.view';
/** 默认的“大额审批”门槛：采购金额（分）达到它才走老板审批；管理员可以在流程设计器里改这一步的条件 */
export const PURCHASE_BIG_AMOUNT_CENTS = 1_000_000;

export const PURCHASE_PURPOSES = [
  { value: 'restock', label: '日常补货' },
  { value: 'new_product', label: '新品备货' },
  { value: 'campaign', label: '活动备货' },
  { value: 'packaging', label: '包装耗材' },
  { value: 'sample', label: '样品试用' },
  { value: 'other', label: '其他' },
] as const;

export const PAYMENT_MODES = [
  { value: 'prepay', label: '全款预付（下单时付清）' },
  { value: 'deposit', label: '预付定金（尾款到货后付）' },
  { value: 'credit', label: '货到付款 / 账期' },
] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number]['value'];

export const RECEIPT_RESULTS = [
  { value: 'ok', label: '全部合格' },
  { value: 'defect', label: '有不合格' },
  { value: 'shortage', label: '数量短少' },
] as const;

export const EXCEPTION_RESOLUTIONS = [
  { value: 'accept_as_is', label: '按合格数量入库，差额不再补' },
  { value: 'return_refund', label: '不合格品退回供应商，登记退款' },
  { value: 'cancel_remaining', label: '取消未到货部分，登记退款' },
] as const;
/** 需要走“退款到账确认”的处置方式 */
export const REFUND_RESOLUTIONS: readonly string[] = ['return_refund', 'cancel_remaining'];

const MAX_LINES = 100;
const MAX_QTY = 99_999_999;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const TICK = 10_000;

function qtyOf(v: unknown): number | null {
  if (typeof v === 'string' && v.trim() !== '' && !/^\d+(\.\d{1,4})?$/.test(v.trim())) return null;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > MAX_QTY) return null;
  try { scaledDecimal(n, 4); } catch { return null; }
  return n;
}
/** 数量按万分之一单位的整数累加，避免小数误差 */
const ticks = (q: number) => Number(scaledDecimal(q, 4));
const fromTicks = (t: number) => t / TICK;

export interface PurchaseLine { productId: number; qty: number; unit?: string; note?: string }

/** 整理申请明细：商品不能重复，数量大于 0 且最多 4 位小数，最多 100 行。返回规范化后的行和错误。 */
export function normalizeLines(raw: unknown): { lines: PurchaseLine[]; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(raw) || raw.length === 0) return { lines: [], errors: ['请至少添加一个采购商品'] };
  if (raw.length > MAX_LINES) return { lines: [], errors: [`一张采购申请最多 ${MAX_LINES} 个商品`] };
  const seen = new Set<number>();
  const lines: PurchaseLine[] = [];
  raw.forEach((r, i) => {
    const at = `第 ${i + 1} 行`;
    if (!isObj(r)) { errors.push(`${at}格式不对`); return; }
    const productId = Number(r.productId);
    if (!Number.isInteger(productId) || productId <= 0) { errors.push(`${at}没有选择商品`); return; }
    if (seen.has(productId)) { errors.push(`${at}的商品重复了，请合并数量`); return; }
    seen.add(productId);
    const qty = qtyOf(r.qty);
    if (qty === null || qty <= 0) { errors.push(`${at}的数量必须大于 0，最多 4 位小数`); return; }
    const unit = typeof r.unit === 'string' ? r.unit.trim().slice(0, 20) : '';
    const note = typeof r.note === 'string' ? r.note.trim().slice(0, 200) : '';
    lines.push({ productId, qty, ...(unit ? { unit } : {}), ...(note ? { note } : {}) });
  });
  return { lines, errors };
}

export interface PriceEntry { productId: number; unitPriceCents: number }

/** 整理单价清单：必须与申请明细的商品一一对应，单价大于 0、最多 4 位小数（分）。 */
/** partial：选填的预计单价——可以只填一部分商品，申请里已经没有的商品直接丢掉 */
export function normalizePrices(raw: unknown, lines: readonly PurchaseLine[], label = '单价', partial = false): { prices: PriceEntry[]; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(raw)) return { prices: [], errors: [`请填写每个商品的${label}`] };
  const byId = new Map<number, number>();
  for (const r of raw) {
    if (!isObj(r)) { errors.push(`${label}格式不对`); continue; }
    const productId = Number(r.productId);
    const cents = r.unitPriceCents;
    if (!lines.some((l) => l.productId === productId)) { if (!partial) errors.push(`${label}里有申请中没有的商品`); continue; }
    if (byId.has(productId)) { errors.push(`${label}里同一个商品出现了两次`); continue; }
    if (!validUnitCents(cents) || (cents as number) <= 0) { errors.push(`商品 #${productId} 的${label}必须大于 0，单位为分，最多 4 位小数`); continue; }
    byId.set(productId, cents as number);
  }
  if (!partial) for (const l of lines) if (!byId.has(l.productId) && !errors.length) errors.push(`商品 #${l.productId} 还没有填${label}`);
  return { prices: lines.filter((l) => byId.has(l.productId)).map((l) => ({ productId: l.productId, unitPriceCents: byId.get(l.productId)! })), errors };
}

export interface PricedItem { productId: number; qty: number; unitPriceCents: number; amountCents: number }
/** 数量 × 单价之后才结算到分；合计为各行分之和。 */
export function priceLines(lines: readonly PurchaseLine[], prices: readonly PriceEntry[]): { items: PricedItem[]; totalCents: number } {
  const items = lines.map((l) => {
    const p = prices.find((x) => x.productId === l.productId);
    if (!p) throw new Error('单价与明细不一致');
    return { productId: l.productId, qty: l.qty, unitPriceCents: p.unitPriceCents, amountCents: settledLineCents(p.unitPriceCents, l.qty) };
  });
  return { items, totalCents: items.reduce((s, i) => s + i.amountCents, 0) };
}

// ================= 到货验收 =================

export interface ReceiptEntry { productId: number; receivedQty: number; acceptedQty: number }
/** 累计验收状态：商品 → 累计收到、累计合格 */
export type ReceiptState = Record<string, { received: number; accepted: number }>;

/** allowNone：允许本次一件都没到（供应商一直没发货时登记情况，走异常处置收尾） */
export function normalizeReceipt(raw: unknown, ordered: readonly PurchaseLine[], allowNone = false): { entries: ReceiptEntry[]; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(raw) || raw.length === 0) return { entries: [], errors: ['请登记本次到货的商品数量'] };
  const seen = new Set<number>();
  const entries: ReceiptEntry[] = [];
  raw.forEach((r, i) => {
    const at = `第 ${i + 1} 行`;
    if (!isObj(r)) { errors.push(`${at}格式不对`); return; }
    const productId = Number(r.productId);
    if (!ordered.some((l) => l.productId === productId)) { errors.push(`${at}的商品不在这张采购申请里`); return; }
    if (seen.has(productId)) { errors.push(`${at}的商品重复了`); return; }
    seen.add(productId);
    const received = qtyOf(r.receivedQty), accepted = qtyOf(r.acceptedQty);
    if (received === null || accepted === null) { errors.push(`${at}的数量不合法（不能为负，最多 4 位小数）`); return; }
    if (accepted > received) { errors.push(`${at}的合格数量不能大于到货数量`); return; }
    entries.push({ productId, receivedQty: received, acceptedQty: accepted });
  });
  if (!errors.length && !allowNone && !entries.some((e) => e.receivedQty > 0)) errors.push('本次没有登记任何到货数量');
  return { entries, errors };
}

/** 把本次验收累加进累计状态：合格数量累计不能超过申请数量。result 由累计结果推出，不让办理人自己填。 */
export function applyReceipt(ordered: readonly PurchaseLine[], prev: ReceiptState | undefined, entries: readonly ReceiptEntry[]): { state: ReceiptState; result: 'ok' | 'defect' | 'shortage'; errors: string[] } {
  const errors: string[] = [];
  const state: ReceiptState = {};
  for (const l of ordered) {
    const p = prev?.[String(l.productId)];
    state[String(l.productId)] = { received: p?.received ?? 0, accepted: p?.accepted ?? 0 };
  }
  for (const e of entries) {
    const s = state[String(e.productId)];
    s.received = fromTicks(ticks(s.received) + ticks(e.receivedQty));
    s.accepted = fromTicks(ticks(s.accepted) + ticks(e.acceptedQty));
  }
  for (const l of ordered) {
    if (ticks(state[String(l.productId)].accepted) > ticks(l.qty)) errors.push(`商品 #${l.productId} 的合格数量累计超过了申请数量 ${l.qty}`);
  }
  const allOk = ordered.every((l) => ticks(state[String(l.productId)].accepted) === ticks(l.qty));
  const anyRejected = ordered.some((l) => ticks(state[String(l.productId)].received) > ticks(state[String(l.productId)].accepted));
  return { state, result: allOk ? 'ok' : anyRejected ? 'defect' : 'shortage', errors };
}

/** 合格入库的数量清单（只含合格数量大于 0 的商品） */
export function acceptedLines(ordered: readonly PurchaseLine[], state: ReceiptState | undefined): Array<{ productId: number; qty: number; unit?: string }> {
  return ordered.flatMap((l) => {
    const q = state?.[String(l.productId)]?.accepted ?? 0;
    return q > 0 ? [{ productId: l.productId, qty: q, ...(l.unit ? { unit: l.unit } : {}) }] : [];
  });
}

/** 上海时区的今天（YYYY-MM-DD） */
export const shanghaiToday = (now = new Date()): string => new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
