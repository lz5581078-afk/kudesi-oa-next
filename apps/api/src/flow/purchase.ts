import { BadRequestException } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import {
  PURCHASE_TEMPLATE, PAYMENT_MODES, acceptedLines, applyReceipt, normalizeLines, normalizePrices, normalizeReceipt, priceLines, shanghaiToday,
  type PriceEntry, type PurchaseLine, type ReceiptState,
} from '@kudesi/shared';
import { ResourceFile, ResourceRecord } from '../entities';
import type { AuthUser } from '../common/auth.decorators';
import type { FlowAdapter, StartContext, StepContext } from './flow-adapters';

/**
 * 采购申请（purchase-request）的业务适配器：只管业务规则和校验——商品/供应商/账户同公司、单价精度、金额上限、验收数量累计、
 * 入库单草稿的前置条件；谁来办、按什么顺序走，全在流程定义里（管理员可改）。
 * 业务状态存在发起表单里以下划线开头的痕迹中（详情接口不会返回）：_planTotalCents（已批准采购金额）、_prices、_supplierId、
 * _paidCents、_payRefs、_promisedArrival、_recv（累计验收）、_inboundDocId 等。
 */
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const MAX_TOTAL_CENTS = 10_000_000_000; // 一亿元，防手误
const INACTIVE = ['inactive', 'stopped', 'deleted', 'cancelled'];
const endOfDay = (d: string) => new Date(`${d}T23:59:59+08:00`);
const FILE_TYPE = `flow:${PURCHASE_TEMPLATE}`;

export const linesOf = (payload: Record<string, unknown>): PurchaseLine[] => (Array.isArray(payload.lines) ? (payload.lines as PurchaseLine[]) : []);
export const pricesOf = (payload: Record<string, unknown>): PriceEntry[] => (Array.isArray(payload._prices) ? (payload._prices as PriceEntry[]) : []);
export const receiptOf = (payload: Record<string, unknown>): ReceiptState | undefined => (payload._recv && typeof payload._recv === 'object' ? (payload._recv as ReceiptState) : undefined);

async function must(em: EntityManager, companyId: number, type: string, id: unknown, label: string): Promise<ResourceRecord> {
  const n = num(id);
  const r = n === null ? null : await em.findOne(ResourceRecord, { where: { companyId, type, id: n } });
  if (!r) throw new BadRequestException(`${label}不存在`);
  if (INACTIVE.includes(r.status)) throw new BadRequestException(`${label}「${r.title}」已停用`);
  return r;
}

/** 附件：必须是本公司在本流程这个字段上传的；没绑定的只能是自己传的，已绑定的只能属于这条流程。通过后绑定到流程上。 */
async function bindFiles(em: EntityManager, user: AuthUser, runId: number, fieldKey: string, ids: unknown) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  const list = ids.filter((x): x is number => typeof x === 'number');
  const rows = await em.find(ResourceFile, { where: { companyId: user.companyId, id: In(list) } });
  for (const id of list) {
    const r = rows.find((x) => x.id === id);
    const mine = r && r.resourceId === null && r.uploadedBy === user.id;
    if (!r || r.resourceType !== FILE_TYPE || r.fieldKey !== fieldKey || !(mine || r.resourceId === runId)) throw new BadRequestException('包含无效的附件，请重新上传');
  }
  await em.update(ResourceFile, { companyId: user.companyId, id: In(list) }, { resourceId: runId });
}

