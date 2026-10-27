import { BadRequestException } from '@nestjs/common';
import * as crypto from 'crypto';
import { EntityManager, In } from 'typeorm';
import {
  ALLOCATION_LABEL, EXCEPTION_LABEL, FINANCE_RESOURCE_DEFS, FEE_TYPE_LABEL, PAYMENT_MODE_LABEL, allocateFees, approvalCents, currentBatch, emptyPurchaseState, lineCents, nextStepKey, perUnitCents,
  pkey, prepayUsage, q4, receivedQty, remainingQty, returnBlockedReason, shipmentOutstanding, toShipQty, validUnitCents, RETURN_TARGET, todayInChina,
  type AllocationMethod, type Batch, type ExceptionResolution, type FeeRecord, type FeeType, type PaymentMode, type PurchaseLine, type PurchaseState, type PurchaseStepKey, type QtyRow, type Shipment,
} from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { FinanceDocument, FlowRun, ResourceFile, ResourceRecord } from '../entities';
import type { FlowAdapter, StepContext } from './flow-adapters';

/**
 * 采购申请流程的业务规则（沿用旧系统 purchase-adapter）：
 * 业务痕迹全部存在 payload._purchase（引擎不会把以下划线开头的字段发给前端；价格、付款要经过 PurchaseService 的脱敏出口）。
 * 办理人和顺序在流程定义里；这里只声明：数量对不对、钱怎么记、下一步去哪、能不能退回。
 * 办理表单里的价格、账户等敏感内容办理后从步骤记录里抹掉，只留在 _purchase 里。
 */
export const PURCHASE_KEY = '_purchase';
export const EVIDENCE_TYPE = 'flow-purchase';
const PURCHASABLE = ['raw', 'purchased', 'shipping_material', 'package', 'oem_package'];

type Data = Record<string, unknown>;
function bad(m: string): never { throw new BadRequestException(m); }
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const isObj = (v: unknown): v is Data => typeof v === 'object' && v !== null && !Array.isArray(v);
const asEngine = (user: AuthUser): AuthUser => ({ ...user, permissions: { isCompanyAdmin: true, allow: [], deny: [] } });
const posInt = (v: unknown, label: string): number => { const n = num(v); if (n === null || !Number.isInteger(n) || n <= 0) bad(`${label}必须是大于 0 的整数`); return n as number; };
const centsOf = (v: unknown, label: string): number => { const n = num(v); if (n === null || !Number.isInteger(n) || n <= 0 || n > 99_999_999_999) bad(`${label}必须是大于 0 的金额（单位分，整数）`); return n as number; };
const qtyOf = (v: unknown, label: string, allowZero = false): number => {
  const n = num(v);
  if (n === null || n < 0 || (n === 0 && !allowZero) || n > 1e9 || q4(n) !== n) bad(`${label}必须大于 0，最多 4 位小数`);
  return n as number;
};
const text = (v: unknown, label: string, required = true, max = 500): string => {
  const s = str(v).trim();
  if ((required && !s) || s.length > max) bad(`${label}${required ? '必填且' : ''}不能超过 ${max} 字`);
  return s;
};
const compact = (s: string) => s.replace(/\s/g, '');

/** 只允许这些字段：多余字段拒绝（采购办理表单是一整块 JSON，必须自己守白名单） */
function only(data: unknown, keys: readonly string[], label: string): Data {
  if (!isObj(data)) return bad(`${label}格式不对`);
  const extra = Object.keys(data).filter((k) => !keys.includes(k));
  if (extra.length) bad(`${label}包含不能填写的字段：${extra.join('、')}`);
  return data;
}

export function stateOf(payload: Data): PurchaseState {
  if (!isObj(payload[PURCHASE_KEY])) payload[PURCHASE_KEY] = emptyPurchaseState();
  return payload[PURCHASE_KEY] as unknown as PurchaseState;
}
export const linesOf = (payload: Data): PurchaseLine[] => (Array.isArray(payload.lines) ? (payload.lines as PurchaseLine[]) : []);

/** 商品的采购计价单位：原料写“系统规格”，其他取规格单位的中文名 */
const unitOfProduct = (d: Data): string =>
  str(d.purchaseSpec).trim() || (FINANCE_RESOURCE_DEFS.find((x) => x.key === 'finance-products')!.fields.find((f) => f.key === 'specUnit')!.options!.find((o) => o.value === d.specUnit)?.label ?? '');

