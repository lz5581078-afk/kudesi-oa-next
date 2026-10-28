import { EntityManager, SelectQueryBuilder } from 'typeorm';
import { addDaysText, getResourceDef, phoneStoreImportColumns, viewFiltersOf, PHONE_RECHARGE_DAYS, MEMO_DUE_DAYS } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { Department, ResourceRecord } from '../entities';
import { applyCond } from './def-conditions';

/**
 * 店铺与账号类资料的“按日期实时算”的筛选，以及手机号 <-> 店铺 的派生信息与导入绑定（旧系统行为）。
 * 条件按今天的日期在查询时计算，不存成字段，所以不会过期失真。
 */

/** 这个基础编码是不是某个马甲指向的真实编码（马甲没归档） */
export const HAS_ALIAS = `EXISTS (SELECT 1 FROM resource_records a WHERE a.company_id = r.company_id AND a.type = 'finance-base-codes' AND a.archived_at IS NULL AND JSON_EXTRACT(a.data, '$.canonicalId') = r.id)`;

const J = (k: string) => `JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.${k}'))`;

export function isViewFilter(type: string, key: string): boolean {
  return viewFiltersOf(type).some((f) => f.key === key) || (type === 'finance-base-codes' && key === 'brandId');
}

/** 给列表查询加上一个虚拟筛选；值不在选项里就报不合法由调用方处理（这里返回 false） */
export async function applyViewFilter(
  qb: SelectQueryBuilder<ResourceRecord>,
  em: EntityManager,
  companyId: number,
  type: string,
  key: string,
  value: string,
  today: string,
  idx: number,
): Promise<boolean> {
  // 基础编码按品牌筛选：品牌取自来源商品档案（多构成编码取自己的编码品牌）；选项是公司的品牌清单，不是固定值
  if (type === 'finance-base-codes' && key === 'brandId') {
    if (!/^\d{1,12}$/.test(value)) return false;
    const pid = `brand${idx}`;
    qb.andWhere(`(JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.codeBrandId')) = :${pid} OR (JSON_EXTRACT(r.data, '$.codeBrandId') IS NULL AND JSON_EXTRACT(r.data, '$.productId') IN (SELECT p.id FROM resource_records p WHERE p.company_id = r.company_id AND p.type = 'finance-products' AND JSON_UNQUOTE(JSON_EXTRACT(p.data, '$.brandId')) = :${pid})))`, { [pid]: value });
    return true;
  }
  const def = viewFiltersOf(type).find((f) => f.key === key);
  const cf = getResourceDef(type)?.computedFilters?.find((f) => f.key === key);
  if (cf?.optionsFrom === 'departments' && cf.when) {
    // 部门由服务端按公司现有部门校验（别家公司的部门不认）
    const dept = /^\d+$/.test(value) ? await em.getRepository(Department).findOne({ where: { id: Number(value), companyId } }) : null;
    if (!dept) return false;
    applyCond(qb, getResourceDef(type)!, cf.when, `cf${idx}x`, value);
    return true;
  }
  if (!def || !def.options.some((o) => o.value === value)) return false;
  const computed = cf?.options?.find((o) => o.value === value);
  if (computed) {
    applyCond(qb, getResourceDef(type)!, computed.when, `cf${idx}x`);
    return true;
  }
  const p = (name: string) => `${name}${idx}`;
  if (type === 'stores' && key === 'jstExpiry') {
    qb.andWhere(`${J('jushuitan')} = 'connected' AND ${J('jushuitanExpireAt')} IS NOT NULL AND ${J('jushuitanExpireAt')} <> ''`);
    if (value === 'expired') qb.andWhere(`${J('jushuitanExpireAt')} < :${p('t')}`, { [p('t')]: today });
    else if (value === 'urgent') qb.andWhere(`${J('jushuitanExpireAt')} >= :${p('t')} AND ${J('jushuitanExpireAt')} <= :${p('u')}`, { [p('t')]: today, [p('u')]: addDaysText(today, 15) });
    else qb.andWhere(`${J('jushuitanExpireAt')} > :${p('t')} AND ${J('jushuitanExpireAt')} <= :${p('u')}`, { [p('t')]: addDaysText(today, 15), [p('u')]: addDaysText(today, 30) });
    return true;
  }
  if (type === 'finance-base-codes' && key === 'realView') {
    qb.andWhere(`NOT (r.status = 'verified' AND ${HAS_ALIAS})`);
    return true;
  }
  if (type === 'stores' && key === 'legacyOwner') {
    qb.andWhere(`COALESCE(${J('legacyOwnerName')}, '') <> '' AND JSON_EXTRACT(r.data, '$.operatorUserId') IS NULL AND r.status NOT IN ('inactive', 'cancelled')`);
    return true;
  }
  if (type === 'phones' && key === 'card') {
    qb.andWhere(value === 'sub' ? `JSON_EXTRACT(r.data, '$.parentPhoneId') IS NOT NULL` : `JSON_EXTRACT(r.data, '$.parentPhoneId') IS NULL`);
    return true;
  }
  if (type === 'phones' && key === 'recharge') {
    qb.andWhere(`r.status <> 'inactive' AND ${J('nextRechargeAt')} IS NOT NULL AND ${J('nextRechargeAt')} <> '' AND ${J('nextRechargeAt')} <= :${p('u')}`, { [p('u')]: addDaysText(today, PHONE_RECHARGE_DAYS) });
    return true;
  }
  if (type === 'phones' && key === 'storePlatform') {
    const stores = await em.find(ResourceRecord, { where: { companyId, type: 'stores' }, select: ['id', 'data', 'archivedAt'] });
    const bound = new Map<number, Set<string>>();
    for (const s of stores) {
      if (s.archivedAt) continue;
      for (const id of storePhoneIds(s.data)) bound.set(id, (bound.get(id) ?? new Set()).add(String(s.data.platform ?? '')));
    }
    const ids = [...bound.entries()].filter(([, platforms]) => platforms.has(value)).map(([id]) => id);
    if (value === '__none') {
      const all = [...bound.keys()];
      if (all.length) qb.andWhere('r.id NOT IN (:...' + p('ids') + ')', { [p('ids')]: all });
    } else qb.andWhere('r.id IN (:...' + p('ids') + ')', { [p('ids')]: ids.length ? ids : [0] });
    return true;
  }
  if (type === 'memos' && key === 'memoView') {
    if (value === 'domain') {
      qb.andWhere(`${J('kind')} = 'service' AND (LOWER(COALESCE(${J('serviceType')}, '')) LIKE '%域名%' OR LOWER(COALESCE(${J('serviceType')}, '')) LIKE '%domain%' OR LOWER(COALESCE(${J('title')}, '')) LIKE '%域名%' OR LOWER(COALESCE(${J('title')}, '')) LIKE '%domain%')`);
    } else if (value === 'dueSoon') {
      qb.andWhere(`r.status <> 'inactive' AND ${J('endAt')} >= :${p('t')} AND ${J('endAt')} <= :${p('u')}`, { [p('t')]: today, [p('u')]: addDaysText(today, MEMO_DUE_DAYS) });
    } else {
      qb.andWhere(`r.status <> 'inactive' AND ${J('endAt')} IS NOT NULL AND ${J('endAt')} <> '' AND ${J('endAt')} < :${p('t')}`, { [p('t')]: today });
    }
    return true;
  }
  return false;
}

