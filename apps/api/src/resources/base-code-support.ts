import * as crypto from 'crypto';
import { EntityManager } from 'typeorm';
import { ResourceRecord } from '../entities';

/**
 * 基础编码的“资料快照”：商品档案本身 + 它配方里用到的所有下级档案（原料、半成品、包装……）。
 * 验证时存一份，之后只要快照变了，基础编码就要“重新验证”；二次验证页面按它列出前后差异。
 * 这里只放纯数据处理，不做权限判断：带成本的字段由调用方按 product.cost.view 去掉。
 */

type Data = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

export const sigOf = (...parts: unknown[]) => crypto.createHash('sha256').update(parts.map((p) => String(p ?? '')).join('|')).digest('hex').slice(0, 24);

/** 带成本/价格的字段（没有 product.cost.view 的人看不到） */
export const COST_FIELDS = new Set(['totalCost', 'purchasePrice', 'freight', 'handlingFee', 'cost', 'cost_price', 'purchase_price']);

export const FIELD_LABELS: Record<string, string> = {
  code: '编码', styleCode: '款式编码', name: '名称', shortName: '简称', spec: '颜色及规格', varietyName: '品种',
  weightG: '重量(克)', totalCost: '总成本', purchasePrice: '采购价', freight: '运费', handlingFee: '装卸费',
  specQty: '规格数量', specUnit: '规格单位', categoryName: '分类', archiveType: '档案类型', bom: '配方构成', brandName: '品牌',
};

export interface ArchiveSnap {
  key: string;
  productId: number;
  name: string;
  code: string;
  archiveType: string;
  categoryId: number | null;
  categoryName: string;
  brandName: string;
  weightG: number | null;
  totalCost: number | null;
  purchasePrice: number | null;
  freight: number | null;
  handlingFee: number | null;
  specQty: number | null;
  specUnit: string;
  /** 从谁引用到它：自上而下的档案名 */
  parentPath: string[];
  bom: string;
}

export interface Issue {
  archiveKey: string;
  productId: number;
  archiveName: string;
  parentPath: string[];
  message: string;
}

export interface Snapshot {
  profile: Record<string, unknown>;
  archives: ArchiveSnap[];
}

async function byField(em: EntityManager, companyId: number, type: string, field: string, value: number) {
  return em
    .createQueryBuilder(ResourceRecord, 'r')
    .where('r.companyId = :companyId AND r.type = :type', { companyId, type })
    .andWhere(`JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.${field}')) = :v`, { v: String(value) })
    .getMany();
}

const one = (em: EntityManager, companyId: number, type: string, id: unknown) =>
  typeof id === 'number' ? em.findOne(ResourceRecord, { where: { id, companyId, type } }) : Promise.resolve(null);

export async function categoryPath(em: EntityManager, companyId: number, categoryId: unknown): Promise<ResourceRecord[]> {
  const chain: ResourceRecord[] = [];
  let cur = await one(em, companyId, 'finance-categories', categoryId);
  for (let i = 0; cur && i < 8; i++) {
    chain.unshift(cur);
    cur = await one(em, companyId, 'finance-categories', cur.data.parentId);
  }
  return chain;
}