/** 发起、重新提交时检查并补全商品行：只收商品、数量、单位、成品名；名称、编码、重量以商品档案为准 */
export async function normalizeLines(em: EntityManager, companyId: number, input: unknown): Promise<PurchaseLine[]> {
  if (!Array.isArray(input) || !input.length || input.length > 100) return bad('请填写采购商品（1 到 100 行）');
  if (new Set(input.map((l) => (isObj(l) ? l.productId : null))).size !== input.length) bad('采购商品不能重复');
  const out: PurchaseLine[] = [];
  for (const raw of input) {
    const l = only(raw, ['productId', 'qty', 'unit', 'aliasName', 'name', 'code', 'weightG'], '采购商品');
    const id = posInt(l.productId, '商品');
    const p = await em.findOne(ResourceRecord, { where: { id, companyId, type: 'finance-products' } });
    if (!p || p.status !== 'active') return bad('采购商品不存在或已停用');
    const type = str(p.data.archiveType);
    if (!PURCHASABLE.includes(type)) bad(`「${p.title}」是自产成品，不能采购`);
    const names = type === 'raw' ? str(p.data.rawFinishedNames).split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : [];
    const alias = str(l.aliasName).trim();
    if (names.length && !names.includes(alias)) bad(`请为「${p.title}」选择原料档案里有效的成品名（马甲）`);
    if (!names.length && alias) bad(`「${p.title}」没有成品名，不能选择马甲`);
    const unit = unitOfProduct(p.data);
    if (!unit) bad(`「${p.title}」缺少采购计价单位，请先在商品档案维护系统规格`);
    if (l.unit !== undefined && str(l.unit) !== unit) bad(`「${p.title}」的采购单位已变化，请刷新资料并重新确认数量`);
    out.push({ productId: id, qty: qtyOf(l.qty, `「${p.title}」的采购数量`), unit, name: alias || str(p.data.name) || p.title, code: str(p.data.code) || p.title, ...(alias ? { aliasName: alias } : {}), weightG: num(p.data.weightG) ?? 0 });
  }
  return out;
}

const validDate = (v: unknown, label: string): string => {
  const s = str(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s) bad(`${label}无效，请选择日期`);
  return s;
};
const endOfDay = (d: string) => new Date(`${d}T23:59:59+08:00`);

/** 凭证文件：必须是本公司在采购流程里上传的、没被别的流程占用的文件；通过后绑定到这条流程 */
async function evidence(em: EntityManager, run: FlowRun, ids: unknown, label: string, required = true): Promise<number[]> {
  const list = Array.isArray(ids) ? ids : [];
  if (required && !list.length) bad(`请上传${label}`);
  const clean = [...new Set(list.map((x) => Number(x)))];
  if (clean.length > 12 || clean.some((n) => !Number.isInteger(n) || n <= 0)) bad(`${label}最多 12 份`);
  if (!clean.length) return [];
  const rows = await em.find(ResourceFile, { where: { companyId: run.companyId, id: In(clean) } });
  for (const id of clean) {
    const r = rows.find((x) => x.id === id);
    if (!r || r.resourceType !== EVIDENCE_TYPE || (r.resourceId !== null && r.resourceId !== run.id)) bad(`${label}里有无效的文件，请重新上传`);
  }
  await em.update(ResourceFile, { companyId: run.companyId, id: In(clean) }, { resourceId: run.id });
  return clean;
}

async function record(em: EntityManager, companyId: number, type: string, id: number, label: string): Promise<ResourceRecord> {
  const r = await em.findOne(ResourceRecord, { where: { id, companyId, type } });
  if (!r) return bad(`${label}不存在`);
  if (['inactive', 'cancelled', 'deleted', 'archived'].includes(r.status) || r.archivedAt) bad(`${label}「${r.title}」已停用`);
  return r;
}

/** 供应商预付款余额（分）：预付款科目里该供应商的合计 */
export async function supplierPrepayBalance(em: EntityManager, companyId: number, supplierId: number): Promise<number> {
  const [row] = await em.query("SELECT COALESCE(SUM(amount_cents), 0) AS a FROM finance_entries WHERE company_id = ? AND kind = 'prepayment' AND account_id = ?", [companyId, supplierId]);
  return Number(row.a);
}
/** 这个供应商的预付款里已经被在办的采购占用、还没用掉的合计（可排除某条流程自己） */
export async function earmarkedPrepay(em: EntityManager, companyId: number, supplierId: number, excludeRunId: number | null): Promise<number> {
  const runs = await em.find(FlowRun, { where: { companyId, templateKey: 'purchase-request', status: 'running' } });
  let sum = 0;
  for (const r of runs) {
    if (r.id === excludeRunId) continue;
    const s = r.payload[PURCHASE_KEY] as PurchaseState | undefined;
    if (s && s.supplierId === supplierId) sum += prepayUsage(s).unusedCents;
  }
  return sum;
}