function storePhoneIds(data: Record<string, unknown>): number[] {
  const out: number[] = [];
  for (const v of [data.phoneId, ...(Array.isArray(data.phoneIds) ? data.phoneIds : [])]) if (typeof v === 'number' && !out.includes(v)) out.push(v);
  return out;
}

/** 手机号列表/详情上的派生信息：绑定店铺、店铺编号、主子卡（不存库，读时从店铺档案和主卡字段算） */
export async function derivePhoneFields(em: EntityManager, companyId: number, records: ResourceRecord[], parentLabels: (r: ResourceRecord) => string | undefined) {
  const out = new Map<number, Record<string, unknown>>();
  if (!records.length) return out;
  const platformLabel = new Map((getResourceDef('stores')?.fields.find((f) => f.key === 'platform')?.options ?? []).map((o) => [o.value, o.label]));
  const stores = await em.find(ResourceRecord, { where: { companyId, type: 'stores' }, select: ['id', 'title', 'data', 'archivedAt'] });
  const byPhone = new Map<number, ResourceRecord[]>();
  for (const s of stores) {
    if (s.archivedAt) continue;
    for (const id of storePhoneIds(s.data)) byPhone.set(id, [...(byPhone.get(id) ?? []), s]);
  }
  // 自媒体账号、微信号档案里绑了这个手机号的（按手机号档案 id 或号码文本）
  const [medias, wechats] = await Promise.all(['self-media', 'wechat'].map((type) => em.find(ResourceRecord, { where: { companyId, type }, select: ['id', 'title', 'data', 'archivedAt'] })));
  const mediaPlatform = new Map((getResourceDef('self-media')?.fields.find((f) => f.key === 'platform')?.options ?? []).map((o) => [o.value, o.label]));
  const accountsOf = (phone: ResourceRecord): string => {
    const hit = (x: ResourceRecord) => !x.archivedAt && (Number(x.data.phoneId) === phone.id || (!x.data.phoneId && x.data.phoneNumber && String(x.data.phoneNumber) === String(phone.data.number)));
    const m = medias.filter(hit).map((x) => `${mediaPlatform.get(String(x.data.platform)) ?? ''}·${x.title}`);
    const w = wechats.filter(hit).map((x) => `微信·${x.title}`);
    return [...m, ...w].join('、');
  };
  for (const r of records) {
    const list = byPhone.get(r.id) ?? [];
    const parent = typeof r.data.parentPhoneId === 'number';
    const perPlatform: Record<string, string | undefined> = {};
    for (const [value] of platformLabel) {
      perPlatform[`stores${value[0].toUpperCase()}${value.slice(1)}`] = list.filter((s) => String(s.data.platform) === value).map((s) => s.title).join('、') || undefined;
    }
    out.set(r.id, {
      cardKind: parent ? `子卡（主卡 ${parentLabels(r) ?? ''}）`.replace('（主卡 ）', '') : '主卡',
      boundStores: list.map((s) => `${platformLabel.get(String(s.data.platform)) ?? ''}·${s.title}`).join('、') || undefined,
      boundStoreNos: list.map((s) => String(s.data.storeNo ?? s.data.platformStoreId ?? '')).filter(Boolean).join('、') || undefined,
      boundAccounts: accountsOf(r) || undefined,
      ...perPlatform,
    });
  }
  return out;
}

