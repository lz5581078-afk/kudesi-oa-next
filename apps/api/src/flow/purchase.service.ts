import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { PURCHASE_COST_PERMISSION, PURCHASE_TEMPLATE, acceptedLines, createChecker, shanghaiToday } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { FlowEvent, FlowRun, FlowStep, ResourceRecord, WorkItem } from '../entities';
import { FinanceDocumentsService } from '../resources/finance-documents.service';
import { FlowService } from './flow.service';
import { asEngine } from './flow-adapters';
import { linesOf, pricesOf, receiptOf } from './purchase';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const INACTIVE = ['inactive', 'stopped', 'deleted', 'cancelled'];

/**
 * 采购流程的辅助接口：申请表单的商品选项、详情页的采购摘要、入库登记时的“生成采购入库单草稿”。
 * 摘要里的单价和金额只给有“成本查看”权限的人；生成草稿只生成草稿，不开立不过账。
 */
@Injectable()
export class PurchaseService {
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly flow: FlowService, private readonly docs: FinanceDocumentsService) {}

  private can(user: AuthUser, key: string) { return createChecker(user.permissions)(key); }

  /** 申请表单里搜商品：只列启用的、非自制品的商品档案，最多 30 条，只给编码名称规格，没有价格 */
  async options(user: AuthUser, keyword = '', ids = '') {
    const em = this.ds.manager;
    const q = em.createQueryBuilder(ResourceRecord, 'r').where('r.companyId = :c AND r.type = :t', { c: user.companyId, t: 'finance-products' });
    const list = [...new Set(ids.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 200);
    if (ids) { if (!list.length) return { items: [] }; q.andWhere('r.id IN (:...ids)', { ids: list }); }
    else {
      q.andWhere('r.status = :s', { s: 'active' });
      const kw = keyword.trim().slice(0, 50);
      if (kw) q.andWhere('r.searchText LIKE :kw', { kw: `%${kw}%` });
    }
    const rows = await q.orderBy('r.title', 'ASC').limit(ids ? 200 : 120).getMany();
    const items = rows.filter((r) => r.data.archiveType !== 'self_made').slice(0, ids ? 200 : 30)
      .map((r) => ({ id: r.id, code: str(r.data.code), name: r.title, spec: str(r.data.purchaseSpec) || str(r.data.productPackagingSpec) || '' }));
    return { items };
  }

  /** 详情页的采购摘要：明细、验收进度、付款、入库单草稿；金额类只给有成本查看权限的人 */
  async summary(user: AuthUser, runId: number) {
    await this.flow.detail(user, runId); // 不能看这条流程就抛 403/404
    const em = this.ds.manager;
    const run = await em.findOne(FlowRun, { where: { id: runId, companyId: user.companyId, templateKey: PURCHASE_TEMPLATE } });
    if (!run) throw new NotFoundException('不是采购流程');
    const money = this.can(user, PURCHASE_COST_PERMISSION);
    const lines = linesOf(run.payload);
    const prices = pricesOf(run.payload);
    const rec = receiptOf(run.payload);
    const products = lines.length ? await em.find(ResourceRecord, { where: { companyId: user.companyId, type: 'finance-products', id: In(lines.map((l) => l.productId)) } }) : [];
    const supplierId = num(run.payload._supplierId);
    const supplier = supplierId ? await em.findOne(ResourceRecord, { where: { companyId: user.companyId, type: 'finance-suppliers', id: supplierId }, select: ['id', 'title'] }) : null;
    const active = run.status === 'running' ? await em.findOne(FlowStep, { where: { runId, status: 'active', stepKey: 'inbound' } }) : null;
    const mine = active ? await em.findOne(WorkItem, { where: { companyId: user.companyId, stepId: active.id, assigneeId: user.id, status: 'open' } }) : null;
    const accepted = acceptedLines(lines, rec);
    const docId = num(run.payload._inboundDocId);
    return {
      canSeeMoney: money,
      lines: lines.map((l) => {
        const p = products.find((x) => x.id === l.productId);
        const price = prices.find((x) => x.productId === l.productId);
        return {
          productId: l.productId, code: str(p?.data.code), name: p?.title ?? `商品 #${l.productId}`, qty: l.qty, unit: l.unit ?? '', note: l.note ?? '',
          received: rec?.[String(l.productId)]?.received ?? null, accepted: rec?.[String(l.productId)]?.accepted ?? null,
          ...(money && price ? { unitPriceCents: price.unitPriceCents } : {}),
        };
      }),
      supplier: supplier ? { id: supplier.id, name: supplier.title } : null,
      orderNo: str(run.payload._orderNo) || null, paymentMode: str(run.payload._paymentMode) || null, promisedArrivalDate: str(run.payload._promisedArrival) || null,
      ...(money ? { totalCents: num(run.payload._planTotalCents), paidCents: num(run.payload._paidCents) ?? 0 } : {}),
      inbound: docId ? { docId, docNo: str(run.payload._inboundDocNo) } : null,
      canGenerateDraft: !!mine && !docId && accepted.length > 0 && this.can(user, 'flow.purchase.inbound-draft'),
      acceptedCount: accepted.length,
    };
  }

  /**
   * 入库登记时生成采购入库单草稿：只生成草稿（不开立、不过账、不动库存和应付），用合格数量和采购方案里的单价；
   * 同一条流程只会生成一张（来源键幂等）。要有 flow.purchase.inbound-draft，并且是“入库登记”这一步的办理人。
   */
  async inboundDraft(user: AuthUser, runId: number, b: { warehouseId: number; date?: string }) {
    if (b.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) throw new BadRequestException('单据日期格式应为 YYYY-MM-DD');
    return this.ds.transaction(async (em) => {
      const run = await em.findOne(FlowRun, { where: { id: runId, companyId: user.companyId }, lock: { mode: 'pessimistic_write' } });
      if (!run || run.templateKey !== PURCHASE_TEMPLATE) throw new NotFoundException('采购流程不存在');
      if (run.status !== 'running') throw new ConflictException('这条流程已经结束了');
      const step = await em.findOne(FlowStep, { where: { runId, status: 'active', stepKey: 'inbound' } });
      if (!step) throw new ConflictException('现在不在“入库登记”这一步');
      if (!(await em.findOne(WorkItem, { where: { companyId: user.companyId, stepId: step.id, assigneeId: user.id, status: 'open' } }))) throw new ForbiddenException('这一步不是你办理的');
      const existing = num(run.payload._inboundDocId);
      if (existing) return { docId: existing, docNo: str(run.payload._inboundDocNo), already: true };
      const lines = linesOf(run.payload);
      const accepted = acceptedLines(lines, receiptOf(run.payload));
      if (!accepted.length) throw new BadRequestException('没有合格数量，不需要入库单');
      const wh = await em.findOne(ResourceRecord, { where: { companyId: user.companyId, type: 'finance-warehouses', id: b.warehouseId } });
      if (!wh || INACTIVE.includes(wh.status)) throw new BadRequestException('入库仓库不存在或已停用');
      const supplierId = num(run.payload._supplierId);
      if (!supplierId) throw new BadRequestException('还没有确定供应商');
      const prices = pricesOf(run.payload);
      const draft = await this.docs.createDraft(asEngine(user), {
        type: 'purchase-in', date: b.date ?? shanghaiToday(), partyId: supplierId, partyKind: 'supplier', warehouseId: wh.id,
        lines: accepted.map((a) => {
          const price = prices.find((p) => p.productId === a.productId);
          if (!price) throw new BadRequestException('采购方案里缺少单价');
          return { productId: a.productId, qty: a.qty, unitPriceCents: price.unitPriceCents, ...(a.unit ? { unit: a.unit } : {}), memo: `采购流程 #${run.id}` };
        }),
      }, {
        memo: `采购流程 #${run.id}（订单 ${str(run.payload._orderNo)}）生成的草稿。流程已登记付款 ${((num(run.payload._paidCents) ?? 0) / 100).toFixed(2)} 元，预付冲抵和实付请在开单页核对；本草稿没有开立也没有过账`.slice(0, 500),
        sourceKey: `flow-purchase:${run.id}:inbound`,
      }, em);
      run.payload = { ...run.payload, _inboundDocId: draft.id, _inboundDocNo: draft.docNo, _inboundWarehouseId: wh.id };
      await em.update(FlowRun, { id: run.id }, { payload: run.payload } as never);
      await em.insert(FlowEvent, { companyId: run.companyId, runId: run.id, stepId: step.id, actorId: user.id, action: 'draft', note: draft.docNo });
      return { docId: draft.id, docNo: draft.docNo, already: false };
    });
  }
}
