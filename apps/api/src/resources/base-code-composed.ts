import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { ResourceRecord } from '../entities';
import { AuthUser } from '../common/auth.decorators';
import { buildSnapshot, byField, composedFacts } from './base-code-support';
import type { AfterSaveContext, BeforeSaveContext, RuleHost } from './resource-rules';

/**
 * 基础编码的“多构成”（旧系统 product-base-codes-v3 的 code_links）与“被引用锁定”（product-base-code-references）。
 * 一个多构成基础编码由几个商品档案按数量组成（如礼盒）；基础编码上的“来源商品档案”是它的主要商品档案。
 * 纯数据规则放这里，finance-rules.ts 只做最小接线。
 */
type Data = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const rec = (em: EntityManager, companyId: number, type: string, id: unknown) =>
  typeof id === 'number' ? em.findOne(ResourceRecord, { where: { id, companyId, type } }) : Promise.resolve(null);

export const isComposed = (bc: { data: Data } | null | undefined) => bc?.data.origin === 'composed';

export interface BaseCodeReferences {
  /** effective = 有生效引用（已验证的组合用着，或已上传聚水潭）；draft = 只有待验证的组合引用；none = 没人用 */
  level: 'effective' | 'draft' | 'none';
  label: string;
  count: number;
  items: Array<{ source: 'bundle' | 'jushuitan'; sourceLabel: string; level: 'effective' | 'draft'; sourceId: number; name: string; detail: string }>;
  permissions: { editAll: boolean; editDisplayFields: boolean; editIdentityFields: boolean; editComponents: boolean; canDeactivate: boolean };
}

/**
 * 基础编码有没有被引用：
 * 组合构成行用着它（组合已验证/需重新验证 = 生效引用；待验证 = 草稿引用；失效归档不算），
 * 或者它已经上传过聚水潭、聚水潭商品镜像里有同编码的普通商品 = 生效引用。
 */
export async function inspectBaseCodeReferences(em: EntityManager, companyId: number, bc: ResourceRecord): Promise<BaseCodeReferences> {
  const items: BaseCodeReferences['items'] = [];
  const seen = new Set<number>();
  for (const l of await byField(em, companyId, 'finance-bundle-lines', 'baseCodeId', bc.id)) {
    const bid = num(l.data.bundleId);
    if (bid === null || seen.has(bid)) continue;
    seen.add(bid);
    const b = await rec(em, companyId, 'finance-bundles', bid);
    if (!b || b.status === 'archived') continue;
    const effective = b.status === 'verified' || b.status === 'reverify';
    items.push({ source: 'bundle', sourceLabel: '商品组合编码', level: effective ? 'effective' : 'draft', sourceId: b.id, name: str(b.data.name) || b.title, detail: `组合 ${str(b.data.code)} · ${effective ? '已验证' : '待验证'}` });
  }
  const code = str(bc.data.code).toLowerCase();
  const mirror = code
    ? await em.findOne(ResourceRecord, { where: { companyId, type: 'finance-jst-skus', uniqueKey: code } })
    : null;
  if (mirror && mirror.data.goodsType !== 'combine') {
    items.push({ source: 'jushuitan', sourceLabel: '聚水潭普通商品镜像', level: 'effective', sourceId: mirror.id, name: str(mirror.data.name) || mirror.title, detail: `SKU ${str(mirror.data.skuId)}` });
  } else if (str(bc.data.jstUploadedCode)) {
    items.push({ source: 'jushuitan', sourceLabel: '已上传聚水潭', level: 'effective', sourceId: bc.id, name: str(bc.data.name) || bc.title, detail: `聚水潭编码 ${str(bc.data.jstUploadedCode)}` });
  }
  const level = items.some((i) => i.level === 'effective') ? 'effective' : items.some((i) => i.level === 'draft') ? 'draft' : 'none';
  return {
    level,
    label: level === 'effective' ? '已生效引用' : level === 'draft' ? '草稿引用' : '未引用',
    count: items.length,
    items,
    permissions: {
      editAll: level !== 'effective',
      editDisplayFields: true,
      editIdentityFields: level !== 'effective',
      editComponents: level !== 'effective',
      canDeactivate: !items.some((i) => i.source === 'bundle' && i.level === 'effective'),
    },
  };
}