/** 走商品档案和它的配方链，收集快照和问题清单 */
export async function buildSnapshot(em: EntityManager, companyId: number, bc: ResourceRecord): Promise<{ snapshot: Snapshot; issues: Issue[]; signature: string }> {
  const archives: ArchiveSnap[] = [];
  const issues: Issue[] = [];
  const seen = new Set<number>();
  const issue = (a: ArchiveSnap, message: string) => issues.push({ archiveKey: a.key, productId: a.productId, archiveName: a.name, parentPath: a.parentPath, message });

  const visit = async (productId: number, path: string[], trail: number[]) => {
    if (trail.includes(productId)) {
      const last = archives.find((a) => a.productId === trail[trail.length - 1]);
      if (last) issue(last, '配方里出现了循环引用');
      return;
    }
    if (seen.has(productId) || path.length > 10) return;
    seen.add(productId);
    const p = await one(em, companyId, 'finance-products', productId);
    if (!p) return;
    const d = p.data;
    const cat = await categoryPath(em, companyId, d.categoryId);
    const brand = await one(em, companyId, 'finance-brands', d.brandId);
    const boms = (await byField(em, companyId, 'finance-product-boms', 'productId', productId)).sort((a, b) => a.id - b.id);
    const a: ArchiveSnap = {
      key: `product:${p.id}`, productId: p.id, name: p.title, code: str(d.code), archiveType: str(d.archiveType),
      categoryId: num(d.categoryId), categoryName: cat.map((c) => c.title).join('/'), brandName: brand?.title ?? '',
      weightG: num(d.weightG), totalCost: num(d.totalCost), purchasePrice: num(d.purchasePrice), freight: num(d.freight), handlingFee: num(d.handlingFee),
      specQty: num(d.specQty), specUnit: str(d.specUnit), parentPath: path,
      bom: boms.map((b) => `${b.data.laborId ? `L${b.data.laborId}` : `P${b.data.componentId}`}x${b.data.qty}+${b.data.lossPercent ?? 0}`).join(';'),
    };
    archives.push(a);

    if (p.status !== 'active') issue(a, '这个档案已经删除');
    if (!str(d.name).trim()) issue(a, '没有填名称');
    if (cat.length === 0) issue(a, '没有选分类');
    else if ((await byField(em, companyId, 'finance-categories', 'parentId', cat[cat.length - 1].id)).length > 0) issue(a, '所选分类不是最末级');
    if (!((a.weightG ?? 0) > 0)) issue(a, '重量必须大于 0（克）');
    if (a.totalCost === null) issue(a, '没有完整成本（采购价、运费、装卸费）');
    if (['raw', 'shipping_material'].includes(a.archiveType)) {
      if (a.specQty === null || !a.specUnit) issue(a, '规格数量和规格单位没有填全');
      if (a.purchasePrice === null) issue(a, '没有有效的采购价（请到供货来源里补一条）');
    }
    if (a.archiveType === 'self_made' && boms.length === 0) issue(a, '自制品还没有配方构成');

    for (const b of boms) {
      if (typeof b.data.componentId === 'number') await visit(b.data.componentId, [...path, p.title], [...trail, productId]);
    }
  };

  const productId = num(bc.data.productId);
  if (productId !== null) await visit(productId, [], []);
  const snapshot: Snapshot = {
    profile: {
      code: str(bc.data.code), styleCode: str(bc.data.styleCode), name: str(bc.data.name), shortName: str(bc.data.shortName),
      spec: str(bc.data.spec), varietyName: str(bc.data.varietyName),
    },
    archives,
  };
  return { snapshot, issues, signature: sigOf(JSON.stringify(snapshot)) };
}

export interface Change { source: string; field: string; label: string; before: unknown; after: unknown }

/** 对比两份快照，列出变了什么（二次验证用）。 */
export function diffSnapshots(before: Snapshot, after: Snapshot): Change[] {
  const out: Change[] = [];
  const push = (source: string, field: string, b: unknown, a: unknown) => {
    if (JSON.stringify(b ?? null) !== JSON.stringify(a ?? null)) out.push({ source, field, label: FIELD_LABELS[field] ?? field, before: b ?? null, after: a ?? null });
  };
  for (const k of Object.keys({ ...before.profile, ...after.profile })) push('基础编码', k, before.profile[k], after.profile[k]);
  const was = new Map(before.archives.map((x) => [x.key, x]));
  const now = new Map(after.archives.map((x) => [x.key, x]));
  for (const [key, a] of now) {
    const b = was.get(key);
    if (!b) { out.push({ source: a.name, field: 'archive', label: '新增的下级档案', before: null, after: a.name }); continue; }
    for (const f of ['code', 'name', 'weightG', 'totalCost', 'purchasePrice', 'freight', 'handlingFee', 'specQty', 'specUnit', 'categoryName', 'brandName', 'bom'] as const) push(a.name, f, b[f], a[f]);
  }
  for (const [key, b] of was) if (!now.has(key)) out.push({ source: b.name, field: 'archive', label: '去掉的下级档案', before: b.name, after: null });
  return out;
}

