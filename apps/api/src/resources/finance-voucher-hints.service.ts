import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { PARTY_KIND_RESOURCE, createChecker, type PartyKind } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { ResourceRecord } from '../entities';

/**
 * 开单页的辅助查询（管家婆“单据助手”：往来单位详情、信用额度、实时库存、价格参考）。
 * 只读；全部带公司条件；成本类（最近进价）要有 product.cost.view，销售价类（最近售价）要有 product.price.view，没有就不返回字段。
 */
@Injectable()
export class FinanceVoucherHintsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  private can(user: AuthUser, key: string) { return createChecker(user.permissions)(key); }
  private needDoc(user: AuthUser) {
    if (!(this.can(user, 'finance.docs.create') || this.can(user, 'finance.history.view') || this.can(user, 'finance.drafts.view'))) throw new ForbiddenException('没有制单权限');
  }

  /** 往来对象的应收/应付/预收/预付余额；客户另带赊销额度和是否超额 */
  async partyBalance(user: AuthUser, partyKind: PartyKind, partyId: number) {
    this.needDoc(user);
    const rec = await this.dataSource.manager.findOne(ResourceRecord, { where: { companyId: user.companyId, id: partyId, type: PARTY_KIND_RESOURCE[partyKind] } });
    if (!rec) throw new NotFoundException('往来对象不存在');
    const rows: Array<{ kind: string; s: string }> = await this.dataSource.query(
      "SELECT kind, SUM(amount_cents) AS s FROM finance_entries WHERE company_id = ? AND account_id = ? AND kind IN ('receivable','payable','advance_receipt','prepayment') GROUP BY kind", [user.companyId, partyId]);
    const get = (k: string) => Number(rows.find((r) => r.kind === k)?.s ?? 0);
    const receivableCents = get('receivable'), payableCents = -get('payable'), advanceReceiptCents = -get('advance_receipt'), prepaymentCents = get('prepayment');
    const limit = partyKind === 'customer' && this.can(user, 'resource.finance-customers.view') ? Number(rec.data.creditLimit) || null : null;
    return { partyId, partyKind, name: rec.title, receivableCents, payableCents, advanceReceiptCents, prepaymentCents, creditLimitCents: limit, overLimit: limit !== null && receivableCents > limit };
  }

  /** 明细行提示：账面库存（可按仓库）、最近进价（要成本权限）、最近售价（要价格权限） */
  async lineHints(user: AuthUser, productIds: number[], warehouseId?: number) {
    this.needDoc(user);
    const ids = [...new Set(productIds)].filter((x) => Number.isInteger(x) && x > 0).slice(0, 100);
    if (!ids.length) return [];
    const owned = await this.dataSource.manager.find(ResourceRecord, { where: { companyId: user.companyId, type: 'finance-products', id: In(ids) }, select: ['id'] });
    const ok = owned.map((r) => r.id);
    if (!ok.length) return [];
    const ph = ok.map(() => '?').join(',');
    const stock: Array<{ pid: number; q: string }> = await this.dataSource.query(
      `SELECT account_id AS pid, SUM(qty) AS q FROM finance_entries WHERE company_id = ? AND kind = 'inventory' AND account_id IN (${ph}) ${warehouseId ? 'AND sub_id = ?' : ''} GROUP BY account_id`,
      warehouseId ? [user.companyId, ...ok, warehouseId] : [user.companyId, ...ok]);
    const canCost = this.can(user, 'product.cost.view'), canPrice = this.can(user, 'product.price.view');
    const last = async (type: string): Promise<Map<number, { c: number; d: string; no: string }>> => {
      const rows: Array<{ pid: number; c: string; d: string; no: string }> = await this.dataSource.query(
        `SELECT l.product_id AS pid, l.unit_price_cents AS c, d.doc_date AS d, d.doc_no AS no FROM finance_document_lines l JOIN finance_documents d ON d.id = l.document_id
          WHERE l.company_id = ? AND d.company_id = ? AND d.doc_type = ? AND d.status = 'posted' AND d.reverses_id IS NULL AND l.product_id IN (${ph}) ORDER BY d.doc_date DESC, d.id DESC`, [user.companyId, user.companyId, type, ...ok]);
      const m = new Map<number, { c: number; d: string; no: string }>();
      for (const r of rows) if (!m.has(Number(r.pid))) m.set(Number(r.pid), { c: Number(r.c), d: String(r.d).slice(0, 10), no: r.no });
      return m;
    };
    const purchase = canCost ? await last('purchase-in') : new Map();
    const sale = canPrice ? await last('sale') : new Map();
    return ok.map((id) => {
      const p = purchase.get(id), s = sale.get(id);
      return {
        productId: id, stockQty: Number(stock.find((x) => Number(x.pid) === id)?.q ?? 0),
        ...(canCost ? { lastPurchaseCents: p?.c ?? null, lastPurchaseDocNo: p?.no ?? null, lastPurchaseDate: p?.d ?? null } : {}),
        ...(canPrice ? { lastSaleCents: s?.c ?? null, lastSaleDocNo: s?.no ?? null, lastSaleDate: s?.d ?? null } : {}),
      };
    });
  }
}
