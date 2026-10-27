import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import {
  PURCHASE_MONEY_STEPS, PURCHASE_TEMPLATE, createChecker, currentBatch, pendingShipments, prepayUsage, receivedQty, remainingQty, todayInChina, toShipQty, shipmentOutstanding, pkey,
  type Batch, type PurchaseLine, type PurchaseState, type PurchaseStepKey,
} from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { FlowRun, FlowStep, ResourceFile, ResourceRecord, WorkItem } from '../entities';
import { FilesService, type UploadedFile } from '../integrations/files.service';
import { FlowService } from './flow.service';
import { EVIDENCE_TYPE, PURCHASE_KEY, earmarkedPrepay, linesOf, stateOf, supplierPrepayBalance } from './purchase';

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const PRODUCT_PAGE = 40;

/**
 * 采购申请中心的辅助接口：商品选择、状态视图（价格和付款服务端脱敏）、发货跟进、申请变更/终止、凭证上传。
 * 谁办哪一步、顺序都在统一流程里；这里不决定办理人。
 */
@Injectable()
export class PurchaseService {
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly flow: FlowService, private readonly files: FilesService) {}

  // ---------- 商品选择（发起采购用；不含成本价格） ----------
  async products(user: AuthUser, q: { keyword?: string; categoryId?: number; page: number }) {
    const em = this.ds.manager;
    const c = user.companyId;
    const cats = await em.find(ResourceRecord, { where: { companyId: c, type: 'finance-categories' }, select: ['id', 'title', 'data', 'status'] });
    const catParent = new Map(cats.map((x) => [x.id, x.data.parentId ? Number(x.data.parentId) : null]));
    const inCat = (id: number | null) => {
      if (!q.categoryId) return true;
      const seen = new Set<number>();
      while (id && !seen.has(id)) { if (id === q.categoryId) return true; seen.add(id); id = catParent.get(id) ?? null; }
      return false;
    };
    const kw = (q.keyword ?? '').trim().slice(0, 50);
    const qb = em.createQueryBuilder(ResourceRecord, 'r').where('r.companyId = :c AND r.type = :t AND r.status = :s', { c, t: 'finance-products', s: 'active' })
      .andWhere("JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.archiveType')) IN (:...types)", { types: ['raw', 'purchased', 'shipping_material', 'package', 'oem_package'] });
    if (kw) qb.andWhere('(r.title LIKE :kw OR r.searchText LIKE :kw)', { kw: `%${kw.replace(/[\\%_]/g, '\\$&')}%` });
    const all = (await qb.orderBy('r.title', 'ASC').getMany()).filter((r) => inCat(r.data.categoryId ? Number(r.data.categoryId) : null));
    const name = new Map(cats.map((x) => [x.id, str(x.data.name) || x.title]));
    const rows = all.slice((q.page - 1) * PRODUCT_PAGE, q.page * PRODUCT_PAGE).map((p) => ({
      id: p.id, code: str(p.data.code) || p.title, name: str(p.data.name) || p.title, archiveType: str(p.data.archiveType),
      categoryId: p.data.categoryId ? Number(p.data.categoryId) : null, categoryName: p.data.categoryId ? name.get(Number(p.data.categoryId)) ?? '' : '',
      unit: str(p.data.purchaseSpec).trim() || '', unitKey: str(p.data.specUnit),
      aliases: str(p.data.archiveType) === 'raw' ? str(p.data.rawFinishedNames).split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : [],
    }));
    return { total: all.length, page: q.page, pageSize: PRODUCT_PAGE, rows, categories: cats.filter((x) => x.status !== 'stopped').map((x) => ({ id: x.id, name: str(x.data.name) || x.title, parentId: catParent.get(x.id) ?? null })) };
  }

  // ---------- 可见性与脱敏 ----------
  private async run(em: EntityManager, user: AuthUser, id: number): Promise<FlowRun> {
    await this.flow.detail(user, id); // 能不能看由流程可见性决定，不能看会抛错
    const run = await em.findOne(FlowRun, { where: { id, companyId: user.companyId, templateKey: PURCHASE_TEMPLATE } });
    if (!run) throw new NotFoundException('采购申请不存在');
    return run;
  }

  /** 能看价格和付款：管理员、有成本查看权限，或办理过涉及金额的步骤的人 */
  private async canMoney(em: EntityManager, user: AuthUser, run: FlowRun): Promise<boolean> {
    if (user.permissions.isCompanyAdmin || createChecker(user.permissions)('product.cost.view')) return true;
    const [row] = await em.query(
      `SELECT COUNT(*) AS n FROM flow_steps WHERE run_id = ? AND step_key IN (${PURCHASE_MONEY_STEPS.map(() => '?').join(',')}) AND (JSON_CONTAINS(recipients, CAST(? AS JSON)) OR handled_by = ?)`,
      [run.id, ...PURCHASE_MONEY_STEPS, String(user.id), user.id]);
    return Number(row.n) > 0;
  }

  async state(user: AuthUser, id: number) {
    const em = this.ds.manager;
    const run = await this.run(em, user, id);
    const money = await this.canMoney(em, user, run);
    return this.view(run, money, await this.myOpenStep(em, user, run));
  }

  private async myOpenStep(em: EntityManager, user: AuthUser, run: FlowRun): Promise<string | null> {
    const open = await em.findOne(WorkItem, { where: { companyId: user.companyId, runId: run.id, assigneeId: user.id, status: 'open' } });
    if (!open?.stepId) return null;
    return (await em.findOne(FlowStep, { where: { id: open.stepId } }))?.stepKey ?? null;
  }

  /** 脱敏出口：没有金额权限就不返回单价、货款、付款、冲抵、成本发布和费用金额。 */
  view(run: FlowRun, money: boolean, myStep: string | null) {
    const s = stateOf(run.payload);
    const lines = linesOf(run.payload);
    const done = run.status !== 'running';
    const usage = prepayUsage(s);
    const batchView = (b: Batch) => ({
      id: b.id, shipmentId: b.shipmentId, shipment: b.shipment, logisticsNo: b.logisticsNo, expectedArrivalAt: b.expectedArrivalAt, dispatchFiles: b.dispatchFiles,
      arrived: !!b.arrived, arrivalFiles: b.arrivalFiles ?? [], received: b.received ?? null, receiptFiles: b.receiptFiles ?? [], difference: b.difference ?? '',
      deliveryShortage: b.deliveryShortage ?? [], accepted: b.accepted ? b.accepted.map((a) => ({ productId: a.productId, qty: a.qty, ...(money ? { unitPriceCents: a.unitPriceCents } : {}) })) : null,
      qualityFiles: b.qualityFiles ?? [], qualityComment: b.qualityComment ?? '', pendingException: !!b.pendingException, resolution: b.resolution ?? null, resolutionComment: b.resolutionComment ?? '',
      resolutionFiles: b.resolutionFiles ?? [], discountApproval: !!b.discountApproval, returnedLines: b.returnedLines ?? [], retryShipment: !!b.retryShipment, returnedToSupplier: !!b.returnedToSupplier,
      feesDeclared: !!b.feesDeclared, zeroReason: b.zeroReason ?? '', allocationMethod: b.allocationMethod ?? null, posted: !!b.posted,
      fees: b.fees.map((f) => ({ id: f.id, type: f.type, paid: f.paid, files: f.files, ...(money ? { amountCents: f.amountCents, payeeName: f.payeeName, payeeAccount: f.payeeAccount, paymentDocNo: f.paymentDocNo ?? null, paymentFiles: f.paymentFiles ?? [] } : {}) })),
      ...(money ? { goodsCents: b.goodsCents ?? null, offsetCents: b.offsetCents ?? null, docNo: b.docNo ?? null, costPublication: b.costPublication ?? [] } : {}),
    });
    return {
      id: run.id, status: run.status, requesterId: run.requesterId, requestedArrivalAt: str(run.payload.requestedArrivalAt), note: str(run.payload.note), money, myStep,
      supplierName: s.supplierName ?? '', warehouseName: s.warehouseName ?? '', paymentMode: s.paymentMode ?? null, planReady: !!s.planReady, approved: !!s.approved, amendOpen: !!s.amendOpen,
      cancelRequested: !!s.cancelRequested, cancelApproved: !!s.cancelApproved, cancelledRemaining: !!s.cancelledRemaining, cancelRequestComment: s.cancelRequestComment ?? '',
      lines: lines.map((l) => ({
        productId: l.productId, name: l.name, code: l.code, unit: l.unit, aliasName: l.aliasName ?? null, qty: l.qty, received: receivedQty(s, l.productId), cancelled: s.cancelledQty[pkey(l.productId)] ?? 0,
        remaining: remainingQty(s, l), toShip: toShipQty(s, l), ...(money ? { unitPriceCents: s.prices[pkey(l.productId)] ?? null } : {}),
      })),
      shipments: s.shipments.map((sh) => ({ id: sh.id, logisticsNo: sh.logisticsNo, expectedArrivalAt: sh.expectedArrivalAt, files: sh.files, lines: sh.lines.map((l) => ({ ...l, outstanding: shipmentOutstanding(s, sh, l.productId) })) })),
      pendingShipments: pendingShipments(s).map((sh) => sh.id),
      batches: s.batches.map(batchView),
      followups: s.followups,
      amendments: s.amendments.map((a) => ({ at: a.at, byName: a.byName, comment: a.comment })),
      ...(money ? {
        payeeName: s.payeeName ?? '', payeeAccount: s.payeeAccount ?? '', planNote: s.planNote ?? '', planFiles: s.planFiles ?? [], approvedCents: s.approvedCents ?? null, approvalComment: s.approvalComment ?? '',
        payments: s.payments, prepay: { ...usage, unusedCents: done ? 0 : usage.unusedCents }, refunds: s.refunds, paymentReopened: !!s.paymentReopened, prepayReviewed: !!s.prepayReviewed,
        cancelFiles: s.cancelFiles ?? [], cancelApprovalComment: s.cancelApprovalComment ?? '',
      } : { prepayReviewed: !!s.prepayReviewed }),
    };
  }

  /** 只给能看到的流程返回进度 */
  async progressVisible(user: AuthUser, ids: number[]) {
    const visible: number[] = [];
    for (const id of ids) { try { await this.flow.detail(user, id); visible.push(id); } catch { /* 看不到的不返回 */ } }
    return this.progress(user, visible);
  }

  /** 列表上的进度：每条采购的商品到货情况、批次数、停在哪（没有金额） */
  async progress(user: AuthUser, ids: number[]) {
    if (!ids.length) return {};
    const runs = await this.ds.manager.find(FlowRun, { where: { companyId: user.companyId, templateKey: PURCHASE_TEMPLATE, id: In(ids) } });
    return Object.fromEntries(runs.map((r) => {
      const s = stateOf(r.payload);
      const ls = linesOf(r.payload);
      return [r.id, {
        supplierName: s.supplierName ?? '', requestedArrivalAt: str(r.payload.requestedArrivalAt), batches: s.batches.length,
        total: ls.reduce((a, l) => a + l.qty, 0), received: ls.reduce((a, l) => a + receivedQty(s, l.productId), 0),
        items: ls.length, abnormal: !!currentBatch(s)?.pendingException || !!s.cancelRequested, refunding: !!s.cancelApproved,
      }];
    }));
  }

  // ---------- 办理人的下拉选项（供应商、仓库、付款账户、预付款余额） ----------
  async options(user: AuthUser, id: number) {
    const em = this.ds.manager;
    const run = await this.run(em, user, id);
    const step = await this.myOpenStep(em, user, run);
    if (!step) throw new ForbiddenException('这一步不是你办理的');
    const s = stateOf(run.payload);
    const list = async (type: string) => (await em.find(ResourceRecord, { where: { companyId: user.companyId, type }, order: { title: 'ASC' } })).filter((r) => r.status === 'active' && !r.archivedAt).map((r) => ({ id: r.id, name: r.title }));
    const out: Record<string, unknown> = { step };
    if (step === 'plan') { out.suppliers = await list('finance-suppliers'); out.warehouses = await list('finance-warehouses'); }
    if (['pay', 'refund', 'expense_pay'].includes(step)) out.banks = await list('bank-accounts');
    if (step === 'pay' && s.supplierId) {
      const usage = prepayUsage(s);
      const balance = await supplierPrepayBalance(em, user.companyId, s.supplierId);
      const earmarked = await earmarkedPrepay(em, user.companyId, s.supplierId, run.id);
      out.prepay = { balanceCents: balance, availableCents: Math.max(0, balance - earmarked - usage.unusedCents) };
    }
    return out;
  }

  // ---------- 发货跟进 ----------
  async followup(user: AuthUser, id: number, p: { promisedShipAt: string; comment?: string }) {
    const date = str(p.promisedShipAt);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw new BadRequestException('请选择供应商承诺的发货日期');
    if (date < todayInChina()) throw new BadRequestException('承诺发货日期不能早于今天');
    return this.ds.transaction(async (em) => {
      const run = await em.findOne(FlowRun, { where: { id, companyId: user.companyId, templateKey: PURCHASE_TEMPLATE }, lock: { mode: 'pessimistic_write' } });
      if (!run) throw new NotFoundException('采购申请不存在');
      if (run.status !== 'running') throw new ConflictException('这条采购已经结束了');
      if ((await this.myOpenStep(em, user, run)) !== 'dispatch') throw new ForbiddenException('只有当前负责跟进发货的人能登记');
      const s = stateOf(run.payload);
      const who = await em.query('SELECT name FROM users WHERE company_id = ? AND id = ?', [user.companyId, user.id]);
      s.followups.push({ at: new Date().toISOString(), promisedShipAt: date, comment: str(p.comment).trim().slice(0, 500), byName: who[0]?.name ?? '' });
      await em.update(FlowRun, { id: run.id }, { payload: run.payload } as never);
      return { ok: true, followups: s.followups };
    });
  }

  // ---------- 申请人动作：申请变更采购内容、申请终止未到货部分并退款 ----------
  async control(user: AuthUser, id: number, mode: 'amend' | 'cancel_remaining', comment: string) {
    const why = comment.trim();
    if (!why) throw new BadRequestException('请写明原因');
    const check = async (em: EntityManager) => {
      const run = await em.findOne(FlowRun, { where: { id, companyId: user.companyId, templateKey: PURCHASE_TEMPLATE } });
      if (!run) throw new NotFoundException('采购申请不存在');
      if (run.requesterId !== user.id) throw new ForbiddenException('只有发起人能申请变更或终止');
      return run;
    };
    await check(this.ds.manager);
    const who = (await this.ds.query('SELECT name FROM users WHERE company_id = ? AND id = ?', [user.companyId, user.id]))[0]?.name ?? '';
    return this.flow.redirect(user, id, {
      toKey: mode === 'amend' ? 'apply' : 'exception',
      reason: `${mode === 'amend' ? '申请变更采购内容' : '申请终止未到货部分并退款'}：${why}`,
      via: mode === 'amend' ? 'return' : 'normal',
      mutate: ({ run, payload }) => {
        const s = stateOf(payload);
        const b = currentBatch(s);
        if (run.requesterId !== user.id) throw new ForbiddenException('只有发起人能申请变更或终止');
        if (mode === 'amend') {
          if (!s.payments.length && !s.prepayClaimCents) throw new BadRequestException('还没有付款，可以直接让办理人退回，或撤回后重新申请');
          if (s.cancelRequested) throw new BadRequestException('已经申请终止，请等待审批');
          if (b && !b.posted && !b.returnedToSupplier) throw new BadRequestException('本批已发货，请先完成本批处理后再变更未到货部分');
          if (pendingShipments(s).length) throw new BadRequestException('仍有已发货商品在途，请先完成该发货批次后再变更采购内容');
          s.amendments.push({ at: new Date().toISOString(), byName: who, comment: why, lines: JSON.parse(JSON.stringify(linesOf(payload))), approvedCents: s.approvedCents ?? null });
          s.amendOpen = true;
          s.approved = false;
          return;
        }
        if (s.batches.some((x) => x.posted && x.fees.some((f) => !f.paid)) || (b?.feesDeclared && !b.posted && b.fees.length)) throw new BadRequestException('请先完成已发生运费、装卸费的结算与付款');
        if (!s.payments.length && !s.prepayClaimCents) throw new BadRequestException('尚未付款的采购可以直接撤回');
        if (s.cancelRequested) throw new BadRequestException('已经申请过终止，请等待审批');
        s.cancelRequested = true;
        s.cancelRequestComment = why;
      },
    });
  }

  // ---------- 凭证 ----------
  async upload(user: AuthUser, runId: number, file: UploadedFile | undefined) {
    const em = this.ds.manager;
    const run = await this.run(em, user, runId);
    if (run.status !== 'running') throw new ConflictException('这条采购已经结束了');
    const step = await this.myOpenStep(em, user, run);
    if (!step) throw new ForbiddenException('只有当前办理人能上传凭证');
    return this.files.putBlob(user.companyId, user.id, EVIDENCE_TYPE, 'evidence', file);
  }

  async fileUrl(user: AuthUser, runId: number, fileId: number) {
    const em = this.ds.manager;
    const run = await this.run(em, user, runId);
    const money = await this.canMoney(em, user, run);
    const v = this.view(run, money, null) as unknown as Record<string, unknown>;
    const ids = new Set<number>();
    const walk = (x: unknown) => {
      if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === 'object') for (const [k, val] of Object.entries(x)) { if (/files$/i.test(k) && Array.isArray(val)) val.forEach((n) => typeof n === 'number' && ids.add(n)); else walk(val); }
    };
    walk(v);
    const own = await em.findOne(ResourceFile, { where: { id: fileId, companyId: user.companyId, resourceType: EVIDENCE_TYPE, resourceId: runId } });
    if (!own || !ids.has(fileId)) throw new ForbiddenException('没有查看这个文件的权限');
    return this.files.urlOf(user.companyId, fileId, EVIDENCE_TYPE);
  }
}

export type PurchaseView = ReturnType<PurchaseService['view']>;
export type { PurchaseState, PurchaseLine, PurchaseStepKey };
void PURCHASE_KEY;
