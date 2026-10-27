import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import {
  lineAmount, settledLineCents, validUnitCents, OPENING_PREPAYMENT_PERMISSION, DOC_DIRECTION, DOC_TYPE_MAP, getResourceDef, DOC_TYPES, FEE_BOOKING_NODE_MAP, docTypesOfDirection, hasBankRef, PARTY_KIND_LABEL, PARTY_KIND_RESOURCE, buildEntries, effectivePaid, todayInChina, createChecker, docTotal, negateEntries, validateDoc,
  SETTLE_BY_LABEL, type DocInput, type DocLineInput, type DocType, type Entry, type SettleBy,
} from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { AuditLog, ResourceFile, FinanceDocument, FinanceDocumentAccount, FinanceDocumentEvent, FinanceDocumentLine, FinanceDocumentSettlement, FinanceEntry, ResourceRecord } from '../entities';

const COST_VIEW = 'product.cost.view';
const today = todayInChina;
const ymd = (d: string) => d.replace(/-/g, '');
/** 单据来源：流程办理时自动生成的单据 sourceKey 以 flow: 开头；其余都是人在制单中心手工做的 */
export const sourceLabel = (key: string | null | undefined) => (key?.startsWith('flow:') ? '流程自动记账' : '手工制单');

export const OPENING_VOUCHER_TYPE = 'opening-prepayment-voucher';
export interface OpeningPrepaymentInput { reason: string; fileIds: number[]; confirmed: boolean }

export interface ListQuery { scope: 'drafts' | 'history' | DocType; direction?: 'in' | 'out' | 'internal'; status?: string; creatorId?: number; audited?: 'yes' | 'no'; docType?: string; from?: string; to?: string; keyword?: string; page: number; pageSize: number }

/**
 * 财务单据引擎：草稿 → 开立 → 过账 → 红冲。
 * 账只认分录：借正贷负，每张单据合计为 0；过账和红冲都在一个事务里，并且全公司串行（锁一行计数器），
 * 所以“库存不能为负”“预收预付不能超冲”这类检查不会被并发绕过。
 * 流程引擎以后调用 createDraft(..., sourceKey) / post，同一个 sourceKey 只会产生一张单据（幂等）。
 */