const stepOf = (ctx: StepContext) => ctx.stepKey as PurchaseStepKey;
const batchOf = (s: PurchaseState): Batch => currentBatch(s) ?? bad('还没有发货批次');
/** 一行商品数量表：不重复、不超过上限、数量按 4 位小数；返回大于 0 的行 */
function qtyRows(input: unknown, label: string, limit: (productId: number) => number | null, name: (id: number) => string): QtyRow[] {
  if (!Array.isArray(input) || input.length > 100) bad(`${label}格式不对`);
  const seen = new Set<number>();
  const out: QtyRow[] = [];
  for (const raw of input as unknown[]) {
    const r = only(raw, ['productId', 'qty'], label);
    const id = posInt(r.productId, '商品');
    if (seen.has(id)) bad(`${label}里商品重复`);
    seen.add(id);
    const max = limit(id);
    if (max === null) bad('商品不属于本采购单');
    const q = qtyOf(r.qty, `${name(id)}的数量`, true);
    if (q > (max as number)) bad(`${name(id)}数量超过当前可办理数量 ${max}`);
    if (q > 0) out.push({ productId: id, qty: q });
  }
  return out;
}

/** 办理完把敏感内容从步骤记录里抹掉：步骤记录谁都能看，价格、账户、金额只留在 _purchase（经脱敏出口查看） */
const scrub = (form: Data, keep: Data = {}) => { form.data = { done: true, ...keep }; };

async function dataOf(ctx: StepContext, keys: readonly string[], label: string): Promise<Data> {
  return only(ctx.form.data ?? {}, keys, label);
}