/** 银行流水号全公司（采购流程内）不能重复登记 */
async function assertRefFree(em: EntityManager, ctx: StepContext, field: 'payRef' | 'refundRef', ref: string) {
  if (!ref) return;
  const own = Array.isArray(ctx.payload[field === 'payRef' ? '_payRefs' : '_refundRefs']) ? (ctx.payload[field === 'payRef' ? '_payRefs' : '_refundRefs'] as string[]) : [];
  const steps = field === 'payRef' ? "('order','final_pay')" : "('refund_confirm')";
  const rows = await em.query(
    `SELECT s.run_id AS runId FROM flow_steps s JOIN flow_runs r ON r.id = s.run_id
      WHERE r.company_id = ? AND r.template_key = ? AND s.status = 'done' AND s.step_key IN ${steps} AND s.run_id <> ?
        AND JSON_UNQUOTE(JSON_EXTRACT(s.form, ?)) = ? LIMIT 1`,
    [ctx.run.companyId, PURCHASE_TEMPLATE, ctx.run.id, `$.${field}`, ref]);
  if (rows.length || own.includes(ref)) throw new BadRequestException(`流水号 ${ref} 已经在采购流程里登记过${rows.length ? `（流程 #${rows[0].runId}）` : ''}，不能重复登记`);
}

const approvedTotal = (p: Record<string, unknown>) => num(p._planTotalCents) ?? 0;

export const purchaseRequest: FlowAdapter = {
  key: PURCHASE_TEMPLATE,

  async title(em, companyId, payload) {
    const lines = linesOf(payload);
    const first = lines[0] ? await em.findOne(ResourceRecord, { where: { companyId, type: 'finance-products', id: lines[0].productId }, select: ['id', 'title'] }) : null;
    return `采购申请 · ${first?.title ?? ''}${lines.length > 1 ? ` 等 ${lines.length} 项` : ''}`.slice(0, 200);
  },

  async validateStart(ctx: StartContext) {
    const { em, user, payload } = ctx;
    const { lines, errors } = normalizeLines(payload.lines);
    if (errors.length) throw new BadRequestException(errors.join('；'));
    const products = await em.find(ResourceRecord, { where: { companyId: user.companyId, type: 'finance-products', id: In(lines.map((l) => l.productId)) } });
    for (const l of lines) {
      const p = products.find((x) => x.id === l.productId);
      if (!p) throw new BadRequestException(`商品 #${l.productId} 不存在`);
      if (p.status !== 'active') throw new BadRequestException(`商品「${p.title}」已停用，不能采购`);
      if (p.data.archiveType === 'self_made') throw new BadRequestException(`商品「${p.title}」是自制品，不是采购品`);
    }
    payload.lines = lines;
    if (str(payload.expectedArrivalDate) < shanghaiToday()) throw new BadRequestException('期望到货日不能早于今天');
    if (payload.storeId !== undefined) await must(em, user.companyId, 'stores', payload.storeId, '关联店铺');
    if (payload.suggestedSupplierId !== undefined) await must(em, user.companyId, 'finance-suppliers', payload.suggestedSupplierId, '建议供应商');
    if (payload.estimates !== undefined) {
      const r = normalizePrices(payload.estimates, lines, '预计单价', true);
      if (r.errors.length) throw new BadRequestException(r.errors.join('；'));
      payload.estimates = r.prices;
    }
  },
  async onStart({ em, user, run, payload }) { await bindFiles(em, user, run.id, 'attachments', payload.attachments); },
  async onResubmit({ em, user, run, payload }) { await bindFiles(em, user, run.id, 'attachments', payload.attachments); },

  /** 到货验收按供应商承诺到货日（没有就按期望到货日）督促：截止是那天的 23:59 */
  stepDueAt(stepKey, payload) {
    if (stepKey !== 'receive') return null;
    const d = str(payload._promisedArrival) || str(payload.expectedArrivalDate);
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? endOfDay(d) : null;
  },

  async beforePass(ctx: StepContext) {
    const { em, user, payload, form, stepKey } = ctx;
    const lines = linesOf(payload);
    if (stepKey === 'plan') {
      await must(em, user.companyId, 'finance-suppliers', form.supplierId, '供应商');
      if (form.prices === undefined) throw new BadRequestException('没有填写商品单价；填写单价需要“成本查看”权限，请联系管理员');
      const r = normalizePrices(form.prices, lines);
      if (r.errors.length) throw new BadRequestException(r.errors.join('；'));
      const total = priceLines(lines, r.prices).totalCents;
      if (total <= 0 || total > MAX_TOTAL_CENTS) throw new BadRequestException('采购金额不合理，请检查数量和单价');
      return;
    }
    if (stepKey === 'order') {
      if (str(form.promisedArrivalDate) < str(form.orderedAt)) throw new BadRequestException('供应商承诺到货日不能早于下单日期');
      const mode = str(form.paymentMode);
      if (!PAYMENT_MODES.some((m) => m.value === mode)) throw new BadRequestException('请选择付款方式');
      const total = approvedTotal(payload);
      if (mode === 'credit') return;
      const paid = num(form.paidCents);
      if (paid === null) throw new BadRequestException('请登记本次付款金额；登记付款需要“成本查看”权限');
      if (!Number.isInteger(paid) || paid <= 0) throw new BadRequestException('付款金额必须是大于 0 的整数分');
      if (paid > total) throw new BadRequestException('付款金额不能超过已批准的采购金额');
      if (mode === 'prepay' && paid !== total) throw new BadRequestException('全款预付的付款金额必须等于采购金额；只付一部分请选“预付定金”');
      if (mode === 'deposit' && paid >= total) throw new BadRequestException('预付定金必须小于采购金额；付清请选“全款预付”');
      if (!form.paidAt) throw new BadRequestException('请填写付款日期');
      if (!str(form.payRef).trim()) throw new BadRequestException('请填写银行流水号或付款凭证号');
      await must(em, user.companyId, 'bank-accounts', form.bankAccountId, '付款账户');
      await assertRefFree(em, ctx, 'payRef', str(form.payRef).trim());
      return;
    }
    if (stepKey === 'receive') {
      if (num(payload._planTotalCents) === null) throw new BadRequestException('这张单还没有确定采购方案，不能验收');
      const r = normalizeReceipt(form.lines, lines, true);
      if (r.errors.length) throw new BadRequestException(r.errors.join('；'));
      if (!r.entries.some((e) => e.receivedQty > 0) && !str(form.note).trim()) throw new BadRequestException('本次一件都没到，请在验收说明里写明情况（例如供应商一直没发货）');
      const acc = applyReceipt(lines, receiptOf(payload), r.entries);
      if (acc.errors.length) throw new BadRequestException(acc.errors.join('；'));
      if (acc.result !== 'ok' && !str(form.note).trim()) throw new BadRequestException('有不合格或短少，请在验收说明里写明情况');
      return;
    }
    if (stepKey === 'exception') {
      const rec = receiptOf(payload);
      const resolution = str(form.resolution);
      const anyRejected = lines.some((l) => (rec?.[String(l.productId)]?.received ?? 0) > (rec?.[String(l.productId)]?.accepted ?? 0));
      const anyShort = lines.some((l) => (rec?.[String(l.productId)]?.accepted ?? 0) < l.qty);
      if (resolution === 'return_refund' && !anyRejected) throw new BadRequestException('没有不合格品，不能选“退回供应商”');
      if (resolution === 'cancel_remaining' && !anyShort) throw new BadRequestException('合格数量已经到齐，没有未到货部分可取消');
      return;
    }
    if (stepKey === 'refund_confirm') {
      const refunded = num(form.refundedCents);
      if (refunded === null || !Number.isInteger(refunded) || refunded < 0) throw new BadRequestException('请登记实际退款金额（没有退回填 0）；需要“成本查看”权限');
      if (refunded === 0 && !str(form.note).trim()) throw new BadRequestException('退款金额为 0，请在说明里写明原因');
      if (refunded > (num(payload._paidCents) ?? 0)) throw new BadRequestException('退款金额不能超过已登记的付款金额');
      if (form.bankAccountId !== undefined) await must(em, user.companyId, 'bank-accounts', form.bankAccountId, '收款账户');
      await assertRefFree(em, ctx, 'refundRef', str(form.refundRef).trim());
      return;
    }
    if (stepKey === 'inbound') {
      const acceptedAny = acceptedLines(lines, receiptOf(payload)).length > 0;
      if (acceptedAny && num(payload._inboundDocId) === null && !str(form.noDraftReason).trim()) {
        throw new BadRequestException('有合格数量要入库：请先点“生成采购入库单草稿”，或在“不生成入库单草稿的原因”里写明原因');
      }
      return;
    }
    if (stepKey === 'final_pay') {
      const paid = num(form.paidCents);
      if (paid === null || !Number.isInteger(paid) || paid <= 0) throw new BadRequestException('请登记本次付款金额（大于 0 的整数分）；需要“成本查看”权限');
      if (paid + (num(payload._paidCents) ?? 0) > approvedTotal(payload)) throw new BadRequestException('累计付款不能超过已批准的采购金额');
      await must(em, user.companyId, 'bank-accounts', form.bankAccountId, '付款账户');
      if (!str(form.payRef).trim()) throw new BadRequestException('请填写银行流水号或付款凭证号');
      await assertRefFree(em, ctx, 'payRef', str(form.payRef).trim());
    }
  },

  async onPass(ctx: StepContext) {
    const { em, user, run, payload, form, stepKey } = ctx;
    const lines = linesOf(payload);
    if (stepKey === 'plan') {
      const prices = normalizePrices(form.prices, lines).prices;
      const total = priceLines(lines, prices).totalCents;
      form.prices = prices;
      form.amountCents = total; // 金额由系统按数量×单价算出，金额条件分支读它
      payload._prices = prices;
      payload._planTotalCents = total;
      payload._supplierId = form.supplierId;
      await bindFiles(em, user, run.id, 'quoteFiles', form.quoteFiles);
    } else if (stepKey === 'order') {
      payload._orderNo = form.orderNo;
      payload._paymentMode = form.paymentMode;
      payload._promisedArrival = form.promisedArrivalDate;
      payload._paidCents = num(form.paidCents) ?? 0;
      payload._payRefs = str(form.payRef).trim() ? [str(form.payRef).trim()] : [];
      await bindFiles(em, user, run.id, 'voucher', form.voucher);
    } else if (stepKey === 'receive') {
      const r = normalizeReceipt(form.lines, lines, true);
      const acc = applyReceipt(lines, receiptOf(payload), r.entries);
      form.lines = r.entries;
      form.result = acc.result; // 验收结果由累计数量推出，决定后面要不要走异常处置
      payload._recv = acc.state;
      await bindFiles(em, user, run.id, 'receiptPhotos', form.receiptPhotos);
    } else if (stepKey === 'exception') {
      payload._resolution = form.resolution;
    } else if (stepKey === 'refund_confirm') {
      payload._refundedCents = num(form.refundedCents) ?? 0;
      payload._refundRefs = [...(Array.isArray(payload._refundRefs) ? (payload._refundRefs as string[]) : []), ...(str(form.refundRef).trim() ? [str(form.refundRef).trim()] : [])];
      await bindFiles(em, user, run.id, 'refundVoucher', form.refundVoucher);
    } else if (stepKey === 'final_pay') {
      payload._paidCents = (num(payload._paidCents) ?? 0) + (num(form.paidCents) ?? 0);
      payload._payRefs = [...(Array.isArray(payload._payRefs) ? (payload._payRefs as string[]) : []), str(form.payRef).trim()];
      await bindFiles(em, user, run.id, 'finalVoucher', form.finalVoucher);
    }
  },

  returnBlocked({ stepKey, payload }) {
    if (stepKey === 'receive' && (num(payload._paidCents) ?? 0) > 0) return '已经登记了付款，不能退回到付款之前；到货有问题请在验收里登记，走异常处置';
    if (num(payload._inboundDocId) !== null && ['inbound', 'final_pay', 'refund_confirm'].includes(stepKey)) return '已经生成了采购入库单草稿，不能退回；请先到制单中心处理这张草稿';
    return null;
  },

  cancelBlocked({ payload }) {
    if (num(payload._inboundDocId) !== null) return '已经生成了采购入库单草稿，不能废除；请先到制单中心处理这张草稿';
    const rec = receiptOf(payload);
    if (rec && Object.values(rec).some((x) => x.received > 0)) return '已经有到货验收记录，不能废除；请按验收异常处置收尾';
    if ((num(payload._paidCents) ?? 0) > 0) return '已经登记了付款，不能直接废除；供应商未发货请在“到货验收”登记情况，走异常处置里的“取消未到货部分”并登记退款';
    return null;
  },
};