@Injectable()
export class FinanceDocumentsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** 流程引擎在自己的事务里调用时传入 em，单据和流程流转同成同败 */
  private tx<T>(em: EntityManager | undefined, fn: (em: EntityManager) => Promise<T>): Promise<T> {
    return em ? fn(em) : this.dataSource.transaction(fn);
  }

  // ---------- 权限 ----------
  private can(user: AuthUser, key: string) { return createChecker(user.permissions)(key); }
  private need(user: AuthUser, key: string, msg: string) { if (!this.can(user, key)) throw new ForbiddenException(msg); }
  private canSee(user: AuthUser, type: string) {
    return this.can(user, `finance.doc-${type}.view`) || this.can(user, 'finance.history.view') || this.can(user, 'finance.drafts.view');
  }

  // ---------- 引用校验 ----------
  private async checkRefs(em: EntityManager, user: AuthUser, input: DocInput, selfId?: number) {
    const def = DOC_TYPE_MAP.get(input.type);
    if (!def) throw new BadRequestException('单据类型不认识');
    const ensure = async (type: string, id: number | null | undefined, label: string, extra?: (r: ResourceRecord) => string | null) => {
      if (id === null || id === undefined) return;
      const r = await em.findOne(ResourceRecord, { where: { companyId: user.companyId, type, id } });
      if (!r) throw new BadRequestException(`${label}不存在`);
      if (['inactive', 'cancelled', 'deleted'].includes(r.status)) throw new BadRequestException(`${label}「${r.title}」已停用`);
      const bad = extra?.(r);
      if (bad) throw new BadRequestException(bad);
    };
    if (def.party) {
      const kind = input.partyKind ?? def.partyKinds[0] ?? def.party;
      if (!def.partyKinds.includes(kind)) throw new BadRequestException(`${def.label}的往来对象不能选${PARTY_KIND_LABEL[kind] ?? kind}`);
      await ensure(PARTY_KIND_RESOURCE[kind], input.partyId, PARTY_KIND_LABEL[kind]);
    }
    if (input.docNo) {
      const dup = await em.findOne(FinanceDocument, { where: { companyId: user.companyId, docNo: input.docNo } });
      if (dup && dup.id !== selfId) throw new BadRequestException(`单据编号 ${input.docNo} 已经用过了`);
    }
    await ensure('bank-accounts', input.bankAccountId, '银行账户');
    await ensure('bank-accounts', input.toBankAccountId, '转入账户');
    await ensure('finance-warehouses', input.warehouseId, '仓库');
    if (def.store) await ensure('stores', input.storeId, '店铺');
    const ref = hasBankRef(def) ? input.refNo?.trim() : '';
    if (ref) {
      // 同一个银行流水号全公司只能登记一次（不分单据类型）；并发登记靠过账锁串行，数据库唯一键只是最后一道保险
      await this.lockPosting(em, user);
      const dup = await em.findOne(FinanceDocument, { where: { companyId: user.companyId, refNo: ref } });
      if (dup && dup.id !== selfId) throw new BadRequestException(`${def.store ? '平台提现流水号' : '银行流水号'} ${ref} 已经登记过（${dup.docNo}），不能重复登记`);
    }
    for (const a of input.accounts ?? []) await ensure('bank-accounts', a.bankAccountId, a.role === 'out' ? '转出账户' : '转入账户');
    for (const l of input.lines ?? []) {
      if (l.relatedNode) {
        const node = FEE_BOOKING_NODE_MAP.get(l.relatedNode);
        if (!node) throw new BadRequestException(`挂账节点「${l.relatedNode}」不认识`);
        if (l.relatedId) {
          if (!node.resource) throw new BadRequestException(`挂账节点「${node.node}」没有对应的资料，只能写名字`);
          await ensure(node.resource, l.relatedId, `挂账对象（${node.node}）`);
        }
      } else if (l.relatedId) throw new BadRequestException('选了挂账对象就要选挂账节点');
      await ensure('finance-products', l.productId, '商品');
      await ensure('finance-fee-items', l.feeItemId, '费用项目', (r) => (def.feeDirection && r.data.direction !== def.feeDirection ? `费用项目「${r.title}」的收支方向和这种单据不符` : null));
    }
  }

  private async nextDocNo(em: EntityManager, user: AuthUser, prefix: string, date: string) {
    const key = `${prefix}${ymd(date)}`;
    await em.query('INSERT INTO finance_doc_counters (company_id, counter_key, value) VALUES (?, ?, LAST_INSERT_ID(1)) ON DUPLICATE KEY UPDATE value = LAST_INSERT_ID(value + 1)', [user.companyId, key]);
    const [{ id }] = await em.query('SELECT LAST_INSERT_ID() AS id');
    return `${key}${String(id).padStart(3, '0')}`;
  }

  /** 全公司串行：过账/红冲前先锁住这一行 */
  private async lockPosting(em: EntityManager, user: AuthUser) {
    await em.query("INSERT IGNORE INTO finance_doc_counters (company_id, counter_key, value) VALUES (?, 'lock:posting', 0)", [user.companyId]);
    await em.query("SELECT value FROM finance_doc_counters WHERE company_id = ? AND counter_key = 'lock:posting' FOR UPDATE", [user.companyId]);
  }

  private async event(em: EntityManager, user: AuthUser, documentId: number, action: string, note?: string) {
    await em.insert(FinanceDocumentEvent, { companyId: user.companyId, documentId, action, actorId: user.id, note: note ?? null });
  }

  private async load(em: EntityManager, user: AuthUser, id: number, lock = false) {
    const doc = await em.findOne(FinanceDocument, { where: { id, companyId: user.companyId }, ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
    if (!doc) throw new NotFoundException('单据不存在');
    const lines = await em.find(FinanceDocumentLine, { where: { documentId: id, companyId: user.companyId }, order: { lineNo: 'ASC' } });
    const accounts = await em.find(FinanceDocumentAccount, { where: { documentId: id, companyId: user.companyId }, order: { id: 'ASC' } });
    const settlements = await em.find(FinanceDocumentSettlement, { where: { documentId: id, companyId: user.companyId }, order: { id: 'ASC' } });
    return { doc, lines, accounts, settlements };
  }

  private toInput(doc: FinanceDocument, lines: FinanceDocumentLine[], accounts: FinanceDocumentAccount[] = [], settlements: FinanceDocumentSettlement[] = []): DocInput {
    return {
      type: doc.docType as DocType, date: doc.docDate, partyId: doc.partyId, partyKind: doc.partyKind as never, paidCents: doc.paidCents, bankAccountId: doc.bankAccountId, toBankAccountId: doc.toBankAccountId,
      warehouseId: doc.warehouseId, storeId: doc.storeId, refNo: doc.refNo, amountCents: DOC_TYPE_MAP.get(doc.docType as DocType)?.lines ? null : doc.amountCents, offsetCents: doc.offsetCents,
      settleBy: (doc.settleBy as SettleBy | null) ?? null,
      settlements: settlements.length ? settlements.map((x) => ({ sourceDocId: x.sourceDocumentId, productId: x.productId, amountCents: x.amountCents })) : null,
      accounts: accounts.length ? accounts.map((a) => ({ role: a.role, bankAccountId: a.bankAccountId, amountCents: a.amountCents })) : null,
      lines: lines.map((l) => ({ productId: l.productId, feeItemId: l.feeItemId, qty: l.qty, unitPriceCents: l.unitPriceCents, unitCostCents: l.unitCostCents, memo: l.memo ?? undefined, relatedNode: l.relatedNode, relatedId: l.relatedId, relatedName: l.relatedName, itemName: l.itemName, unit: l.unit })),
    };
  }

  private async writeLines(em: EntityManager, user: AuthUser, documentId: number, lines: DocLineInput[]) {
    await em.delete(FinanceDocumentLine, { documentId, companyId: user.companyId });
    let n = 0;
    for (const l of lines) {
      await em.insert(FinanceDocumentLine, {
        companyId: user.companyId, documentId, lineNo: ++n, productId: l.productId ?? null, feeItemId: l.feeItemId ?? null, qty: l.qty,
        unitPriceCents: l.unitPriceCents, unitCostCents: l.unitCostCents ?? null, memo: l.memo ?? null,
        relatedNode: l.relatedNode ?? null, relatedId: l.relatedId ?? null, relatedName: l.relatedName?.trim() || null, itemName: l.itemName?.trim() || null, unit: l.unit?.trim() || null,
      });
    }
  }

  /** 费用档案里标了“必须挂对象”的费用项目，这一行必须选了挂账节点和对象 */
  private async checkFeeObjects(em: EntityManager, user: AuthUser, lines: FinanceDocumentLine[]) {
    const ids = [...new Set(lines.map((l) => l.feeItemId).filter((x): x is number => !!x))];
    if (!ids.length) return;
    const items = await em.find(ResourceRecord, { where: { companyId: user.companyId, type: 'finance-fee-items', id: In(ids) } });
    const need = new Map(items.filter((i) => i.data.requiredObject === 'yes').map((i) => [i.id, i.title]));
    lines.forEach((l, k) => {
      if (l.feeItemId && need.has(l.feeItemId) && !l.relatedId && !l.relatedName?.trim()) throw new BadRequestException(`第 ${k + 1} 行「${need.get(l.feeItemId)}」必须选挂账节点和挂账对象（费用档案里设置了必须挂对象）`);
    });
  }

  private async writeAccounts(em: EntityManager, user: AuthUser, documentId: number, input: DocInput) {
    await em.delete(FinanceDocumentAccount, { documentId, companyId: user.companyId });
    if (input.type !== 'transfer') return;
    for (const a of input.accounts ?? []) await em.insert(FinanceDocumentAccount, { companyId: user.companyId, documentId, role: a.role, bankAccountId: a.bankAccountId, amountCents: a.amountCents });
  }

  private settleByOf(input: DocInput) {
    return (input.type === 'receipt' || input.type === 'payment') && input.settleBy && input.settleBy !== 'amount' ? input.settleBy : null;
  }

  private async writeSettlements(em: EntityManager, user: AuthUser, documentId: number, input: DocInput) {
    await em.delete(FinanceDocumentSettlement, { documentId, companyId: user.companyId });
    if (!this.settleByOf(input)) return;
    for (const x of input.settlements ?? []) await em.insert(FinanceDocumentSettlement, { companyId: user.companyId, documentId, sourceDocumentId: x.sourceDocId, productId: input.settleBy === 'product' ? x.productId ?? null : null, amountCents: x.amountCents });
  }

  /** 每张来源单据还没结算的余额：单据金额 − 当场实收实付 − 预收预付冲抵 − 别的收付款单已经分走的（开立和已过账的都算占用） */
  private async openAmounts(em: EntityManager, user: AuthUser, ids: number[], excludeDocId = 0) {
    if (!ids.length) return new Map<number, { doc: FinanceDocument; outstanding: number; byProduct: Map<number, number> }>();
    const docs = await em.find(FinanceDocument, { where: { companyId: user.companyId, id: In(ids) } });
    const used = await em.query(
      `SELECT s.source_document_id AS sid, s.product_id AS pid, SUM(s.amount_cents) AS a FROM finance_document_settlements s JOIN finance_documents d ON d.id = s.document_id
        WHERE s.company_id = ? AND s.source_document_id IN (${ids.map(() => '?').join(',')}) AND d.status IN ('issued','posted') AND s.document_id <> ? GROUP BY s.source_document_id, s.product_id`,
      [user.companyId, ...ids, excludeDocId]);
    const out = new Map<number, { doc: FinanceDocument; outstanding: number; byProduct: Map<number, number> }>();
    for (const d of docs) out.set(d.id, { doc: d, outstanding: d.amountCents - d.paidCents - d.offsetCents, byProduct: new Map() });
    for (const u of used as { sid: number; pid: number | null; a: string }[]) {
      const o = out.get(Number(u.sid));
      if (!o) continue;
      o.outstanding -= Number(u.a);
      if (u.pid) o.byProduct.set(Number(u.pid), (o.byProduct.get(Number(u.pid)) ?? 0) + Number(u.a));
    }
    return out;
  }

  /** 按单据/按商品结算的校验：单据要已过账、同一个往来对象、方向对、不超过没结算的余额 */
  private async checkSettlements(em: EntityManager, user: AuthUser, input: DocInput, selfId: number) {
    if (!this.settleByOf(input)) return;
    const dir = input.type === 'receipt' ? 'in' : 'out';
    const def = DOC_TYPE_MAP.get(input.type)!;
    const kind = input.partyKind ?? def.partyKinds[0];
    const ss = input.settlements ?? [];
    const ids = [...new Set(ss.map((x) => x.sourceDocId))];
    const open = await this.openAmounts(em, user, ids, selfId);
    const want = new Map<number, number>();
    const wantProd = new Map<string, number>();
    for (const x of ss) {
      const o = open.get(x.sourceDocId);
      if (!o) throw new BadRequestException('要结算的单据不存在');
      const d = o.doc;
      const sdef = DOC_TYPE_MAP.get(d.docType as DocType);
      if (!sdef || sdef.settle !== dir || d.reversesId) throw new BadRequestException(`单据 ${d.docNo} 不是可以${dir === 'in' ? '收款' : '付款'}结算的单据`);
      if (d.status !== 'posted') throw new BadRequestException(`单据 ${d.docNo} 还没有过账（或已红冲），不能结算`);
      if (d.partyId !== input.partyId || d.partyKind !== kind) throw new BadRequestException(`单据 ${d.docNo} 的往来对象和本单不是同一个`);
      want.set(d.id, (want.get(d.id) ?? 0) + x.amountCents);
      if (input.settleBy === 'product') {
        const k = `${d.id}:${x.productId}`;
        wantProd.set(k, (wantProd.get(k) ?? 0) + x.amountCents);
      }
    }
    for (const [id, amt] of want) {
      const o = open.get(id)!;
      if (amt > o.outstanding) throw new BadRequestException(`单据 ${o.doc.docNo} 还没结算的只有 ${(o.outstanding / 100).toFixed(2)} 元，不能结算 ${(amt / 100).toFixed(2)} 元`);
    }
    if (input.settleBy === 'product') {
      for (const [k, amt] of wantProd) {
        const [sid, pid] = k.split(':').map(Number);
        const lines = await em.find(FinanceDocumentLine, { where: { documentId: sid, companyId: user.companyId, productId: pid } });
        if (!lines.length) throw new BadRequestException(`单据 ${open.get(sid)!.doc.docNo} 里没有这个商品`);
        const lineAmt = lines.reduce((a, l) => a + lineAmount(l), 0);
        const left = lineAmt - (open.get(sid)!.byProduct.get(pid) ?? 0);
        if (amt > left) throw new BadRequestException(`单据 ${open.get(sid)!.doc.docNo} 这个商品还没结算的只有 ${(left / 100).toFixed(2)} 元，不能结算 ${(amt / 100).toFixed(2)} 元`);
      }
    }
  }

  /** 转款多账户：主表的转出/转入账户记第一个，列表和旧的单账户写法都能用 */
  private transferHeads(input: DocInput) {
    const outs = (input.accounts ?? []).filter((a) => a.role === 'out'), ins = (input.accounts ?? []).filter((a) => a.role === 'in');
    return { bankAccountId: outs[0]?.bankAccountId ?? input.bankAccountId ?? null, toBankAccountId: ins[0]?.bankAccountId ?? input.toBankAccountId ?? null };
  }

  private sanity(input: DocInput) {
    // 草稿允许没填完，但数字本身必须合法
    if (!DOC_TYPE_MAP.get(input.type)) throw new BadRequestException('单据类型不认识');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date ?? '') || Number.isNaN(Date.parse(input.date))) throw new BadRequestException('单据日期格式应为 YYYY-MM-DD');
    for (const v of [input.amountCents, input.offsetCents, input.paidCents, ...(input.accounts ?? []).map((a) => a.amountCents), ...(input.settlements ?? []).map((x) => x.amountCents)]) {
      if (v !== null && v !== undefined && (!Number.isInteger(v) || Math.abs(v) > 99_999_999_999)) throw new BadRequestException('金额必须是以分为单位的整数');
    }
    for (const l of input.lines ?? []) for(const v of [l.unitPriceCents,l.unitCostCents]) if(v!==undefined && v!==null && !validUnitCents(v)) throw new BadRequestException('单价最多支持六位元小数');
    for (const l of input.lines ?? []) if (!(l.qty > 0) || Math.round(l.qty * 10000) / 10000 !== l.qty) throw new BadRequestException('数量必须大于 0，最多 4 位小数');
    if ((input.lines?.length ?? 0) > 200) throw new BadRequestException('一张单据最多 200 行');
  }

  // ---------- 草稿 ----------
  async createDraft(user: AuthUser, input: DocInput, opts: { memo?: string; sourceKey?: string } = {}, outer?: EntityManager) {
    this.need(user, 'finance.docs.create', '没有新建单据的权限');
    this.sanity(input);
    return this.tx(outer, async (em) => {
      if (opts.sourceKey) {
        const dup = await em.findOne(FinanceDocument, { where: { companyId: user.companyId, sourceKey: opts.sourceKey } });
        if (dup) return this.view(user, em, dup.id);
      }
      await this.checkRefs(em, user, input);
      const def = DOC_TYPE_MAP.get(input.type)!;
      const docNo = input.docNo?.trim() || await this.nextDocNo(em, user, def.prefix, input.date);
      const res = await em.insert(FinanceDocument, {
        companyId: user.companyId, docNo, docType: input.type, status: 'draft', docDate: input.date, partyId: input.partyId ?? null,
        partyKind: def.party ? input.partyKind ?? def.partyKinds[0] ?? null : null, paidCents: effectivePaid(def, input, docTotal(def, input)),
        handler: input.handler?.trim() || null, department: input.department?.trim() || null, settleBy: this.settleByOf(input),
        bankAccountId: input.bankAccountId ?? null, toBankAccountId: input.toBankAccountId ?? null, warehouseId: input.warehouseId ?? null,
        storeId: def.store ? input.storeId ?? null : null, refNo: hasBankRef(def) ? input.refNo?.trim() || null : null,
        amountCents: docTotal(def, input), offsetCents: input.offsetCents ?? 0, memo: opts.memo ?? null, sourceKey: opts.sourceKey ?? null, createdBy: user.id,
      });
      const id = Number(res.identifiers[0].id);
      if (def.bank === 'transfer') await em.update(FinanceDocument, { id }, this.transferHeads(input));
      await this.writeLines(em, user, id, input.lines ?? []);
      await this.writeAccounts(em, user, id, input);
      await this.writeSettlements(em, user, id, input);
      await this.event(em, user, id, 'create', opts.memo);
      return this.view(user, em, id);
    });
  }

  async updateDraft(user: AuthUser, id: number, input: DocInput, memo?: string) {
    this.need(user, 'finance.docs.create', '没有修改单据的权限');
    this.sanity(input);
    return this.dataSource.transaction(async (em) => {
      const { doc } = await this.load(em, user, id, true);
      if (doc.status !== 'draft') throw new ConflictException('只有草稿能修改；已开立的单据请先退回草稿');
      if (doc.docType !== input.type) throw new BadRequestException('不能改单据类型');
      await this.checkRefs(em, user, input, id);
      const def = DOC_TYPE_MAP.get(input.type)!;
      await em.update(FinanceDocument, { id, companyId: user.companyId }, {
        partyKind: def.party ? input.partyKind ?? def.partyKinds[0] ?? null : null, paidCents: effectivePaid(def, input, docTotal(def, input)),
        handler: input.handler?.trim() || null, department: input.department?.trim() || null, settleBy: this.settleByOf(input),
        ...(input.docNo?.trim() ? { docNo: input.docNo.trim() } : {}),
        docDate: input.date, partyId: input.partyId ?? null, bankAccountId: input.bankAccountId ?? null, toBankAccountId: input.toBankAccountId ?? null,
        warehouseId: input.warehouseId ?? null, storeId: def.store ? input.storeId ?? null : null, refNo: hasBankRef(def) ? input.refNo?.trim() || null : null,
        amountCents: docTotal(def, input), offsetCents: input.offsetCents ?? 0, memo: memo ?? doc.memo,
        ...(def.bank === 'transfer' ? this.transferHeads(input) : {}),
      });
      await this.writeLines(em, user, id, input.lines ?? []);
      await this.writeAccounts(em, user, id, input);
      await this.writeSettlements(em, user, id, input);
      await this.event(em, user, id, 'update');
      return this.view(user, em, id);
    });
  }

  async deleteDraft(user: AuthUser, id: number) {
    this.need(user, 'finance.docs.delete', '没有删除草稿的权限');
    await this.dataSource.transaction(async (em) => {
      const { doc } = await this.load(em, user, id, true);
      if (doc.status !== 'draft') throw new ConflictException('只有草稿能删除；已过账的单据请用红冲');
      await em.delete(FinanceDocumentEvent, { documentId: id, companyId: user.companyId });
      await em.delete(FinanceDocument, { id, companyId: user.companyId });
    });
    return { ok: true };
  }

  // ---------- 开立 / 退回 ----------
  async issue(user: AuthUser, id: number) {
    this.need(user, 'finance.docs.issue', '没有开立单据的权限');
    return this.dataSource.transaction(async (em) => {
      await this.issueIn(em, user, id);
      return this.view(user, em, id);
    });
  }

  private async issueIn(em: EntityManager, user: AuthUser, id: number) {
    const { doc, lines, accounts, settlements } = await this.load(em, user, id, true);
    if (doc.status !== 'draft') throw new ConflictException('只有草稿能开立');
    const input = this.toInput(doc, lines, accounts, settlements);
    const errors = validateDoc(input);
    if (errors.length) throw new BadRequestException(errors.join('；'));
    await this.checkRefs(em, user, input, id);
    await this.checkFeeObjects(em, user, lines);
    await this.checkSettlements(em, user, input, id);
    await em.update(FinanceDocument, { id, companyId: user.companyId }, { status: 'issued', issuedAt: new Date() });
    await this.event(em, user, id, 'issue');
  }

  async unissue(user: AuthUser, id: number, reason: string) {
    this.need(user, 'finance.docs.issue', '没有退回单据的权限');
    if (!reason?.trim()) throw new BadRequestException('退回草稿要写原因');
    return this.dataSource.transaction(async (em) => {
      const { doc } = await this.load(em, user, id, true);
      if (doc.status !== 'issued') throw new ConflictException('只有已开立（未过账）的单据能退回草稿');
      await em.update(FinanceDocument, { id, companyId: user.companyId }, { status: 'draft', issuedAt: null });
      await this.event(em, user, id, 'unissue', reason.trim());
      return this.view(user, em, id);
    });
  }

  // ---------- 过账 ----------
  async post(user: AuthUser, id: number, outer?: EntityManager) {
    this.need(user, 'finance.docs.post', '没有过账的权限');
    return this.tx(outer, async (em) => {
      await this.lockPosting(em, user);
      const first = await this.load(em, user, id, true);
      if (first.doc.status === 'draft') {
        this.need(user, 'finance.docs.issue', '这张单据还是草稿，开立需要开立权限');
        await this.issueIn(em, user, id);
      }
      const { doc, lines, accounts, settlements } = await this.load(em, user, id, true);
      if (doc.status !== 'issued') throw new ConflictException('单据状态不对，不能过账');
      const input = this.toInput(doc, lines, accounts, settlements);
      await this.checkSettlements(em, user, input, id);
      const def = DOC_TYPE_MAP.get(doc.docType as DocType)!;

      // 销售类：成本取明细上的成本单价，没有就取商品当前成本，并把用到的成本固定在明细上
      const costs = new Map<number, number | null>();
      if (['sale', 'online-sale', 'sale-return'].includes(def.type)) {
        const ids = [...new Set(lines.map((l) => l.productId).filter((x): x is number => !!x))];
        for (const p of await em.find(ResourceRecord, { where: { companyId: user.companyId, type: 'finance-products', id: In(ids) } })) {
          costs.set(p.id, typeof p.data.totalCost === 'number' ? p.data.totalCost : null);
        }
      }
      let entries: Entry[];
      try {
        entries = buildEntries(input, (pid) => costs.get(pid) ?? null);
      } catch (e) {
        if ((e as Error).message === 'COST_MISSING') {
          const missing = lines.find((l) => l.productId && l.unitCostCents === null && costs.get(l.productId) == null);
          const t = missing?.productId ? await em.findOne(ResourceRecord, { where: { id: missing.productId, companyId: user.companyId } }) : null;
          throw new BadRequestException(`商品「${t?.title ?? ''}」还没有成本，销售成本算不出来。请先在商品档案填成本，或在明细里填成本单价`);
        }
        throw new BadRequestException((e as Error).message);
      }
      if (def.type === 'sale' || def.type === 'online-sale' || def.type === 'sale-return') {
        for (const l of lines) if (l.productId && l.unitCostCents === null) await em.update(FinanceDocumentLine, { id: l.id }, { unitCostCents: costs.get(l.productId) ?? null });
      }
      await this.guard(em, user, entries, doc);
      await this.writeEntries(em, user, id, doc.docDate, entries);
      await em.update(FinanceDocument, { id, companyId: user.companyId }, { status: 'posted', postedAt: new Date() });
      await this.event(em, user, id, 'post');
      return this.view(user, em, id);
    });
  }

  /** 期初登记只能用于已开立的手工供应商预付单，独立于普通过账权限。 */
  private openingCandidate(doc: FinanceDocument) {
    if (doc.docType !== 'prepayment' || doc.partyKind !== 'supplier' || !doc.partyId) throw new BadRequestException('只能登记供应商预付款单');
    if (doc.sourceKey !== null || doc.reversesId) throw new BadRequestException('只能登记手工来源的原始单据');
    if (doc.status !== 'issued') throw new ConflictException('只有已开立、未过账的单据能登记已有预付款余额');
    if (!Number.isSafeInteger(doc.amountCents) || doc.amountCents <= 0) throw new BadRequestException('登记金额必须为大于 0 的整数分');
  }

  async checkOpeningPrepayment(user: AuthUser, id: number) {
    this.need(user, OPENING_PREPAYMENT_PERMISSION, '没有登记已有预付款余额的权限');
    const { doc } = await this.load(this.dataSource.manager, user, id);
    if (!this.canSee(user, doc.docType)) throw new ForbiddenException('没有查看单据的权限');
    this.openingCandidate(doc);
  }

  async openingVoucher(user: AuthUser, id: number, fileId: number) {
    const { doc } = await this.load(this.dataSource.manager, user, id);
    if (!this.canSee(user, doc.docType)) throw new ForbiddenException('没有查看单据的权限');
    const file = await this.dataSource.manager.findOne(ResourceFile, { where: { id: fileId, companyId: user.companyId, resourceType: OPENING_VOUCHER_TYPE, resourceId: id, fieldKey: 'voucher' } });
    if (!file) throw new NotFoundException('凭证不存在');
    return file;
  }

  async registerOpeningPrepayment(user: AuthUser, id: number, input: OpeningPrepaymentInput) {
    this.need(user, OPENING_PREPAYMENT_PERMISSION, '没有登记已有预付款余额的权限');
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!reason || input.reason.length > 500) throw new BadRequestException('核对说明必填，且不能超过 500 字');
    if (input.confirmed !== true) throw new BadRequestException('请确认款项已在系统上线前付出，本次不扣银行余额');
    const ids = input.fileIds;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 10 || ids.some((v) => !Number.isSafeInteger(v) || v <= 0) || new Set(ids).size !== ids.length) throw new BadRequestException('请提供 1–10 个不重复的凭证附件');
    return this.dataSource.transaction(async (em) => {
      await this.lockPosting(em, user);
      const { doc, lines, accounts, settlements } = await this.load(em, user, id, true);
      if (!this.canSee(user, doc.docType)) throw new ForbiddenException('没有查看单据的权限');
      this.openingCandidate(doc);
      await this.checkRefs(em, user, this.toInput(doc, lines, accounts, settlements), id);
      if (await em.count(FinanceEntry, { where: { companyId: user.companyId, documentId: id } })) throw new ConflictException('这张单据已经入账，不能重复登记');
      const files = await em.find(ResourceFile, { where: { companyId: user.companyId, id: In(ids) }, lock: { mode: 'pessimistic_write' } });
      if (files.length !== ids.length || files.some((f) => f.resourceType !== OPENING_VOUCHER_TYPE || f.fieldKey !== 'voucher' || f.resourceId !== null || f.uploadedBy !== user.id || f.size <= 0 || f.size > 10 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'].includes(f.mime))) throw new BadRequestException('凭证无效、已被占用或不属于当前上传人，请重新上传');
      await em.update(ResourceFile, { companyId: user.companyId, id: In(ids) }, { resourceId: id });
      await this.writeEntries(em, user, id, doc.docDate, [
        { kind: 'prepayment', accountId: doc.partyId!, subId: 0, amount: doc.amountCents, qty: null },
        { kind: 'opening', accountId: 0, subId: 0, amount: -doc.amountCents, qty: null },
      ]);
      await em.update(FinanceDocument, { id, companyId: user.companyId }, { status: 'posted', postedAt: new Date(), paidCents: 0 });
      await this.event(em, user, id, 'opening-prepay', reason);
      await em.insert(AuditLog, { companyId: user.companyId, actorId: user.id, action: 'finance.opening-prepayment', resourceType: 'finance-document', resourceId: String(id), detail: { reason, fileIds: ids, amountCents: doc.amountCents, supplierId: doc.partyId! } });
      return this.view(user, em, id);
    });
  }

  private async writeEntries(em: EntityManager, user: AuthUser, documentId: number, date: string, entries: Entry[]) {
    for (const e of entries) {
      await em.insert(FinanceEntry, { companyId: user.companyId, documentId, entryDate: date, kind: e.kind, accountId: e.accountId, subId: e.subId, amountCents: e.amount, qty: e.qty });
    }
  }

  /** 过账前检查：库存不能为负；预收/预付冲抵不能超过余额。 */
  private async guard(em: EntityManager, user: AuthUser, entries: Entry[], doc: FinanceDocument) {
    const stock = new Map<string, { productId: number; wh: number; qty: number }>();
    for (const e of entries) if (e.kind === 'inventory' && e.qty) {
      const k = `${e.accountId}:${e.subId}`;
      const cur = stock.get(k) ?? { productId: e.accountId, wh: e.subId, qty: 0 };
      cur.qty += e.qty;
      stock.set(k, cur);
    }
    for (const s of stock.values()) {
      if (s.qty >= 0) continue;
      const [row] = await em.query("SELECT COALESCE(SUM(qty), 0) AS q FROM finance_entries WHERE company_id = ? AND kind = 'inventory' AND account_id = ? AND sub_id = ?", [user.companyId, s.productId, s.wh]);
      if (Number(row.q) + s.qty < -1e-9) {
        const p = await em.findOne(ResourceRecord, { where: { id: s.productId, companyId: user.companyId } });
        throw new BadRequestException(`库存不够：「${p?.title ?? s.productId}」现有 ${Number(row.q)}，这张单要出 ${-s.qty}（库存不允许为负）`);
      }
    }
    for (const [kind, sign, label] of [['advance_receipt', -1, '预收款'], ['prepayment', 1, '预付款']] as const) {
      const net = new Map<number, number>();
      for (const e of entries) if (e.kind === kind) net.set(e.accountId, (net.get(e.accountId) ?? 0) + e.amount * sign);
      for (const [party, delta] of net) {
        if (delta >= 0) continue; // 只检查会减少余额的
        const [row] = await em.query('SELECT COALESCE(SUM(amount_cents), 0) AS a FROM finance_entries WHERE company_id = ? AND kind = ? AND account_id = ?', [user.companyId, kind, party]);
        if (Number(row.a) * sign + delta < 0) throw new BadRequestException(`${label}余额不够：现有 ${(Number(row.a) * sign) / 100} 元，这张单要冲 ${-delta / 100} 元`);
      }
    }
    void doc;
  }

  // ---------- 红冲 ----------
  async reverse(user: AuthUser, id: number, reason: string, outer?: EntityManager) {
    this.need(user, 'finance.docs.reverse', '没有红冲的权限');
    if (!reason?.trim()) throw new BadRequestException('红冲要写原因');
    return this.tx(outer, async (em) => {
      await this.lockPosting(em, user);
      const { doc, lines, accounts } = await this.load(em, user, id, true);
      if (doc.status !== 'posted') throw new ConflictException('只有已过账的单据能红冲');
      if (doc.reversesId) throw new ConflictException('红冲单本身不能再红冲，需要的话请重新制一张正常单据');
      if (doc.auditedAt) throw new ConflictException('这张单据已经财务审核，不能再红冲；需要的话先取消财务审核');
      const used = await em.query("SELECT DISTINCT d.doc_no AS no FROM finance_document_settlements s JOIN finance_documents d ON d.id = s.document_id WHERE s.company_id = ? AND s.source_document_id = ? AND d.status IN ('issued','posted')", [user.companyId, id]);
      if (used.length) throw new ConflictException(`这张单据已经被 ${used.map((x: { no: string }) => x.no).join('、')} 结算，不能红冲；请先红冲那张收付款单`);
      const original = await em.find(FinanceEntry, { where: { documentId: id, companyId: user.companyId }, order: { id: 'ASC' } });
      const neg = negateEntries(original.map((e) => ({ kind: e.kind as Entry['kind'], accountId: e.accountId, subId: e.subId, amount: e.amountCents, qty: e.qty })));
      await this.guard(em, user, neg, doc);
      const def = DOC_TYPE_MAP.get(doc.docType as DocType)!;
      const docNo = await this.nextDocNo(em, user, def.prefix, today());
      const res = await em.insert(FinanceDocument, {
        companyId: user.companyId, docNo, docType: doc.docType, status: 'posted', docDate: today(), partyId: doc.partyId, bankAccountId: doc.bankAccountId,
        toBankAccountId: doc.toBankAccountId, warehouseId: doc.warehouseId, amountCents: -doc.amountCents, offsetCents: -doc.offsetCents, paidCents: -doc.paidCents, partyKind: doc.partyKind, handler: doc.handler, department: doc.department,
        memo: `红冲 ${doc.docNo}：${reason.trim()}`, reversesId: id, createdBy: user.id, issuedAt: new Date(), postedAt: new Date(),
      });
      const rid = Number(res.identifiers[0].id);
      let n = 0;
      for (const l of lines) {
        await em.insert(FinanceDocumentLine, { companyId: user.companyId, documentId: rid, lineNo: ++n, productId: l.productId, feeItemId: l.feeItemId, qty: -l.qty, unitPriceCents: l.unitPriceCents, unitCostCents: l.unitCostCents, memo: l.memo, itemName: l.itemName, unit: l.unit, relatedNode: l.relatedNode, relatedId: l.relatedId, relatedName: l.relatedName });
      }
      for (const a of accounts) await em.insert(FinanceDocumentAccount, { companyId: user.companyId, documentId: rid, role: a.role, bankAccountId: a.bankAccountId, amountCents: -a.amountCents });
      await this.writeEntries(em, user, rid, today(), neg);
      await em.update(FinanceDocument, { id, companyId: user.companyId }, { status: 'reversed', reversedById: rid });
      await this.event(em, user, id, 'reverse', reason.trim());
      await this.event(em, user, rid, 'post', `红冲 ${doc.docNo}`);
      return this.view(user, em, rid);
    });
  }

  // ---------- 经营历程：改表头 / 财务审核 / 复制为草稿 ----------
  /** 已过账单据只允许改日期、经手人、说明（不动账）；财务审核后不能改。日期改了，分录日期跟着改。 */
  async editHeader(user: AuthUser, id: number, patch: { date?: string; handler?: string | null; memo?: string | null }) {
    this.need(user, 'finance.docs.edit-header', '没有修改已过账单据表头的权限');
    if (patch.date !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(patch.date) || Number.isNaN(Date.parse(patch.date)))) throw new BadRequestException('单据日期格式应为 YYYY-MM-DD');
    return this.dataSource.transaction(async (em) => {
      await this.lockPosting(em, user);
      const { doc } = await this.load(em, user, id, true);
      if (doc.status !== 'posted') throw new ConflictException('只有已过账的单据能这样改；草稿请直接编辑');
      if (doc.auditedAt) throw new ConflictException('这张单据已经财务审核，不能再修改');
      const set: Partial<FinanceDocument> = {};
      if (patch.date !== undefined) set.docDate = patch.date;
      if (patch.handler !== undefined) set.handler = patch.handler?.trim() || null;
      if (patch.memo !== undefined) set.memo = patch.memo?.trim() || null;
      await em.update(FinanceDocument, { id, companyId: user.companyId }, set);
      if (set.docDate) await em.update(FinanceEntry, { documentId: id, companyId: user.companyId }, { entryDate: set.docDate });
      await this.event(em, user, id, 'edit-header', Object.keys(set).join('、'));
      return this.view(user, em, id);
    });
  }

  async audit(user: AuthUser, id: number, on: boolean) {
    this.need(user, 'finance.docs.audit', '没有财务审核的权限');
    return this.dataSource.transaction(async (em) => {
      const { doc } = await this.load(em, user, id, true);
      if (doc.status !== 'posted') throw new ConflictException('只有已过账的单据能财务审核');
      if (doc.reversesId) throw new ConflictException('红冲单不用财务审核');
      if (on === !!doc.auditedAt) throw new ConflictException(on ? '这张单据已经审核过了' : '这张单据还没有财务审核');
      await em.update(FinanceDocument, { id, companyId: user.companyId }, on ? { auditedBy: user.id, auditedAt: new Date() } : { auditedBy: null, auditedAt: null });
      await this.event(em, user, id, on ? 'audit' : 'unaudit');
      return this.view(user, em, id);
    });
  }

  /** 把任何一张单据（含已过账的）复制成一张新草稿，日期取今天，单号重新生成。用来“改错单”。 */
  async copyAsDraft(user: AuthUser, id: number) {
    this.need(user, 'finance.docs.create', '没有新建单据的权限');
    return this.dataSource.transaction(async (em) => {
      const { doc, lines, accounts, settlements } = await this.load(em, user, id);
      if (!this.canSee(user, doc.docType)) throw new ForbiddenException('没有查看这种单据的权限');
      if (doc.reversesId) throw new BadRequestException('红冲单不能复制');
      const def = DOC_TYPE_MAP.get(doc.docType as DocType)!;
      const input = this.toInput(doc, lines, accounts, settlements);
      input.date = today();
      input.refNo = null; // 提现流水号不能重复
      input.paidCents = doc.paidCents;
      const docNo = await this.nextDocNo(em, user, def.prefix, input.date);
      const res = await em.insert(FinanceDocument, {
        companyId: user.companyId, docNo, docType: doc.docType, status: 'draft', docDate: input.date, partyId: doc.partyId, partyKind: doc.partyKind, paidCents: doc.paidCents,
        handler: doc.handler, department: doc.department, bankAccountId: doc.bankAccountId, toBankAccountId: doc.toBankAccountId, warehouseId: doc.warehouseId,
        storeId: doc.storeId, refNo: null, amountCents: doc.amountCents, offsetCents: doc.offsetCents, settleBy: doc.settleBy, memo: doc.memo, createdBy: user.id,
      });
      const nid = Number(res.identifiers[0].id);
      await this.writeLines(em, user, nid, lines.map((l) => ({ productId: l.productId, feeItemId: l.feeItemId, qty: l.qty, unitPriceCents: l.unitPriceCents, unitCostCents: null, memo: l.memo ?? undefined, relatedNode: l.relatedNode, relatedId: l.relatedId, relatedName: l.relatedName, itemName: l.itemName, unit: l.unit })));
      await this.writeAccounts(em, user, nid, input);
      await this.writeSettlements(em, user, nid, input);
      await this.event(em, user, nid, 'create', `复制自 ${doc.docNo}`);
      return this.view(user, em, nid);
    });
  }

  /** 批量过账 / 批量删除：逐张处理，一张失败不影响别的，返回每张的结果。 */
  async batch(user: AuthUser, action: 'post' | 'delete' | 'copy', ids: number[]) {
    if (!ids.length) throw new BadRequestException('请先勾选单据');
    if (ids.length > 100) throw new BadRequestException('一次最多处理 100 张');
    const results: Array<{ id: number; ok: boolean; docNo?: string; error?: string }> = [];
    for (const id of ids) {
      const row = await this.dataSource.manager.findOne(FinanceDocument, { where: { id, companyId: user.companyId }, select: ['id', 'docNo'] });
      try {
        if (action === 'post') await this.post(user, id);
        else if (action === 'delete') await this.deleteDraft(user, id);
        else await this.copyAsDraft(user, id);
        results.push({ id, ok: true, docNo: row?.docNo });
      } catch (e) {
        results.push({ id, ok: false, docNo: row?.docNo, error: (e as Error).message });
      }
    }
    return { results, okCount: results.filter((r) => r.ok).length, failCount: results.filter((r) => !r.ok).length };
  }

  // ---------- 查看 ----------
  private async names(em: EntityManager, companyId: number, ids: Array<number | null | undefined>) {
    const list = [...new Set(ids.filter((x): x is number => !!x))];
    if (!list.length) return new Map<number, string>();
    const rows = await em.find(ResourceRecord, { where: { companyId, id: In(list) }, select: ['id', 'title'] });
    return new Map(rows.map((r) => [r.id, r.title]));
  }

  private async view(user: AuthUser, em: EntityManager, id: number) {
    const { doc, lines, accounts, settlements } = await this.load(em, user, id);
    const entries = await em.find(FinanceEntry, { where: { documentId: id, companyId: user.companyId }, order: { id: 'ASC' } });
    const events = await em.find(FinanceDocumentEvent, { where: { documentId: id, companyId: user.companyId }, order: { id: 'ASC' } });
    const names = await this.names(em, user.companyId, [doc.partyId, doc.storeId, doc.bankAccountId, doc.toBankAccountId, doc.warehouseId, ...accounts.map((a) => a.bankAccountId), ...settlements.map((x) => x.productId), ...lines.flatMap((l) => [l.productId, l.feeItemId]), ...entries.map((e) => e.accountId), ...events.map((e) => e.actorId)]);
    const canCost = this.can(user, COST_VIEW);
    const [actors] = [await em.query('SELECT id, name FROM users WHERE company_id = ? AND id IN (?)', [user.companyId, [...new Set([doc.createdBy, ...events.map((e) => e.actorId)])]])];
    const actorName = new Map<number, string>(actors.map((a: { id: number; name: string }) => [a.id, a.name]));
    return {
      ...doc,
      openingVouchers: (await em.find(ResourceFile, { where: { companyId: user.companyId, resourceType: OPENING_VOUCHER_TYPE, resourceId: id, fieldKey: 'voucher' }, order: { id: 'ASC' } })).map((f) => ({ id: f.id, name: f.name, mime: f.mime, size: f.size })),
      typeLabel: DOC_TYPE_MAP.get(doc.docType as DocType)?.label ?? doc.docType,
      partyName: doc.partyId ? names.get(doc.partyId) ?? '' : '', storeName: doc.storeId ? names.get(doc.storeId) ?? '' : '', bankName: doc.bankAccountId ? names.get(doc.bankAccountId) ?? '' : '',
      toBankName: doc.toBankAccountId ? names.get(doc.toBankAccountId) ?? '' : '', warehouseName: doc.warehouseId ? names.get(doc.warehouseId) ?? '' : '',
      createdByName: actorName.get(doc.createdBy) ?? '',
      accounts: accounts.map((a) => ({ ...a, bankName: names.get(a.bankAccountId) ?? '' })),
      settleByLabel: doc.settleBy ? SETTLE_BY_LABEL[doc.settleBy as SettleBy] : null,
      settlements: await this.settlementRows(em, user, settlements, names),
      settledBy: await this.settledBy(em, user, id),
      lines: lines.map((l) => ({ ...l, productName: l.productId ? names.get(l.productId) ?? '' : '', feeItemName: l.feeItemId ? names.get(l.feeItemId) ?? '' : '', unitCostCents: canCost ? l.unitCostCents : null })),
      // 成本类分录（销售成本、库存金额）只给有成本权限的人看
      entries: entries.filter((e) => canCost || e.kind !== 'cogs').map((e) => ({ ...e, accountName: e.accountId ? names.get(e.accountId) ?? '' : '', amountCents: !canCost && e.kind === 'inventory' ? null : e.amountCents })),
      events: events.map((e) => ({ ...e, actorName: actorName.get(e.actorId) ?? '' })),
    };
  }

  private async settlementRows(em: EntityManager, user: AuthUser, settlements: FinanceDocumentSettlement[], names: Map<number, string>) {
    if (!settlements.length) return [];
    const src = await em.find(FinanceDocument, { where: { companyId: user.companyId, id: In(settlements.map((x) => x.sourceDocumentId)) } });
    const m = new Map(src.map((d) => [d.id, d]));
    return settlements.map((x) => {
      const d = m.get(x.sourceDocumentId);
      return { id: x.id, sourceDocId: x.sourceDocumentId, sourceDocNo: d?.docNo ?? '', sourceType: d?.docType ?? '', sourceTypeLabel: DOC_TYPE_MAP.get((d?.docType ?? '') as DocType)?.label ?? '', productId: x.productId, productName: x.productId ? names.get(x.productId) ?? '' : '', amountCents: x.amountCents };
    });
  }

  /** 这张单据被哪些收付款单结算过（开立和已过账的） */
  private async settledBy(em: EntityManager, user: AuthUser, id: number) {
    const rows = await em.query(
      "SELECT d.id, d.doc_no AS docNo, d.doc_type AS docType, d.status, SUM(s.amount_cents) AS amountCents FROM finance_document_settlements s JOIN finance_documents d ON d.id = s.document_id WHERE s.company_id = ? AND s.source_document_id = ? AND d.status IN ('issued','posted') GROUP BY d.id, d.doc_no, d.doc_type, d.status ORDER BY d.id",
      [user.companyId, id]);
    return (rows as { id: number; docNo: string; docType: string; status: string; amountCents: string }[]).map((r) => ({ ...r, amountCents: Number(r.amountCents) }));
  }

  /** 可结算的单据：这个往来对象名下、已过账、还有没结算余额的单据（收款单看销售类，付款单看采购类）；按商品结算还带每个商品的未结算金额 */
  async openItems(user: AuthUser, q: { dir: 'in' | 'out'; partyKind: string; partyId: number }) {
    this.need(user, 'finance.docs.create', '没有制单的权限');
    const em = this.dataSource.manager;
    const types = DOC_TYPES.filter((d) => d.settle === q.dir).map((d) => d.type);
    const docs = await em.find(FinanceDocument, { where: { companyId: user.companyId, status: 'posted', partyId: q.partyId, partyKind: q.partyKind, docType: In(types) }, order: { docDate: 'ASC', id: 'ASC' }, take: 500 });
    const open = await this.openAmounts(em, user, docs.map((d) => d.id));
    const lines = docs.length ? await em.find(FinanceDocumentLine, { where: { companyId: user.companyId, documentId: In(docs.map((d) => d.id)) }, order: { lineNo: 'ASC' } }) : [];
    const names = await this.names(em, user.companyId, lines.map((l) => l.productId));
    return docs.filter((d) => !d.reversesId).map((d) => {
      const o = open.get(d.id)!;
      const byProd = new Map<number, { productId: number; productName: string; amountCents: number; outstandingCents: number }>();
      for (const l of lines.filter((x) => x.documentId === d.id && x.productId)) {
        const cur = byProd.get(l.productId as number) ?? { productId: l.productId as number, productName: names.get(l.productId as number) ?? '', amountCents: 0, outstandingCents: 0 };
        cur.amountCents += lineAmount(l);
        byProd.set(l.productId as number, cur);
      }
      for (const p of byProd.values()) p.outstandingCents = Math.max(0, p.amountCents - (o.byProduct.get(p.productId) ?? 0));
      return { id: d.id, docNo: d.docNo, docType: d.docType, typeLabel: DOC_TYPE_MAP.get(d.docType as DocType)?.label ?? d.docType, docDate: d.docDate, amountCents: d.amountCents, paidCents: d.paidCents, offsetCents: d.offsetCents, outstandingCents: o.outstanding, products: [...byProd.values()] };
    }).filter((r) => r.outstandingCents > 0);
  }

  /** 收付款结算明细表：每一笔“收付款单 → 被结算单据（商品）”的分配 */
  async settlementDetail(user: AuthUser, q: { from?: string; to?: string; partyId?: number; docType?: string }) {
    if (!this.canSee(user, 'receipt') && !this.canSee(user, 'payment')) throw new ForbiddenException('没有查看收付款单的权限');
    const where = ["s.company_id = ?", "d.status = 'posted'"];
    const args: unknown[] = [user.companyId];
    if (q.from) { where.push('d.doc_date >= ?'); args.push(q.from); }
    if (q.to) { where.push('d.doc_date <= ?'); args.push(q.to); }
    if (q.partyId) { where.push('d.party_id = ?'); args.push(q.partyId); }
    if (q.docType === 'receipt' || q.docType === 'payment') { where.push('d.doc_type = ?'); args.push(q.docType); }
    const rows = await this.dataSource.query(
      `SELECT s.id, d.id AS docId, d.doc_no AS docNo, d.doc_type AS docType, d.doc_date AS docDate, d.party_id AS partyId, d.settle_by AS settleBy, src.id AS sourceDocId, src.doc_no AS sourceDocNo, src.doc_type AS sourceType, s.product_id AS productId, s.amount_cents AS amountCents
         FROM finance_document_settlements s JOIN finance_documents d ON d.id = s.document_id JOIN finance_documents src ON src.id = s.source_document_id
        WHERE ${where.join(' AND ')} ORDER BY d.doc_date DESC, d.id DESC, s.id LIMIT 500`, args);
    const names = await this.names(this.dataSource.manager, user.companyId, rows.flatMap((r: { partyId: number | null; productId: number | null }) => [r.partyId, r.productId]));
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      ...r, amountCents: Number(r.amountCents), partyName: r.partyId ? names.get(Number(r.partyId)) ?? '' : '', productName: r.productId ? names.get(Number(r.productId)) ?? '' : '',
      typeLabel: DOC_TYPE_MAP.get(r.docType as DocType)?.label ?? r.docType, sourceTypeLabel: DOC_TYPE_MAP.get(r.sourceType as DocType)?.label ?? r.sourceType,
      settleByLabel: r.settleBy ? SETTLE_BY_LABEL[r.settleBy as SettleBy] : '',
    }));
  }

  /** 未完全结算的收付款单：已过账的收款单/付款单，本次结算金额还有没分给单据的部分（按金额结算的整张都算没分配） */
  async unsettledReceipts(user: AuthUser, q: { from?: string; to?: string; partyId?: number; docType?: string }) {
    if (!this.canSee(user, 'receipt') && !this.canSee(user, 'payment')) throw new ForbiddenException('没有查看收付款单的权限');
    const where = ["d.company_id = ?", "d.status = 'posted'", 'd.reverses_id IS NULL', "d.doc_type IN ('receipt','payment')"];
    const args: unknown[] = [user.companyId];
    if (q.from) { where.push('d.doc_date >= ?'); args.push(q.from); }
    if (q.to) { where.push('d.doc_date <= ?'); args.push(q.to); }
    if (q.partyId) { where.push('d.party_id = ?'); args.push(q.partyId); }
    if (q.docType === 'receipt' || q.docType === 'payment') { where.push('d.doc_type = ?'); args.push(q.docType); }
    const rows = await this.dataSource.query(
      `SELECT d.id, d.doc_no AS docNo, d.doc_type AS docType, d.doc_date AS docDate, d.party_id AS partyId, d.settle_by AS settleBy, d.amount_cents + d.offset_cents AS totalCents,
              COALESCE((SELECT SUM(s.amount_cents) FROM finance_document_settlements s WHERE s.document_id = d.id), 0) AS allocatedCents
         FROM finance_documents d WHERE ${where.join(' AND ')} ORDER BY d.doc_date DESC, d.id DESC LIMIT 1000`, args);
    const names = await this.names(this.dataSource.manager, user.companyId, rows.map((r: { partyId: number | null }) => r.partyId));
    return (rows as Array<{ id: number; docNo: string; docType: string; docDate: string; partyId: number | null; settleBy: string | null; totalCents: string; allocatedCents: string }>)
      .map((r) => ({ id: r.id, docNo: r.docNo, docType: r.docType, typeLabel: DOC_TYPE_MAP.get(r.docType as DocType)?.label ?? r.docType, docDate: r.docDate, partyName: r.partyId ? names.get(r.partyId) ?? '' : '',
        settleByLabel: r.settleBy ? SETTLE_BY_LABEL[r.settleBy as SettleBy] : SETTLE_BY_LABEL.amount, totalCents: Number(r.totalCents), allocatedCents: Number(r.allocatedCents), unallocatedCents: Number(r.totalCents) - Number(r.allocatedCents) }))
      .filter((r) => r.unallocatedCents > 0);
  }

  async get(user: AuthUser, id: number) {
    const row = await this.dataSource.manager.findOne(FinanceDocument, { where: { id, companyId: user.companyId }, select: ['id', 'docType'] });
    if (!row) throw new NotFoundException('单据不存在');
    if (!this.canSee(user, row.docType)) throw new ForbiddenException('没有查看这种单据的权限');
    return this.view(user, this.dataSource.manager, id);
  }

  async list(user: AuthUser, q: ListQuery) {
    const isType = DOC_TYPE_MAP.has(q.scope as DocType);
    if (q.scope === 'drafts') this.need(user, 'finance.drafts.view', '没有查看草稿中心的权限');
    else if (q.scope === 'history') this.need(user, 'finance.history.view', '没有查看经营历程的权限');
    else if (isType) this.need(user, `finance.doc-${q.scope}.view`, '没有查看这种单据的权限');
    else throw new BadRequestException('范围不对');
    const where: string[] = ['d.company_id = ?'];
    const args: unknown[] = [user.companyId];
    if (q.scope === 'drafts') where.push("d.status IN ('draft','issued')");
    else if (q.scope === 'history') where.push("d.status IN ('posted','reversed')");
    else { where.push('d.doc_type = ?'); args.push(q.scope); }
    if (q.status) { where.push('d.status = ?'); args.push(q.status); }
    if (q.creatorId) { where.push('d.created_by = ?'); args.push(q.creatorId); }
    if (q.audited === 'yes') where.push('d.audited_at IS NOT NULL'); else if (q.audited === 'no') where.push('d.audited_at IS NULL');
    if (q.docType && DOC_TYPE_MAP.has(q.docType as DocType) && !isType) {
      if (!this.canSee(user, q.docType)) throw new ForbiddenException('没有查看这种单据的权限');
      where.push('d.doc_type = ?'); args.push(q.docType);
    }
    if (q.direction) {
      const types = docTypesOfDirection(q.direction);
      where.push(`d.doc_type IN (${types.map(() => '?').join(',')})`); args.push(...types);
    }
    if (q.from) { where.push('d.doc_date >= ?'); args.push(q.from); }
    if (q.to) { where.push('d.doc_date <= ?'); args.push(q.to); }
    if (q.keyword?.trim()) { where.push('(d.doc_no LIKE ? OR d.memo LIKE ? OR d.ref_no LIKE ?)'); args.push(`%${q.keyword.trim()}%`, `%${q.keyword.trim()}%`, `%${q.keyword.trim()}%`); }
    const w = where.join(' AND ');
    const inTypes = docTypesOfDirection('in'), outTypes = docTypesOfDirection('out');
    const [{ n, amt, paid, inc, exp }] = await this.dataSource.query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(d.amount_cents),0) AS amt, COALESCE(SUM(d.paid_cents),0) AS paid,
              COALESCE(SUM(CASE WHEN d.doc_type IN (${inTypes.map(() => '?').join(',')}) THEN d.amount_cents ELSE 0 END),0) AS inc,
              COALESCE(SUM(CASE WHEN d.doc_type IN (${outTypes.map(() => '?').join(',')}) THEN d.amount_cents ELSE 0 END),0) AS exp
       FROM finance_documents d WHERE ${w}`, [...inTypes, ...outTypes, ...args]);
    let todayCount: number | undefined;
    if (q.scope === 'drafts') {
      const [{ c }] = await this.dataSource.query(`SELECT COUNT(*) AS c FROM finance_documents d WHERE ${w} AND DATE(d.created_at) = ?`, [...args, today()]);
      todayCount = Number(c);
    }
    const rows = await this.dataSource.query(
      `SELECT d.id, d.doc_no AS docNo, d.doc_type AS docType, d.status, DATE_FORMAT(d.doc_date, '%Y-%m-%d') AS docDate, d.amount_cents AS amountCents, d.memo, d.reverses_id AS reversesId,
              p.title AS partyName, u.name AS createdByName, d.handler, d.paid_cents AS paidCents, d.audited_at AS auditedAt, d.created_by AS createdBy, b.title AS bankName,
              d.source_key AS sourceKey, d.ref_no AS refNo
       FROM finance_documents d LEFT JOIN resource_records p ON p.id = d.party_id AND p.company_id = d.company_id LEFT JOIN resource_records b ON b.id = d.bank_account_id AND b.company_id = d.company_id LEFT JOIN users u ON u.id = d.created_by
       WHERE ${w} ORDER BY d.doc_date DESC, d.id DESC LIMIT ? OFFSET ?`,
      [...args, q.pageSize, (q.page - 1) * q.pageSize],
    );
    return {
      total: Number(n), amountCents: Number(amt), paidCents: Number(paid), incomeCents: Number(inc), expenseCents: Number(exp), ...(todayCount === undefined ? {} : { todayCount }), page: q.page, pageSize: q.pageSize,
      rows: rows.map(({ sourceKey, ...r }: Record<string, unknown>) => ({
        ...r, amountCents: Number(r.amountCents), paidCents: Number(r.paidCents), typeLabel: DOC_TYPE_MAP.get(r.docType as DocType)?.label ?? r.docType,
        direction: DOC_DIRECTION[r.docType as DocType] ?? 'internal', source: sourceLabel(sourceKey as string | null),
      })),
    };
  }

  // ---------- 实时查询 ----------
  /**
   * 银行账户余额。除了余额，还带：所属主体（营业执照）、关联店铺（账户资料里选的店铺 + 手动关联）、保管人、
   * 余额最后更新时间（资料登记时间和最近一笔已过账流水取较晚者），页面按新旧着色。
   */
  async bankBalances(user: AuthUser) {
    this.need(user, 'finance.cash-bank.view', '没有查看现金银行的权限');
    const accounts = await this.dataSource.manager.find(ResourceRecord, { where: { companyId: user.companyId, type: 'bank-accounts' } });
    const sums = await this.dataSource.query(
      "SELECT e.account_id AS id, SUM(e.amount_cents) AS s, COUNT(*) AS n, MAX(d.posted_at) AS lastAt FROM finance_entries e JOIN finance_documents d ON d.id = e.document_id WHERE e.company_id = ? AND e.kind = 'bank' GROUP BY e.account_id", [user.companyId]);
    const m = new Map<number, { s: number; n: number; lastAt: Date | null }>(sums.map((r: { id: number; s: string; n: string; lastAt: Date | null }) => [Number(r.id), { s: Number(r.s), n: Number(r.n), lastAt: r.lastAt }]));
    const shown = accounts.filter((a) => a.status !== 'inactive' || m.has(a.id));
    // 关联：账户资料里的“关联店铺”、手动关联（任意方向）
    const links: Array<{ sourceType: string; sourceId: number; targetType: string; targetId: number }> = await this.dataSource.query(
      "SELECT source_type AS sourceType, source_id AS sourceId, target_type AS targetType, target_id AS targetId FROM resource_links WHERE company_id = ? AND ((source_type = 'bank-accounts' AND target_type = 'stores') OR (source_type = 'stores' AND target_type = 'bank-accounts'))", [user.companyId]);
    const storesOf = new Map<number, Set<number>>();
    const addLink = (acc: number, st: number) => { if (st > 0) storesOf.set(acc, (storesOf.get(acc) ?? new Set()).add(st)); };
    for (const a of shown) addLink(a.id, Number(a.data.storeId));
    for (const l of links) { if (l.sourceType === 'bank-accounts') addLink(l.sourceId, l.targetId); else addLink(l.targetId, l.sourceId); }
    // 账户资料里登记的“账户店铺”（多店铺 + 用途）
    for (const r of await this.dataSource.manager.find(ResourceRecord, { where: { companyId: user.companyId, type: 'bank-store-links' }, select: ['id', 'status', 'data'] })) {
      if (r.status !== 'inactive') addLink(Number(r.data.bankAccountId), Number(r.data.storeId));
    }
    const refIds = new Set<number>();
    for (const a of shown) { if (Number(a.data.licenseId) > 0) refIds.add(Number(a.data.licenseId)); if (Number(a.data.keeperUserId) > 0) refIds.add(-Number(a.data.keeperUserId)); }
    const titleIds = [...refIds].filter((x) => x > 0);
    const storeIds = [...new Set([...storesOf.values()].flatMap((x) => [...x]))];
    const titles = new Map<number, string>();
    const idList = [...new Set([...titleIds, ...storeIds])];
    if (idList.length) for (const r of await this.dataSource.manager.find(ResourceRecord, { where: { companyId: user.companyId, id: In(idList) }, select: ['id', 'title'] })) titles.set(r.id, r.title);
    const userIds = [...refIds].filter((x) => x < 0).map((x) => -x);
    const userNames = new Map<number, string>();
    if (userIds.length) for (const u of await this.dataSource.query(`SELECT id, name FROM users WHERE company_id = ? AND id IN (${userIds.map(() => '?').join(',')})`, [user.companyId, ...userIds])) userNames.set(Number(u.id), u.name);
    const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
    return shown.map((a) => {
      const opening = typeof a.data.balance === 'number' ? a.data.balance : 0;
      const move = m.get(a.id) ?? { s: 0, n: 0, lastAt: null };
      const last = [a.updatedAt, move.lastAt].filter(Boolean).map((x) => new Date(x as Date).getTime());
      const sids = [...(storesOf.get(a.id) ?? [])];
      return {
        id: a.id, title: a.title, kind: a.data.kind ?? '', status: a.status, openingCents: opening, movementCents: move.s, balanceCents: opening + move.s, entries: move.n,
        bank: String(a.data.bank ?? ''), ownerName: String(a.data.ownerName ?? ''), licenseName: titles.get(Number(a.data.licenseId)) ?? '', keeperName: userNames.get(Number(a.data.keeperUserId)) ?? '',
        storeIds: sids, storeNames: sids.map((x) => titles.get(x) ?? `店铺#${x}`),
        updatedAt: last.length ? new Date(Math.max(...last)).toISOString() : iso(null),
      };
    });
  }

  /**
   * 店铺资金：每家店铺取最新一次「店铺资金」快照（可提现/保证金/冻结/推广费）；没有快照的店铺用店铺档案里登记的资金。
   * 带更新时间和平台，页面按平台分页签、按新旧着色，并能查到店铺关联的收款账户。
   */
  async storeFunds(user: AuthUser) {
    this.need(user, 'finance.cash-bank.view', '没有查看现金银行的权限');
    const rows = await this.dataSource.manager.find(ResourceRecord, { where: { companyId: user.companyId, type: 'store-funds' }, order: { id: 'DESC' }, take: 5000 });
    const latest = new Map<number, ResourceRecord>();
    for (const r of rows) {
      const sid = Number(r.data.storeId);
      const cur = latest.get(sid);
      if (!cur || String(r.data.snapshotDate) > String(cur.data.snapshotDate)) latest.set(sid, r);
    }
    const stores = await this.dataSource.manager.find(ResourceRecord, { where: { companyId: user.companyId, type: 'stores' }, take: 5000 });
    const platformOpts = new Map((getResourceDef('stores')?.fields.find((f) => f.key === 'platform')?.options ?? []).map((o) => [o.value, o.label]));
    const n = (v: unknown) => (typeof v === 'number' ? v : 0);
    const out = stores.filter((st) => latest.has(st.id) || ['normal', 'abnormal'].includes(st.status)).map((st) => {
      const snap = latest.get(st.id);
      const platform = String(st.data.platform ?? '');
      const base = { storeId: st.id, name: st.title, storeNo: String(st.data.storeNo ?? st.data.platformStoreId ?? ''), platform, platformLabel: platformOpts.get(platform) ?? (platform || '其他') };
      return snap
        ? { ...base, snapshotDate: String(snap.data.snapshotDate), updatedAt: new Date(snap.updatedAt).toISOString(), withdrawableCents: n(snap.data.withdrawable), depositCents: n(snap.data.deposit), frozenCents: n(snap.data.frozen), promotionCents: n(snap.data.promotion) }
        : { ...base, snapshotDate: '', updatedAt: null, withdrawableCents: 0, depositCents: 0, frozenCents: 0, promotionCents: 0 };
    });
    return out.sort((a, b) => b.withdrawableCents - a.withdrawableCents || a.name.localeCompare(b.name, 'zh-CN'));
  }

  /** 重点账户：每个人自己标记，只对自己生效 */
  async keyAccounts(user: AuthUser) {
    this.need(user, 'finance.cash-bank.view', '没有查看现金银行的权限');
    const rows = await this.dataSource.query('SELECT bank_account_id AS id FROM finance_key_accounts WHERE company_id = ? AND user_id = ? ORDER BY created_at, bank_account_id', [user.companyId, user.id]);
    return (rows as { id: number }[]).map((r) => Number(r.id));
  }

  async setKeyAccount(user: AuthUser, accountId: number, on: boolean) {
    this.need(user, 'finance.cash-bank.view', '没有查看现金银行的权限');
    const acc = await this.dataSource.manager.findOne(ResourceRecord, { where: { id: accountId, companyId: user.companyId, type: 'bank-accounts' }, select: ['id'] });
    if (!acc) throw new NotFoundException('银行账户不存在');
    if (on) await this.dataSource.query('INSERT IGNORE INTO finance_key_accounts (company_id, user_id, bank_account_id) VALUES (?, ?, ?)', [user.companyId, user.id, accountId]);
    else await this.dataSource.query('DELETE FROM finance_key_accounts WHERE company_id = ? AND user_id = ? AND bank_account_id = ?', [user.companyId, user.id, accountId]);
    return this.keyAccounts(user);
  }

  /** 现金银行账本：期间期初结存 + 每笔收入/支出 + 滚动余额；每笔带往来对象、经办人、该单实收实付 */
  async bankLedger(user: AuthUser, accountId: number, from?: string, to?: string) {
    this.need(user, 'finance.cash-bank.view', '没有查看现金银行的权限');
    const acc = await this.dataSource.manager.findOne(ResourceRecord, { where: { id: accountId, companyId: user.companyId, type: 'bank-accounts' } });
    if (!acc) throw new NotFoundException('银行账户不存在');
    const registered = typeof acc.data.balance === 'number' ? acc.data.balance : 0;
    const where = ['e.company_id = ?', "e.kind = 'bank'", 'e.account_id = ?'];
    const args: unknown[] = [user.companyId, accountId];
    if (from) { where.push('e.entry_date >= ?'); args.push(from); }
    if (to) { where.push('e.entry_date <= ?'); args.push(to); }
    let opening = registered;
    if (from) {
      const [r] = await this.dataSource.query("SELECT COALESCE(SUM(amount_cents),0) AS s FROM finance_entries WHERE company_id = ? AND kind = 'bank' AND account_id = ? AND entry_date < ?", [user.companyId, accountId, from]);
      opening += Number(r.s);
    }
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT e.id, DATE_FORMAT(e.entry_date, '%Y-%m-%d') AS entryDate, e.amount_cents AS amountCents, d.id AS documentId, d.doc_no AS docNo, d.doc_type AS docType, d.memo, d.handler, p.title AS partyName
       FROM finance_entries e JOIN finance_documents d ON d.id = e.document_id LEFT JOIN resource_records p ON p.id = d.party_id AND p.company_id = d.company_id
       WHERE ${where.join(' AND ')} ORDER BY e.entry_date ASC, e.id ASC LIMIT 2000`, args);
    let run = opening, income = 0, expense = 0;
    const list = rows.map((r) => {
      const amt = Number(r.amountCents);
      run += amt;
      if (amt > 0) income += amt; else expense += -amt;
      return { ...r, amountCents: amt, balanceCents: run, typeLabel: DOC_TYPE_MAP.get(r.docType as DocType)?.label ?? r.docType };
    });
    return { openingCents: opening, incomeCents: income, expenseCents: expense, closingCents: run, rows: list };
  }

  async inventory(user: AuthUser, q: { warehouseId?: number; keyword?: string; asOf?: string; stockStatus?: 'normal' | 'out' }) {
    this.need(user, 'finance.inventory.view', '没有查看库存的权限');
    const canCost = this.can(user, COST_VIEW);
    const where = ["e.company_id = ?", "e.kind = 'inventory'"];
    const args: unknown[] = [user.companyId];
    if (q.warehouseId) { where.push('e.sub_id = ?'); args.push(q.warehouseId); }
    if (q.asOf) { where.push('e.entry_date <= ?'); args.push(q.asOf); } // 历史库存：截止某天
    if (q.keyword?.trim()) { where.push('(p.title LIKE ? OR JSON_UNQUOTE(JSON_EXTRACT(p.data, \'$.code\')) LIKE ?)'); args.push(`%${q.keyword.trim()}%`, `%${q.keyword.trim()}%`); }
    // 库存状态：正常 = 数量大于 0；缺货 = 数量等于 0（卖空了）或欠着（<=0）；不筛选时不显示数量和金额都是 0 的空行
    const having = q.stockStatus === 'normal' ? 'SUM(e.qty) > 0.00005' : q.stockStatus === 'out' ? 'SUM(e.qty) <= 0.00005' : 'ABS(SUM(e.qty)) > 0.00005 OR SUM(e.amount_cents) <> 0';
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT e.account_id AS productId, e.sub_id AS warehouseId, p.title AS productName, JSON_UNQUOTE(JSON_EXTRACT(p.data, '$.code')) AS code, JSON_UNQUOTE(JSON_EXTRACT(p.data, '$.specUnit')) AS unit, w.title AS warehouseName, SUM(e.qty) AS qty, SUM(e.amount_cents) AS amount
       FROM finance_entries e LEFT JOIN resource_records p ON p.id = e.account_id AND p.company_id = e.company_id LEFT JOIN resource_records w ON w.id = e.sub_id AND w.company_id = e.company_id
       WHERE ${where.join(' AND ')} GROUP BY e.account_id, e.sub_id, p.title, p.data, w.title HAVING ${having} ORDER BY p.title, w.title LIMIT 1000`, args);
    return rows.map((r) => {
      const qty = Number(r.qty), amount = Number(r.amount);
      return { productId: r.productId, warehouseId: r.warehouseId, productName: r.productName, code: r.code ?? '', unit: r.unit ?? '', warehouseName: r.warehouseName, qty, avgCostCents: canCost && qty ? Math.round(amount / qty) : null, amountCents: canCost ? amount : null };
    });
  }

  /** 财务经营：month 传 YYYY-MM 看当月，传 'all' 看全部时间（趋势按月汇总，其余合计全部） */
  async overview(user: AuthUser, month?: string, fromQ?: string, toQ?: string) {
    this.need(user, 'finance.overview.view', '没有查看财务经营的权限');
    const isDay = (v?: string) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
    const custom = isDay(fromQ) || isDay(toQ);
    const all = !custom && month === 'all';
    const m = custom ? 'range' : all ? 'all' : month && /^\d{4}-\d{2}$/.test(month) ? month : today().slice(0, 7);
    let lo = '0000-01-01', hi = '9999-12-31';
    if (custom) { if (isDay(fromQ)) lo = fromQ as string; if (isDay(toQ)) hi = toQ as string; if (lo > hi) throw new BadRequestException('开始日期不能晚于结束日期'); }
    else if (!all) { const [y, mo] = m.split('-').map(Number); lo = `${m}-01`; hi = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); }
    const spanDays = lo === '0000-01-01' || hi === '9999-12-31' ? Infinity : (Date.parse(hi) - Date.parse(lo)) / 86400000;
    const byMonth = spanDays > 92;
    const canCost = this.can(user, COST_VIEW);
    const sums = await this.dataSource.query(
      "SELECT kind, SUM(amount_cents) AS s FROM finance_entries WHERE company_id = ? AND entry_date >= ? AND entry_date <= ? AND kind IN ('revenue','cogs','expense','other_income') GROUP BY kind", [user.companyId, lo, hi]);
    const get = (k: string) => Number(sums.find((x: { kind: string }) => x.kind === k)?.s ?? 0);
    const balances = await this.dataSource.query("SELECT kind, SUM(amount_cents) AS s FROM finance_entries WHERE company_id = ? AND kind IN ('receivable','payable','advance_receipt','prepayment') GROUP BY kind", [user.companyId]);
    const bal = (k: string) => Number(balances.find((x: { kind: string }) => x.kind === k)?.s ?? 0);
    const counts = await this.dataSource.query("SELECT status, COUNT(*) AS n FROM finance_documents WHERE company_id = ? AND status IN ('draft','issued') GROUP BY status", [user.companyId]);
    const cnt = (s: string) => Number(counts.find((x: { status: string }) => x.status === s)?.n ?? 0);
    const revenue = -get('revenue') || 0, cogs = get('cogs'), expense = get('expense'), otherIncome = -get('other_income') || 0;
    let bank: number | null = null;
    if (this.can(user, 'finance.cash-bank.view')) bank = (await this.bankBalances(user)).reduce((s, a) => s + a.balanceCents, 0);
    // 利润趋势：当月按天，全部时间按月
    const bucket = byMonth ? "DATE_FORMAT(entry_date, '%Y-%m')" : "DATE_FORMAT(entry_date, '%Y-%m-%d')";
    const daily = await this.dataSource.query(
      `SELECT ${bucket} AS d, kind, SUM(amount_cents) AS s FROM finance_entries WHERE company_id = ? AND entry_date >= ? AND entry_date <= ? AND kind IN ('revenue','cogs','expense','other_income') GROUP BY d, kind ORDER BY d`, [user.companyId, lo, hi]);
    const byDay = new Map<string, { date: string; revenueCents: number; cogsCents: number; expenseCents: number; otherIncomeCents: number }>();
    for (const r of daily as { d: string; kind: string; s: string }[]) {
      const row = byDay.get(r.d) ?? { date: r.d, revenueCents: 0, cogsCents: 0, expenseCents: 0, otherIncomeCents: 0 };
      const v = Number(r.s);
      if (r.kind === 'revenue') row.revenueCents = -v; else if (r.kind === 'cogs') row.cogsCents = v; else if (r.kind === 'expense') row.expenseCents = v; else row.otherIncomeCents = -v;
      byDay.set(r.d, row);
    }
    const trend = [...byDay.values()].map((x) => ({
      date: x.date, revenueCents: x.revenueCents, expenseCents: x.expenseCents,
      profitCents: canCost ? x.revenueCents - x.cogsCents - x.expenseCents + x.otherIncomeCents : null,
    }));
    // 店铺利润：取「店铺经营数据」按店铺汇总，带店铺所属主体（营业执照）
    const metrics = await this.dataSource.query(
      "SELECT JSON_UNQUOTE(JSON_EXTRACT(data,'$.storeId')) AS sid, SUM(CAST(JSON_EXTRACT(data,'$.sales') AS SIGNED)) AS sales, SUM(CAST(JSON_EXTRACT(data,'$.refund') AS SIGNED)) AS refund, SUM(CAST(JSON_EXTRACT(data,'$.adCost') AS SIGNED)) AS ad, SUM(CAST(JSON_EXTRACT(data,'$.platformFee') AS SIGNED)) AS fee, SUM(CAST(JSON_EXTRACT(data,'$.purchaseCost') AS SIGNED)) AS pc, SUM(CAST(JSON_EXTRACT(data,'$.otherCost') AS SIGNED)) AS oc FROM resource_records WHERE company_id = ? AND type = 'store-daily-metrics' AND JSON_UNQUOTE(JSON_EXTRACT(data,'$.day')) >= ? AND JSON_UNQUOTE(JSON_EXTRACT(data,'$.day')) <= ? GROUP BY sid",
      [user.companyId, lo, hi]);
    const storeIds = (metrics as { sid: string }[]).map((x) => Number(x.sid)).filter((n) => n > 0);
    const storeRows = storeIds.length ? await this.dataSource.query(`SELECT id, title, JSON_UNQUOTE(JSON_EXTRACT(data,'$.licenseId')) AS lid, JSON_UNQUOTE(JSON_EXTRACT(data,'$.platform')) AS platform FROM resource_records WHERE company_id = ? AND type = 'stores' AND id IN (${storeIds.map(() => '?').join(',')})`, [user.companyId, ...storeIds]) : [];
    const lids = [...new Set((storeRows as { lid: string | null }[]).map((x) => Number(x.lid)).filter((n) => n > 0))];
    const licRows = lids.length ? await this.dataSource.query(`SELECT id, title FROM resource_records WHERE company_id = ? AND type = 'licenses' AND id IN (${lids.map(() => '?').join(',')})`, [user.companyId, ...lids]) : [];
    const licOf = new Map((licRows as { id: number; title: string }[]).map((x) => [Number(x.id), x.title]));
    const storeOf = new Map((storeRows as { id: number; title: string; lid: string | null; platform: string | null }[]).map((x) => [Number(x.id), { name: x.title, license: licOf.get(Number(x.lid)) ?? '', platform: x.platform ?? '' }]));
    const stores = (metrics as { sid: string; sales: string | null; refund: string | null; ad: string | null; fee: string | null; pc: string | null; oc: string | null }[]).map((x) => {
      const sales = Number(x.sales ?? 0), refund = Number(x.refund ?? 0), ad = Number(x.ad ?? 0), fee = Number(x.fee ?? 0), pc = Number(x.pc ?? 0), oc = Number(x.oc ?? 0);
      const st = storeOf.get(Number(x.sid));
      return { storeId: Number(x.sid), name: st?.name ?? `店铺#${x.sid}`, licenseName: st?.license ?? '', platform: st?.platform ?? '', salesCents: sales, adCostCents: ad, profitCents: canCost ? sales - refund - ad - fee - pc - oc : null };
    }).sort((a, b) => b.salesCents - a.salesCents);
    // 财务台账：最近的收入/费用/其他收入分录，带店铺（提现单的店铺或往来对象是店铺）和来源（手工制单/流程自动记账）
    const led = await this.dataSource.query(
      `SELECT e.entry_date AS d, e.kind, e.amount_cents AS a, e.document_id AS did, d.doc_no AS no, d.doc_type AS dt, d.source_key AS sk, s.title AS storeName
       FROM finance_entries e JOIN finance_documents d ON d.id = e.document_id
       LEFT JOIN resource_records s ON s.company_id = e.company_id AND s.type = 'stores' AND s.id = COALESCE(d.store_id, CASE WHEN d.party_kind = 'store' THEN d.party_id END)
       WHERE e.company_id = ? AND e.entry_date >= ? AND entry_date <= ? AND e.kind IN ('revenue','expense','other_income') ORDER BY e.entry_date DESC, e.id DESC LIMIT 60`, [user.companyId, lo, hi]);
    const ledger = (led as { d: string; kind: string; a: string; did: number; no: string; dt: string; sk: string | null; storeName: string | null }[]).map((x) => ({
      date: x.d, direction: x.kind === 'expense' ? 'out' : 'in', kind: x.kind, amountCents: Math.abs(Number(x.a)), documentId: x.did, docNo: x.no, docType: x.dt, storeName: x.storeName ?? '', source: sourceLabel(x.sk) }));
    return {
      trend, trendBy: byMonth ? 'month' : 'day', from: lo === '0000-01-01' ? '' : lo, to: hi === '9999-12-31' ? '' : hi, stores, ledger,
      month: m, revenueCents: revenue, cogsCents: canCost ? cogs : null, grossProfitCents: canCost ? revenue - cogs : null,
      expenseCents: expense, otherIncomeCents: otherIncome, netProfitCents: canCost ? revenue - cogs - expense + otherIncome : null,
      receivableCents: bal('receivable'), payableCents: -bal('payable') || 0, advanceReceiptCents: -bal('advance_receipt') || 0, prepaymentCents: bal('prepayment'),
      bankCents: bank, drafts: cnt('draft'), issued: cnt('issued'),
    };
  }

  docTypes() { return DOC_TYPES; }
}