export const purchase: FlowAdapter = {
  key: 'purchase-request',
  keepStateOnResubmit: true,

  async title(_em, _companyId, p) {
    const ls = linesOf(p);
    return `采购申请 · ${ls[0]?.name ?? ''}${ls.length > 1 ? ` 等 ${ls.length} 项` : ''}`.slice(0, 200);
  },

  async validateStart({ em, user, payload, run }) {
    const lines = await normalizeLines(em, user.companyId, payload.lines);
    const date = validDate(payload.requestedArrivalAt, '要求到货日期');
    if (date < todayInChina() && !(run && run.payload.requestedArrivalAt === date)) bad('要求到货日期不能早于今天');
    payload.lines = lines as unknown as never;
    if (!run) { payload[PURCHASE_KEY] = emptyPurchaseState() as unknown as never; return; }
    // 重新提交：付款后只有“申请变更”打开了变更才能改；改动不能让已入库的数量对不上
    const s = stateOf(run.payload);
    if (s.payments.length && !s.amendOpen) bad('付款后的采购内容变更需要发起变更审批（在采购申请中心点“申请变更采购内容”）');
    if (s.amendOpen) {
      const old = linesOf(run.payload);
      for (const o of old) {
        const next = lines.find((l) => l.productId === o.productId);
        if (receivedQty(s, o.productId) > (next?.qty ?? 0)) bad(`变更数量不能少于「${o.name}」已入库的数量 ${receivedQty(s, o.productId)}`);
        if (next && receivedQty(s, o.productId) > 0 && next.unit !== o.unit) bad(`「${o.name}」已入库，不能在同一采购中改换计价单位`);
        if (next && s.shipments.some((sh) => sh.lines.some((x) => x.productId === o.productId && x.qty > next.qty))) bad(`「${o.name}」已发货的数量大于新的采购数量`);
      }
    }
  },

  async onResubmit({ run }) {
    const s = stateOf(run.payload);
    const lines = linesOf(run.payload);
    for (const k of Object.keys(s.prices)) if (!lines.some((l) => pkey(l.productId) === k)) delete s.prices[k];
    s.planReady = false;
    s.approved = false;
    s.approvedCents = null;
  },

  stepDueAt(stepKey, payload) {
    if (stepKey !== 'arrival') return null;
    const b = currentBatch(stateOf(payload));
    return b?.expectedArrivalAt ? endOfDay(b.expectedArrivalAt) : null;
  },

  async onPass(ctx) {
    const { em, user, run, payload, form, docs, resources } = ctx;
    const s = stateOf(payload);
    const lines = linesOf(payload);
    const step = stepOf(ctx);
    const comment = str(form.comment).trim();
    const actor = asEngine(user);
    const name = (id: number) => lines.find((l) => l.productId === id)?.name ?? `商品 #${id}`;
    const today = todayInChina();

    if (step === 'plan') {
      if (s.approved && s.payments.length && !s.amendOpen) bad('已付款的采购不能直接修改方案，请先由申请人申请变更');
      const d = await dataOf(ctx, ['supplierId', 'warehouseId', 'paymentMode', 'payeeName', 'payeeAccount', 'prices', 'files'], '采购方案');
      const supplier = await record(em, run.companyId, 'finance-suppliers', posInt(d.supplierId, '供应商'), '供应商');
      const warehouse = await record(em, run.companyId, 'finance-warehouses', posInt(d.warehouseId, '收货仓库'), '收货仓库');
      const mode = str(d.paymentMode || 'new') as PaymentMode;
      if (!(mode in PAYMENT_MODE_LABEL)) bad('货款安排方式无效');
      const payeeName = text(d.payeeName || supplier.title, '货款收款人', true, 180);
      const payeeAccount = text(d.payeeAccount, '货款收款账户', mode !== 'existing', 180);
      if (s.payments.length && (supplier.id !== s.supplierId || warehouse.id !== s.warehouseId)) bad('付款后的变更必须保留原供应商和仓库；更换供应商请先终止退款后重新申请');
      if (!isObj(d.prices)) bad('请确认每个申请商品的采购单价');
      const prices: Record<string, number> = {};
      for (const l of lines) {
        const v = (d.prices as Data)[pkey(l.productId)];
        if (!validUnitCents(v) || !(v > 0)) bad(`请填写「${l.name}」的采购单价（大于 0，最多 6 位元小数）`);
        if (remainingQty(s, l) === 0 && receivedQty(s, l.productId) > 0 && s.prices[pkey(l.productId)] !== v) bad(`「${l.name}」已结算，不能改写历史单价`);
        prices[pkey(l.productId)] = v as number;
      }
      if (Object.keys(d.prices as Data).some((k) => !(k in prices))) bad('单价里包含不属于本采购的商品');
      const keep = s.prices;
      s.prices = prices;
      if (!((approvalCents(lines, s) ?? 0) > 0)) { s.prices = keep; bad('采购货款不能低于 1 分，请检查数量和单价'); }
      Object.assign(s, { supplierId: supplier.id, supplierName: supplier.title, warehouseId: warehouse.id, warehouseName: warehouse.title, paymentMode: mode, payeeName, payeeAccount, planReady: true, approved: false, approvedCents: null, planNote: comment });
      s.planFiles = await evidence(em, run, d.files, '方案附件', false);
      scrub(form);
      return;
    }

    if (step === 'approve') {
      if (!s.planReady) bad('请先完善供应商、报价和付款资料，再审核');
      s.approved = true;
      s.approvedCents = approvalCents(lines, s);
      s.approvalComment = comment;
      if (s.amendOpen) { s.amendOpen = false; s.paymentReopened = true; s.prepayReviewed = false; }
      return;
    }

    if (step === 'pay') {
      if (!s.approved) bad('采购尚未批准');
      if ((s.payments.length || s.prepayClaimCents) && !s.paymentReopened) bad('本采购货款已安排，请勿重复付款');
      const d = await dataOf(ctx, ['payments', 'claimCents'], '货款安排');
      const pays = Array.isArray(d.payments) ? d.payments : [];
      if (pays.length > 20) bad('一次最多登记 20 笔付款');
      const claim = d.claimCents === undefined || d.claimCents === null || d.claimCents === 0 ? 0 : centsOf(d.claimCents, '占用的已有预付款');
      if (!pays.length && !claim && !s.paymentReopened) bad('请填写新付款，或选择占用已有预付款');
      const before = prepayUsage(s);
      if (claim) {
        const free = (await supplierPrepayBalance(em, run.companyId, s.supplierId!)) - (await earmarkedPrepay(em, run.companyId, s.supplierId!, run.id)) - before.unusedCents;
        if (claim > free) bad(`该供应商可占用的预付款余额只有 ${(Math.max(0, free) / 100).toFixed(2)} 元（其余已被别的采购占用）`);
      }
      let added = 0;
      for (const [i, raw] of pays.entries()) {
        const p = only(raw, ['amountCents', 'bankAccountId', 'reference', 'files', 'payeeName', 'payeeAccount'], `第 ${i + 1} 笔付款`);
        const amountCents = centsOf(p.amountCents, `第 ${i + 1} 笔付款金额`);
        const bank = await record(em, run.companyId, 'bank-accounts', posInt(p.bankAccountId, '付款账户'), '付款账户');
        const reference = text(p.reference, '银行流水号', true, 120);
        const payeeName = text(p.payeeName, '收款人', true, 180);
        const payeeAccount = text(p.payeeAccount, '收款账户', true, 180);
        if (compact(payeeAccount) !== compact(s.payeeAccount ?? '') || payeeName !== s.payeeName) bad('实际收款人或账户与批准的方案不一致，请先退回方案重新审批');
        const files = await evidence(em, run, p.files, '付款凭证');
        const draft = await docs.createDraft(actor, { type: 'prepayment', date: today, partyId: s.supplierId, partyKind: 'supplier', bankAccountId: bank.id, amountCents, refNo: reference },
          { memo: `采购 #${run.id} 货款预付`, sourceKey: `flow:${run.id}:pay:${s.payments.length}` }, em);
        const posted = await docs.post(actor, draft.id, em);
        s.payments.push({ docId: posted.id, docNo: posted.docNo, amountCents, bankAccountId: bank.id, reference, files, payeeName, payeeAccount });
        added += amountCents;
      }
      s.prepayClaimCents += claim;
      const reserved = prepayUsage(s).reservedCents;
      if (reserved > Math.max(s.approvedCents ?? 0, before.reservedCents)) bad(`货款安排金额 ${(reserved / 100).toFixed(2)} 元超过批准金额 ${((s.approvedCents ?? 0) / 100).toFixed(2)} 元`);
      if (!reserved) bad('货款安排金额必须大于 0');
      void added;
      s.paymentReopened = false;
      s.prepayReviewed = false;
      scrub(form);
      return;
    }

    if (step === 'prepay_review') {
      if (!s.payments.length && !s.prepayClaimCents) bad('尚未安排货款');
      s.prepayReviewed = true;
      return;
    }

    if (step === 'dispatch') {
      if (!s.prepayReviewed) bad('财务尚未确认预付款使用');
      const d = await dataOf(ctx, ['shipmentId', 'lines', 'logisticsNo', 'expectedArrivalAt', 'files'], '发货登记');
      let shipment: Shipment | undefined;
      if (d.shipmentId !== undefined && d.shipmentId !== null && d.shipmentId !== '') {
        shipment = s.shipments.find((x) => x.id === d.shipmentId) ?? bad('已发货批次不存在');
      }
      const limit = (id: number) => {
        const l = lines.find((x) => x.productId === id);
        if (!l) return null;
        return shipment ? shipmentOutstanding(s, shipment, id) : toShipQty(s, l);
      };
      const rows = qtyRows(d.lines, '本批发货数量', limit, name);
      if (!rows.length) bad('本次待到货数量必须大于零');
      const arrival = validDate(d.expectedArrivalAt, '预计到货日期');
      const requested = str(payload.requestedArrivalAt);
      if (requested && arrival > requested && !comment) bad('预计到货晚于要求日期，请填写原因');
      if (!shipment) {
        shipment = { id: crypto.randomUUID(), lines: rows, logisticsNo: text(d.logisticsNo, '物流单号', true, 120), expectedArrivalAt: arrival, files: await evidence(em, run, d.files, '发货凭证'), closedMissing: {}, returned: {} };
        s.shipments.push(shipment);
      } else if (d.files !== undefined && Array.isArray(d.files) && d.files.length) {
        shipment.files = [...new Set([...shipment.files, ...(await evidence(em, run, d.files, '发货凭证'))])];
      }
      s.batches.push({ id: crypto.randomUUID(), shipmentId: shipment.id, shipment: rows, logisticsNo: shipment.logisticsNo, expectedArrivalAt: arrival, dispatchFiles: shipment.files, fees: [] });
      return;
    }

    if (step === 'arrival') {
      const b = currentBatch(s);
      if (!b || b.posted) bad('没有待收货批次');
      const d = await dataOf(ctx, ['files'], '到货凭证');
      b!.arrivalFiles = await evidence(em, run, d.files, '到货凭证');
      b!.arrived = true;
      return;
    }

    if (step === 'receive') {
      const b = batchOf(s);
      if (!b.arrived || b.posted) bad('请先登记当前批次到货');
      const d = await dataOf(ctx, ['lines', 'receiptComplete', 'files'], '收货核对');
      const rows = qtyRows(d.lines, '实收数量', (id) => b.shipment.find((x) => x.productId === id)?.qty ?? null, name);
      if (d.receiptComplete !== undefined && typeof d.receiptComplete !== 'boolean') bad('是否结束到货的设置无效');
      if (!rows.length && !d.receiptComplete) bad('实收数量为零时，请明确本次到货结束并说明差异');
      const diff = b.shipment.some((x) => (rows.find((r) => r.productId === x.productId)?.qty ?? 0) !== x.qty);
      if (diff && !comment) bad('收货数量有差异，请填写原因');
      b.deliveryShortage = d.receiptComplete ? b.shipment.map((x) => ({ productId: x.productId, qty: q4(x.qty - (rows.find((r) => r.productId === x.productId)?.qty ?? 0)) })).filter((x) => x.qty > 0) : [];
      b.received = rows;
      b.receiptFiles = await evidence(em, run, d.files, '收货凭证');
      b.difference = comment;
      if (!rows.length) { b.accepted = []; b.pendingException = true; }
      return;
    }

    if (step === 'quality') {
      const b = batchOf(s);
      if (!b.received || b.posted) bad('当前批次尚未收货或已结算');
      const d = await dataOf(ctx, ['lines', 'files'], '质检结果');
      const rows = qtyRows(d.lines, '合格数量', (id) => b.received!.find((x) => x.productId === id)?.qty ?? null, name);
      const hasBad = b.received.some((x) => (rows.find((r) => r.productId === x.productId)?.qty ?? 0) !== x.qty);
      b.qualityFiles = await evidence(em, run, d.files, '质检凭证');
      if (hasBad && !comment) bad('有不合格数量，请填写不合格说明');
      b.qualityComment = comment;
      b.accepted = rows.map((r) => ({ ...r, unitPriceCents: s.prices[pkey(r.productId)] }));
      b.pendingException = (hasBad && b.resolution !== 'accept_discount') || (!!b.deliveryShortage?.length && !b.deliveryShortageResolved);
      if (!rows.length && !b.pendingException) bad('本批无可入库数量，请填写不合格说明并走换货处理');
      return;
    }

    if (step === 'exception') {
      const b = currentBatch(s);
      if (!b?.pendingException && !s.cancelRequested) bad('没有待处理的采购异常');
      const d = await dataOf(ctx, ['resolution', 'files'], '异常处置');
      const resolution = str(d.resolution) as ExceptionResolution;
      if (!(resolution in EXCEPTION_LABEL)) bad('异常处置方式无效');
      if (!comment) bad('请填写处理原因');
      const files = await evidence(em, run, d.files, '处理凭证');
      if (resolution === 'cancel_remaining') {
        s.cancelApprovalComment = comment;
        s.cancelFiles = files;
        s.cancelApproved = true;
        if (b && !b.posted) { b.pendingException = false; b.returnedToSupplier = true; }
        return;
      }
      if (s.cancelRequested) bad('这是终止申请，请明确选择“终止未到货部分并退款”');
      const batch = b!;
      if (!batch.received?.length && resolution === 'reinspect') bad('本批没有实际收货，请选择补发或终止');
      if (batch.deliveryShortage?.length && !batch.deliveryShortageResolved && resolution === 'accept_discount') bad('未到货短缺需要补发或终止，不能通过折价增加实收数量');
      batch.resolution = resolution;
      batch.resolutionComment = comment;
      batch.resolutionFiles = files;
      batch.pendingException = false;
      if (resolution === 'accept_discount') batch.discountApproval = true;
      if (resolution === 'replace') {
        const shipment = s.shipments.find((x) => x.id === batch.shipmentId) ?? bad('质检批次缺少原发货记录');
        batch.originalReceived ??= JSON.parse(JSON.stringify(batch.received ?? []));
        const accepted = batch.accepted ?? [];
        const returned = (batch.received ?? []).map((x) => ({ productId: x.productId, qty: q4(x.qty - (accepted.find((a) => a.productId === x.productId)?.qty ?? 0)) })).filter((x) => x.qty > 0);
        batch.returnedLines = [...(batch.returnedLines ?? []), ...returned];
        for (const l of returned) shipment.returned[pkey(l.productId)] = q4((shipment.returned[pkey(l.productId)] ?? 0) + l.qty);
        if (batch.deliveryShortage?.length && !batch.deliveryShortageResolved) {
          for (const l of batch.deliveryShortage) shipment.closedMissing[pkey(l.productId)] = q4((shipment.closedMissing[pkey(l.productId)] ?? 0) + l.qty);
          batch.deliveryShortageResolved = true;
        }
        batch.received = accepted.map((a) => ({ productId: a.productId, qty: a.qty }));
        if (!accepted.length) batch.retryShipment = true;
      }
      if (resolution === 'reinspect') delete batch.resolution;
      return;
    }

    if (step === 'refund') {
      if (!s.cancelApproved) bad('终止退款尚未审批');
      const d = await dataOf(ctx, ['refunds'], '退款确认');
      const usage = prepayUsage(s);
      const due = usage.perDoc.filter((x) => x.unusedCents > 0);
      const given = Array.isArray(d.refunds) ? d.refunds : [];
      if (given.length !== due.length || new Set(given.map((x) => (isObj(x) ? x.docId : null))).size !== given.length) bad('请逐笔确认未使用预付款的退款');
      for (const raw of given) {
        const r = only(raw, ['docId', 'reference', 'files'], '退款确认');
        const doc = due.find((x) => x.docId === r.docId) ?? bad('退款确认里有不属于本采购的付款');
        const reference = text(r.reference, '退款银行流水号', true, 120);
        const files = await evidence(em, run, r.files, '退款凭证');
        const original = await em.findOne(FinanceDocument, { where: { id: doc!.docId, companyId: run.companyId } });
        if (!original || original.status !== 'posted') bad(`预付款单 ${doc!.docNo} 状态已变化，请到财务单据里核对`);
        // 没用掉的部分退回原付款账户：整笔没用就红冲整笔；用掉一部分，先补一张已使用部分的预付款，再红冲原单
        if (doc!.unusedCents < doc!.amountCents) {
          const keep = await docs.createDraft(actor, { type: 'prepayment', date: today, partyId: s.supplierId, partyKind: 'supplier', bankAccountId: original!.bankAccountId, amountCents: doc!.amountCents - doc!.unusedCents },
            { memo: `采购 #${run.id} 终止未到货部分：保留已使用的 ${(doc!.amountCents - doc!.unusedCents) / 100} 元（原单 ${doc!.docNo}）`, sourceKey: `flow:${run.id}:refund:${doc!.docId}:keep` }, em);
          await docs.post(actor, keep.id, em);
        }
        const rev = await docs.reverse(actor, doc!.docId, `采购 #${run.id} 终止未到货部分，未使用预付款退回（流水 ${reference}）`, em);
        s.refunds.push({ docId: rev.id, docNo: rev.docNo, sourceDocId: doc!.docId, amountCents: doc!.unusedCents, reference, files });
      }
      s.releasedCents += usage.unusedCents;
      s.cancelledQty = Object.fromEntries(lines.map((l) => [pkey(l.productId), remainingQty(s, l) + (s.cancelledQty[pkey(l.productId)] ?? 0)]));
      s.cancelApproved = false;
      s.cancelRequested = false;
      s.cancelledRemaining = true;
      scrub(form);
      return;
    }

    if (step === 'expense') {
      const b = batchOf(s);
      if (!b.accepted?.length || b.pendingException || b.posted) bad('质检尚未完成或本批已结算');
      const d = await dataOf(ctx, ['fees', 'zeroReason'], '费用申报');
      const fees = Array.isArray(d.fees) ? d.fees : [];
      if (fees.length > 40) bad('费用明细最多 40 条');
      if (!fees.length) b.zeroReason = text(d.zeroReason, '无需费用的原因');
      else delete b.zeroReason;
      const out: FeeRecord[] = [];
      for (const [i, raw] of fees.entries()) {
        const f = only(raw, ['type', 'amountCents', 'payeeName', 'payeeAccount', 'files'], `第 ${i + 1} 条费用`);
        if (!(str(f.type) in FEE_TYPE_LABEL)) bad('费用类型无效');
        out.push({ id: `${b.id}:${i}`, type: str(f.type) as FeeType, amountCents: centsOf(f.amountCents, '费用金额'), payeeName: text(f.payeeName, '费用收款人', true, 180), payeeAccount: text(f.payeeAccount, '费用收款账户', true, 180), files: await evidence(em, run, f.files, '费用凭证'), paid: false });
      }
      b.fees = out;
      b.feesDeclared = true;
      if (str(d.zeroReason).trim() && fees.length) b.zeroReason = text(d.zeroReason, '无需费用的原因', false);
      scrub(form);
      return;
    }

    if (step === 'settle') {
      const b = batchOf(s);
      if (!b.accepted?.length || b.pendingException || b.posted || !b.feesDeclared) bad('本批数量、质检或费用尚未完成');
      const d = await dataOf(ctx, ['allocationMethod', 'offsetCents', 'lines'], '结算');
      const method = str(d.allocationMethod) as AllocationMethod;
      if (!(method in ALLOCATION_LABEL)) bad('请选择费用分摊方式');
      b.allocationMethod = method;
      let accepted = b.accepted;
      if (b.discountApproval) {
        const given = Array.isArray(d.lines) ? d.lines : [];
        if (given.length !== accepted.length) bad('折价接收需要逐项确认结算单价');
        accepted = accepted.map((a) => {
          const g = only(given.find((x) => isObj(x) && x.productId === a.productId) ?? bad('折价接收需要逐项确认结算单价'), ['productId', 'unitPriceCents'], '折价单价');
          const price = num(g.unitPriceCents);
          if (price === null || !validUnitCents(price) || price < 0 || price > a.unitPriceCents) bad('折价结算单价不能为负，也不能超过原批准单价');
          return { ...a, unitPriceCents: price as number };
        });
        b.accepted = accepted;
      } else if (Array.isArray(d.lines) && d.lines.length) bad('普通到货结算不允许改写批准单价');
      const weights = accepted.map((a) => ({ productId: a.productId, qty: a.qty, unitPriceCents: a.unitPriceCents, weightG: lines.find((l) => l.productId === a.productId)?.weightG ?? 0 }));
      const split = b.fees.length ? allocateFees(weights, b.fees, method) : weights.map(() => ({ freightCents: 0, handlingCents: 0 }));
      if (!split) return bad('费用分摊依据缺失，请检查重量、数量或货值');
      const goodsCents = accepted.reduce((sum, a) => sum + lineCents(a.qty, a.unitPriceCents), 0);
      const offset = d.offsetCents === undefined || d.offsetCents === null || d.offsetCents === 0 ? 0 : centsOf(d.offsetCents, '预付款冲抵');
      const usage = prepayUsage(s);
      if (offset > goodsCents) bad('预付款冲抵不能超过本批货款');
      if (offset > usage.unusedCents) bad(`本采购可冲抵的预付款只剩 ${(usage.unusedCents / 100).toFixed(2)} 元`);
      const draft = await docs.createDraft(actor, {
        type: 'purchase-in', date: today, partyId: s.supplierId, partyKind: 'supplier', warehouseId: s.warehouseId, offsetCents: offset,
        lines: accepted.map((a) => ({ productId: a.productId, qty: a.qty, unitPriceCents: a.unitPriceCents, unit: lines.find((l) => l.productId === a.productId)?.unit, memo: `采购 #${run.id} 批次 ${s.batches.indexOf(b) + 1}` })),
      }, { memo: `采购 #${run.id} 批次 ${s.batches.indexOf(b) + 1}${comment ? `；${comment}` : ''}`, sourceKey: `flow:${run.id}:inbound:${s.batches.indexOf(b)}` }, em);
      const posted = await docs.post(actor, draft.id, em);
      b.docId = posted.id;
      b.docNo = posted.docNo;
      b.posted = true;
      b.goodsCents = goodsCents;
      b.offsetCents = offset;
      // 发布成本：采购价取结算单价，运费、装卸费按分摊后的单位金额；0 要写明原因
      const reason = b.zeroReason || '本批采购未发生该费用';
      b.costPublication = [];
      for (const [i, a] of accepted.entries()) {
        const freight = perUnitCents(split[i].freightCents, a.qty);
        const handling = perUnitCents(split[i].handlingCents, a.qty);
        const p = await em.findOne(ResourceRecord, { where: { id: a.productId, companyId: run.companyId, type: 'finance-products' } });
        if (!p) bad('采购商品已不存在');
        const keepLines = str(p!.data.zeroValueReason).split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !x.startsWith('运费：') && !x.startsWith('装卸费：'));
        if (freight === 0) keepLines.push(`运费：${reason}`);
        if (handling === 0) keepLines.push(`装卸费：${reason}`);
        await resources.updateRecord(em, actor, 'finance-products', a.productId, { purchasePrice: a.unitPriceCents, freight, handlingFee: handling, zeroValueReason: keepLines.join('\n') }, `采购 #${run.id} 结算更新成本`);
        b.costPublication.push({ productId: a.productId, purchasePriceCents: a.unitPriceCents, freightCents: freight, handlingCents: handling });
      }
      scrub(form);
      return;
    }

    if (step === 'expense_pay') {
      const b = batchOf(s);
      if (!b.posted) bad('本批入库尚未过账');
      const d = await dataOf(ctx, ['payments'], '费用付款');
      const given = Array.isArray(d.payments) ? d.payments : [];
      const unpaid = b.fees.filter((f) => !f.paid);
      const claimed = new Set<string>();
      const items = await em.find(ResourceRecord, { where: { companyId: run.companyId, type: 'finance-fee-items' } });
      const itemOf = (t: FeeType) => items.find((x) => x.status === 'active' && x.data.direction === 'expense' && x.title === FEE_TYPE_LABEL[t]);
      for (const [n, raw] of given.entries()) {
        const p = only(raw, ['feeIds', 'bankAccountId', 'reference', 'files'], `第 ${n + 1} 笔付款`);
        const ids = Array.isArray(p.feeIds) ? (p.feeIds as unknown[]).map(String) : [];
        if (!ids.length) bad('每笔付款要选择对应的费用');
        const fees = ids.map((id) => unpaid.find((f) => f.id === id) ?? bad('付款对应的费用不存在或已付款'));
        if (new Set(ids).size !== ids.length || ids.some((id) => claimed.has(id))) bad('同一笔费用不能重复付款');
        if (new Set(fees.map((f) => `${f.payeeName}|${compact(f.payeeAccount)}`)).size !== 1) bad('同一笔付款只能付给同一个收款人和账户');
        ids.forEach((id) => claimed.add(id));
        const bank = await record(em, run.companyId, 'bank-accounts', posInt(p.bankAccountId, '付款账户'), '付款账户');
        const reference = text(p.reference, '支付流水号', true, 120);
        const files = await evidence(em, run, p.files, '支付凭证');
        for (const f of fees) if (!itemOf(f.type)) bad(`请先在“费用项目”里建立支出项目「${FEE_TYPE_LABEL[f.type]}」，再登记费用付款`);
        const draft = await docs.createDraft(actor, {
          type: 'expense', date: today, bankAccountId: bank.id, refNo: reference,
          lines: fees.map((f) => ({ feeItemId: itemOf(f.type)!.id, qty: 1, unitPriceCents: f.amountCents, memo: `采购 #${run.id} ${FEE_TYPE_LABEL[f.type]}，收款人 ${f.payeeName}` })),
        }, { memo: `采购 #${run.id} 费用付款（入库时已归集到商品成本）`, sourceKey: `flow:${run.id}:expense:${s.batches.indexOf(b)}:${n}` }, em);
        const posted = await docs.post(actor, draft.id, em);
        for (const f of fees) { f.paid = true; f.paymentDocId = posted.id; f.paymentDocNo = posted.docNo; f.paymentFiles = files; }
      }
      if (unpaid.some((f) => !f.paid)) bad('还有费用没有登记付款，请逐笔登记');
      scrub(form);
      return;
    }
  },

  nextStep(ctx) {
    return nextStepKey(stepOf(ctx), linesOf(ctx.payload), stateOf(ctx.payload));
  },

  returnTarget(ctx) {
    return RETURN_TARGET[stepOf(ctx)];
  },

  returnBlocked(ctx) {
    return returnBlockedReason(stepOf(ctx), stateOf(ctx.payload));
  },

  cancelBlocked(ctx) {
    const s = stateOf(ctx.payload);
    return s.payments.length || s.prepayClaimCents || s.batches.length ? '已付款或已发货的采购不能直接废除；请由申请人发起“申请终止并退款”' : null;
  },
};