export function stripCostChanges(changes: Change[]): Change[] {
  return changes.filter((c) => !COST_FIELDS.has(c.field));
}

export function parseSnapshot(text: unknown): Snapshot | null {
  if (typeof text !== 'string' || !text) return null;
  try {
    const s = JSON.parse(text) as Snapshot;
    return s && Array.isArray(s.archives) && s.profile ? s : null;
  } catch { return null; }
}

/** 同一个问题清单按“档案 + 从谁引用到它”分组，页面上用来“去修改” */
export function groupIssues(issues: Issue[]) {
  const map = new Map<string, { archiveKey: string; productId: number; archiveName: string; parentPath: string[]; messages: string[] }>();
  for (const i of issues) {
    const k = `${i.archiveKey}@${i.parentPath.join('>')}`;
    const g = map.get(k) ?? { archiveKey: i.archiveKey, productId: i.productId, archiveName: i.archiveName, parentPath: i.parentPath, messages: [] };
    if (!g.messages.includes(i.message)) g.messages.push(i.message);
    map.set(k, g);
  }
  return [...map.values()];
}

/** 马甲编码：YL- + sha256(公司,档案,马甲序号).前 20 位大写 */
export function aliasCode(companyId: number, productId: number, nameKey: string): string {
  return `YL-${crypto.createHash('sha256').update(JSON.stringify([companyId, productId, nameKey])).digest('hex').slice(0, 20).toUpperCase()}`;
}

export function rawNames(v: unknown): string[] {
  return [...new Set(str(v).split(/\r?\n/).map((x) => x.trim()).filter(Boolean))];
}

/** 要上传聚水潭的内容（字段名沿用聚水潭接口）。成本价、采购价按元。 */
export interface BaseCodeOutbound {
  sku_id: string; i_id: string; name: string; short_name: string; properties_value: string; c_name: string; brand: string; unit: string;
  weight: number | null; cost_price: number | null; purchase_price: number | null;
}

export async function baseCodeOutbound(em: EntityManager, companyId: number, bc: ResourceRecord): Promise<BaseCodeOutbound> {
  const p = await one(em, companyId, 'finance-products', bc.data.productId);
  const cat = await categoryPath(em, companyId, p?.data.categoryId ?? bc.data.categoryId);
  const brand = await one(em, companyId, 'finance-brands', p?.data.brandId);
  const w = num(p?.data.weightG) ?? num(bc.data.weightG);
  const cost = num(p?.data.totalCost) ?? num(bc.data.cost);
  const buy = num(p?.data.purchasePrice) ?? cost;
  const qty = num(p?.data.specQty);
  return {
    sku_id: str(bc.data.code),
    i_id: str(bc.data.styleCode),
    name: str(bc.data.name) || bc.title,
    short_name: str(bc.data.shortName),
    properties_value: str(bc.data.spec) || (qty !== null ? `${qty}${str(p?.data.specUnit)}` : ''),
    c_name: cat.map((c) => c.title).join('/'),
    brand: brand?.title ?? '',
    unit: str(p?.data.specUnit),
    weight: w === null ? null : Math.round(w) / 1000,
    cost_price: cost === null ? null : cost / 100,
    purchase_price: buy === null ? null : buy / 100,
  };
}

export const OUTBOUND_LABELS: Record<keyof BaseCodeOutbound, string> = {
  sku_id: '商品编码', i_id: '款式编码', name: '商品名称', short_name: '简称', properties_value: '颜色及规格', c_name: '分类', brand: '品牌',
  unit: '单位', weight: '重量(kg)', cost_price: '成本价', purchase_price: '采购价',
};

export function stripOutboundCost<T extends object>(o: T): T {
  const c = { ...o } as Record<string, unknown>;
  for (const k of ['cost_price', 'purchase_price', 'costPrice', 'purchasePrice']) delete c[k];
  return c as T;
}
