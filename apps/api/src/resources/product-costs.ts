import { BadRequestException, ConflictException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { COST_BUCKETS, FINANCE_RESOURCE_DEFS, todayInChina } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { ResourceRecord } from '../entities';
import type { BeforeSaveContext, RuleHost } from './resource-rules';

/**
 * 档案级成本记录（旧系统 finance_product_archive_costs）与运费历史（finance_product_freight_history）。
 * 成本记录按成本类型（6 个归集科目）和生效日期保存，同一档案同一类型的启用记录日期不能重叠；
 * 手工锁定的记录，系统自动同步（档案采购价、供货来源、生产 BOM）不会覆盖。
 */
type Data = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const rec = (em: EntityManager, companyId: number, type: string, id: unknown) =>
  typeof id === 'number' ? em.findOne(ResourceRecord, { where: { id, companyId, type } }) : Promise.resolve(null);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const bucketLabel = (v: unknown) => COST_BUCKETS.find((b) => b.value === v)?.label ?? str(v);
const specUnitLabel = (v: unknown) => FINANCE_RESOURCE_DEFS.find((d) => d.key === 'finance-products')!.fields.find((f) => f.key === 'specUnit')!.options!.find((o) => o.value === v)?.label ?? str(v);
const dayBefore = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
const overlaps = (aFrom: string, aTo: string | null, bFrom: string, bTo: string | null) => aFrom <= (bTo ?? '9999-12-31') && bFrom <= (aTo ?? '9999-12-31');

function validDate(v: unknown, label: string, required = false): string | null {
  const s = str(v);
  if (!s) {
    if (required) throw new BadRequestException(`${label}必填`);
    return null;
  }
  if (!DATE_RE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`)) || new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s) throw new BadRequestException(`${label}格式无效`);
  return s;
}

/** 系统自动写入时用的身份：操作人还是本人（日志记他），但不受他字段权限的限制（运营没有成本权限，也要记运费历史）。 */
export const asAdmin = (user: AuthUser): AuthUser => ({ ...user, permissions: { isCompanyAdmin: true, allow: [], deny: [] } });

/** 系统自己写入（自动同步、运费历史）时在事务上做标记，手工保存不带标记。 */
export async function asSystem<T>(em: EntityManager, key: string, fn: () => Promise<T>): Promise<T> {
  const data = em.queryRunner?.data;
  if (data) data[key] = true;
  try { return await fn(); } finally { if (data) delete data[key]; }
}

export async function beforeProductCost(ctx: BeforeSaveContext): Promise<void> {
  const { em, host, user, data, existing, status } = ctx;
  const product = await rec(em, user.companyId, 'finance-products', data.productId);
  if (!product) throw new BadRequestException('商品档案不存在');
  if (existing && existing.data.productId !== data.productId) throw new BadRequestException('成本记录不能换到别的商品档案');
  const cost = num(data.unitCost);
  if (cost === null || cost < 0) throw new BadRequestException('单位成本必须是非负数');
  const from = validDate(data.effectiveFrom, '生效开始', true)!;
  const to = validDate(data.effectiveTo, '生效结束');
  if (to && to < from) throw new BadRequestException('生效结束不能早于生效开始');
  if (!str(data.sourceType)) data.sourceType = 'manual';
  // 只有系统自动同步能写“商品档案采购价同步”，手工不能冒充
  if (data.sourceType === 'archive_purchase_price' && !em.queryRunner?.data.costSync && existing?.data.sourceType !== 'archive_purchase_price') throw new BadRequestException('这个来源只能由系统自动写入');
  if (data.manualOverride === true) {
    if (!str(data.manualLockReason).trim()) throw new BadRequestException('锁定此成本时必须填写锁定原因');
  } else { delete data.manualOverride; delete data.manualLockReason; }
  if (!str(data.unitName).trim()) data.unitName = str(product.data.purchaseSpec) || specUnitLabel(product.data.specUnit);
  if (status === 'active') {
    for (const r of await host.findWhere(em, user.companyId, 'finance-product-costs', 'productId', product.id)) {
      if (r.id === existing?.id || r.status !== 'active' || r.data.costType !== data.costType) continue;
      if (overlaps(from, to, str(r.data.effectiveFrom), str(r.data.effectiveTo) || null)) throw new BadRequestException('同一档案和成本类型已存在生效日期重叠的记录');
    }
  }
  data.label = `${product.title} · ${bucketLabel(data.costType)} · ${from} 生效`.slice(0, 200);
}

/** 档案上展示的“最新成本”：启用记录里生效日期最晚的一条（和旧系统列表一致）。 */
export async function refreshLatestCost(host: RuleHost, em: EntityManager, user: AuthUser, productId: number): Promise<void> {
  const live = (await host.findWhere(em, user.companyId, 'finance-product-costs', 'productId', productId)).filter((r) => r.status === 'active');
  live.sort((a, b) => str(b.data.effectiveFrom).localeCompare(str(a.data.effectiveFrom)) || b.id - a.id);
  const top = live[0];
  await host.patchData(em, user, 'finance-products', productId, {
    latestUnitCost: top ? num(top.data.unitCost) : null, latestCostType: top ? top.data.costType : null, latestCostFrom: top ? top.data.effectiveFrom : null,
  });
}

export interface AutoCost { sourceType: 'archive_purchase_price' | 'raw_supply_source' | 'production_bom'; unitCost: number; unitName: string; sourceRef?: string; calculationMethod: string }

/**
 * 系统自动同步一条“采购成本”记录（旧系统 syncArchivePurchaseCost / refreshDerivedArchiveCosts）：
 * 当前生效的记录是手工锁定的，或不是同一种自动来源（有人手工录过），就不动；同一天已有同来源的，更新金额；
 * 否则把之前的自动记录截止到昨天，新增一条今天生效的。
 */
export async function syncAutoCost(host: RuleHost, em: EntityManager, user: AuthUser, productId: number, auto: AutoCost): Promise<boolean> {
  if (em.queryRunner?.data.legacyImport || !(auto.unitCost >= 0) || !auto.unitName) return false;
  const today = todayInChina();
  const rows = (await host.findWhere(em, user.companyId, 'finance-product-costs', 'productId', productId)).filter((r) => r.data.costType === 'purchase');
  const live = rows.filter((r) => r.status === 'active' && str(r.data.effectiveFrom) <= today && (!str(r.data.effectiveTo) || str(r.data.effectiveTo) >= today));
  if (live.some((r) => r.data.manualOverride === true || r.data.sourceType !== auto.sourceType)) return false;
  const sameDay = rows.find((r) => str(r.data.effectiveFrom) === today);
  if (sameDay && (sameDay.data.manualOverride === true || sameDay.data.sourceType !== auto.sourceType || sameDay.status !== 'active')) return false;
  if (live.length === 1 && live[0].data.unitCost === auto.unitCost && live[0].data.unitName === auto.unitName) return false;
  await asSystem(em, 'costSync', async () => {
    if (sameDay) {
      await host.patchData(em, user, 'finance-product-costs', sameDay.id, { unitCost: auto.unitCost, unitName: auto.unitName, sourceRef: auto.sourceRef, calculationMethod: auto.calculationMethod });
      return;
    }
    for (const r of live) await host.patchData(em, user, 'finance-product-costs', r.id, { effectiveTo: dayBefore(today) });
    const future = rows.filter((r) => r.status === 'active' && str(r.data.effectiveFrom) > today).map((r) => str(r.data.effectiveFrom)).sort()[0];
    await host.createRecord(em, asAdmin(user), 'finance-product-costs', {
      productId, costType: 'purchase', unitCost: auto.unitCost, unitName: auto.unitName, effectiveFrom: today, effectiveTo: future ? dayBefore(future) : undefined,
      sourceType: auto.sourceType, sourceRef: auto.sourceRef, calculationMethod: auto.calculationMethod,
    }, '系统自动同步档案成本记录');
  });
  await refreshLatestCost(host, em, user, productId);
  return true;
}

// ---------- 运费历史 ----------

const FREIGHT_KEY = 'freightHistory';

/** 运费历史只能由系统在运费、装卸费、采购价或系统规格变化时追加，不能手工改。 */
export async function beforeFreightHistory(ctx: BeforeSaveContext): Promise<void> {
  const { em, user, data, existing } = ctx;
  if (!em.queryRunner?.data[FREIGHT_KEY]) throw new BadRequestException('运费历史由系统在运费或装卸费变化时自动记录，不能手工新增或修改');
  const product = await rec(em, user.companyId, 'finance-products', data.productId);
  if (!product) throw new BadRequestException('商品档案不存在');
  if (existing) throw new BadRequestException('运费历史不能修改');
  data.label = `${product.title} · 运费${data.freight ?? 0} 装卸${data.handlingFee ?? 0}`.slice(0, 200);
}

export function afterFreightHistoryDelete(ctx: { em: EntityManager }): Promise<void> {
  if (!ctx.em.queryRunner?.data[FREIGHT_KEY] && !ctx.em.queryRunner?.data.legacyImport) throw new ConflictException('运费历史不能删除');
  return Promise.resolve();
}

/** 商品档案保存后：运费、装卸费、采购价、系统规格和最新一条历史不同，就追加一条（旧系统 freightHistoryChanged）。 */
export async function recordFreightHistory(host: RuleHost, em: EntityManager, user: AuthUser, product: ResourceRecord, source: { type: string; ref?: string } = { type: 'manual' }): Promise<void> {
  if (em.queryRunner?.data.legacyImport) return;
  const d = product.data;
  if (num(d.freight) === null && num(d.handlingFee) === null) return;
  const snap = { freight: num(d.freight) ?? 0, handlingFee: num(d.handlingFee) ?? 0, purchasePrice: num(d.purchasePrice), systemSpec: str(d.purchaseSpec) || `${d.specQty ?? ''} ${str(d.specUnit)}`.trim() };
  const rows = await host.findWhere(em, user.companyId, 'finance-product-freight-history', 'productId', product.id);
  const last = rows.sort((a, b) => str(b.data.recordedAtKey).localeCompare(str(a.data.recordedAtKey)) || b.id - a.id)[0];
  if (last && last.data.freight === snap.freight && (num(last.data.handlingFee) ?? 0) === snap.handlingFee && str(last.data.systemSpec) === snap.systemSpec && (num(last.data.purchasePrice) ?? null) === snap.purchasePrice) return;
  await asSystem(em, FREIGHT_KEY, async () => {
    await host.createRecord(em, asAdmin(user), 'finance-product-freight-history', {
      productId: product.id, ...snap, sourceType: source.type, sourceRef: source.ref, recordedAtKey: new Date().toISOString(), operatorName: user.name,
    }, '运费或装卸费变化，自动记录历史');
  });
}

export type { Data };