const LOCK_MSG = '该商品编码已有生效引用，只允许修改商品名称、简称、颜色及规格和启停状态';
/** 身份字段：编码、款式编码、来源商品、多构成的分类/品牌/规格 */
export const BASE_CODE_IDENTITY_FIELDS = ['code', 'styleCode', 'productId', 'canonicalId', 'origin', 'varietyName', 'codeCategoryId', 'codeBrandId', 'codeSpecQty', 'codeSpecUnit'] as const;
const IDENTITY: readonly string[] = BASE_CODE_IDENTITY_FIELDS;

/** 保存基础编码前：已有生效引用时，身份字段不能变；被已验证组合引用时不能停用。 */
export async function guardReferenced(em: EntityManager, user: AuthUser, existing: ResourceRecord | null, data: Data, status: string): Promise<void> {
  if (!existing || em.queryRunner?.data.legacyImport) return;
  const stopping = status !== existing.status && ['disabled', 'deleted'].includes(status);
  const identityChanged = IDENTITY.some((k) => JSON.stringify(existing.data[k] ?? null) !== JSON.stringify(data[k] ?? null));
  if (!identityChanged && !stopping) return;
  const refs = await inspectBaseCodeReferences(em, user.companyId, existing);
  if (identityChanged && refs.level === 'effective') throw new BadRequestException(LOCK_MSG);
  if (stopping && !refs.permissions.canDeactivate) throw new BadRequestException('该商品编码正在被已验证的组合商品引用，不能停用');
}

/** 多构成基础编码的重量、成本、采购价存到记录上（列表和详情展示用；开单、上传时再按构成实时算）。 */
export async function refreshComposedTotals(host: RuleHost, em: EntityManager, user: AuthUser, baseCodeId: number): Promise<void> {
  const bc = await rec(em, user.companyId, 'finance-base-codes', baseCodeId);
  if (!bc || !isComposed(bc)) return;
  const f = await composedFacts(em, user.companyId, baseCodeId);
  await host.patchData(em, user, 'finance-base-codes', baseCodeId, {
    categoryId: bc.data.codeCategoryId, weightG: f.count ? f.weightG : undefined, cost: f.cost ?? undefined, purchasePrice: f.purchasePrice ?? undefined,
  }, '按构成重新汇总重量和成本');
}

/** 用到这个商品档案的所有基础编码：来源商品就是它的，加上多构成里含有它的。 */
export async function baseCodesUsingProduct(host: RuleHost, em: EntityManager, companyId: number, productId: number): Promise<ResourceRecord[]> {
  const out = new Map<number, ResourceRecord>();
  for (const bc of await host.findWhere(em, companyId, 'finance-base-codes', 'productId', productId)) out.set(bc.id, bc);
  for (const l of await host.findWhere(em, companyId, 'finance-base-code-lines', 'productId', productId)) {
    const bid = num(l.data.baseCodeId);
    if (bid === null || out.has(bid)) continue;
    const bc = await rec(em, companyId, 'finance-base-codes', bid);
    if (bc) out.set(bc.id, bc);
  }
  return [...out.values()];
}