export interface PhoneImportResult {
  warnings: string[];
}

/**
 * 手机号导入里的“<平台>编号 / <平台>店铺”列：把这张号码绑到对应平台的那家店铺，
 * 并且从该平台上原来绑着它的其他店铺解绑（一个手机号在一个平台只绑一家，旧系统逻辑）。
 * 匹配不到店铺不阻止导入，只给出提示。
 */
export async function bindPhoneStores(
  em: EntityManager,
  user: AuthUser,
  phone: ResourceRecord,
  row: Record<string, string>,
  saveStore: (existing: ResourceRecord, input: Record<string, unknown>) => Promise<unknown>,
): Promise<PhoneImportResult> {
  const warnings: string[] = [];
  const cols = phoneStoreImportColumns().filter((c) => (row[c.noHeader] ?? '').trim() || (row[c.nameHeader] ?? '').trim());
  if (!cols.length) return { warnings };
  const stores = await em.find(ResourceRecord, { where: { companyId: user.companyId, type: 'stores' } });
  const live = stores.filter((s) => !s.archivedAt);
  for (const c of cols) {
    const no = (row[c.noHeader] ?? '').trim();
    const name = (row[c.nameHeader] ?? '').trim();
    const same = live.filter((s) => s.data.platform === c.platform);
    const target =
      (no && same.find((s) => String(s.data.storeNo ?? '') === no || String(s.data.platformStoreId ?? '') === no || String(s.id) === no)) ||
      (name && same.find((s) => s.title === name)) ||
      null;
    if (!target) {
      warnings.push(`${c.label}店铺「${[no, name].filter(Boolean).join(' / ')}」没有匹配到`);
      continue;
    }
    // 先从同平台其他店铺解绑
    for (const other of same) {
      if (other.id === target.id) continue;
      const ids = storePhoneIds(other.data);
      if (!ids.includes(phone.id)) continue;
      const rest = ids.filter((x) => x !== phone.id);
      await saveStore(other, { phoneId: rest[0] ?? null, phoneIds: rest.length > 1 ? rest.slice(1) : null });
      other.data = { ...other.data, phoneId: rest[0], phoneIds: rest.slice(1) };
    }
    const ids = storePhoneIds(target.data);
    if (ids.includes(phone.id)) continue;
    const all = [...ids, phone.id];
    await saveStore(target, { phoneId: all[0], phoneIds: all.length > 1 ? all.slice(1) : null });
    target.data = { ...target.data, phoneId: all[0], phoneIds: all.slice(1) };
  }
  return { warnings };
}

/** 店铺导入：“所属执照”可以填执照名称，也可以填统一社会信用代码（旧系统按信用代码匹配） */
export async function mapLicenseByCreditCode(em: EntityManager, companyId: number, text: string): Promise<string> {
  const v = text.trim();
  if (!v) return v;
  const licenses = await em.find(ResourceRecord, { where: { companyId, type: 'licenses' }, select: ['id', 'title', 'data'] });
  if (licenses.some((l) => l.title === v)) return v;
  const hit = licenses.filter((l) => String(l.data.creditCode ?? '').toUpperCase() === v.toUpperCase());
  if (hit.length === 1) return hit[0].title;
  const byNo = licenses.filter((l) => String(l.data.licenseNo ?? '') === v);
  return byNo.length === 1 ? byNo[0].title : v;
}