/** 构成行保存前的检查。 */
export async function beforeBaseCodeLine(ctx: BeforeSaveContext): Promise<void> {
  const { em, host, user, data, existing } = ctx;
  const bc = await rec(em, user.companyId, 'finance-base-codes', data.baseCodeId);
  if (!bc) throw new BadRequestException('基础编码不存在');
  if (!isComposed(bc)) throw new BadRequestException('只有“多构成”的基础编码才有构成行');
  if (existing && existing.data.baseCodeId !== data.baseCodeId) throw new BadRequestException('构成行不能换到别的基础编码');
  const product = await rec(em, user.companyId, 'finance-products', data.productId);
  if (!product) throw new BadRequestException('商品档案不存在');
  if (product.status !== 'active') throw new BadRequestException(`「${product.title}」不是正常状态，不能作为构成`);
  const qty = num(data.qty);
  if (qty === null || !(qty > 0)) throw new BadRequestException('数量必须大于 0');
  data.role = data.role === 'main' ? 'main' : 'auxiliary';
  const dup = (await host.findWhere(em, user.companyId, 'finance-base-code-lines', 'baseCodeId', bc.id)).find((l) => l.id !== existing?.id && l.data.productId === product.id);
  if (dup) throw new BadRequestException('同一个商品档案不能重复添加，请直接修改数量');
  if (existing && bc.data.productId === existing.data.productId && product.id !== bc.data.productId) throw new BadRequestException('这是基础编码的主要商品档案，不能换成别的商品');
  if (!em.queryRunner?.data.legacyImport) {
    const changed = !existing || existing.data.productId !== data.productId || existing.data.qty !== data.qty;
    if (changed && (await inspectBaseCodeReferences(em, user.companyId, bc)).level === 'effective') throw new BadRequestException(LOCK_MSG);
  }
  data.label = `${bc.title} ← ${product.title} ×${qty}`.slice(0, 200);
}

/**
 * 构成行变了：重新汇总；已验证的基础编码按快照对比，变了就要重新验证，并连带用到它的组合。
 * markBundles 由调用方传入（组合打回重新验证的逻辑在 finance-rules 里）。
 */
export async function afterBaseCodeLineChange(
  ctx: { em: EntityManager; host: RuleHost; user: AuthUser },
  baseCodeId: number,
  markBundles: (baseCodeId: number) => Promise<void>,
): Promise<void> {
  const { em, host, user } = ctx;
  await refreshComposedTotals(host, em, user, baseCodeId);
  const bc = await rec(em, user.companyId, 'finance-base-codes', baseCodeId);
  if (!bc || bc.status !== 'verified' || !bc.data.snapshot) return;
  const { signature } = await buildSnapshot(em, user.companyId, bc);
  if (signature === bc.data.signature) return;
  await host.setStatusDirect(em, user, 'finance-base-codes', bc.id, 'reverify', '基础编码的商品组成变了，需要重新验证');
  await markBundles(bc.id);
}

export async function afterBaseCodeLineSave(ctx: AfterSaveContext, markBundles: (id: number) => Promise<void>): Promise<void> {
  const bid = num(ctx.record.data.baseCodeId);
  if (bid !== null) await afterBaseCodeLineChange(ctx, bid, markBundles);
}

/** 构成行删除前的保护在这里（删除后的钩子里抛错，整个事务回滚）：不能删主要商品行，有生效引用时不能删。 */
export async function afterBaseCodeLineDelete(
  ctx: { em: EntityManager; host: RuleHost; user: AuthUser; record: ResourceRecord },
  markBundles: (id: number) => Promise<void>,
): Promise<void> {
  const bid = num(ctx.record.data.baseCodeId);
  if (bid === null) return;
  const bc = await rec(ctx.em, ctx.user.companyId, 'finance-base-codes', bid);
  if (!bc) return;
  if (!ctx.em.queryRunner?.data.legacyImport) {
    if (bc.data.productId === ctx.record.data.productId) throw new BadRequestException('这是基础编码的主要商品档案，不能去掉');
    if ((await inspectBaseCodeReferences(ctx.em, ctx.user.companyId, bc)).level === 'effective') throw new BadRequestException(LOCK_MSG);
  }
  await afterBaseCodeLineChange(ctx, bid, markBundles);
}

/** 新建多构成基础编码后：把主要商品档案自动加成第一行（数量 1，主要商品），后面在详情里继续加。 */
export async function seedMainLine(host: RuleHost, em: EntityManager, user: AuthUser, record: ResourceRecord): Promise<void> {
  if (!isComposed(record) || typeof record.data.productId !== 'number') return;
  if ((await host.findWhere(em, user.companyId, 'finance-base-code-lines', 'baseCodeId', record.id)).length) return;
  await host.createRecord(em, user, 'finance-base-code-lines', { baseCodeId: record.id, productId: record.data.productId, qty: 1, role: 'main' }, '多构成基础编码：主要商品档案自动加为第一行');
}

export type { Data };
