import { EntityManager } from 'typeorm';
import { liveRooms, type LiveLocation, type LiveRoom, type LiveProductSnapshot, type LiveProductEntry } from '@kudesi/shared';
import type { AuthUser } from '../common/auth.decorators';
import { Row, can, idOf, liveFail, positionTypesOf } from './live-core';

/**
 * 直播管理里“这个人能做什么”：
 * 管理/查看靠权限键（features.live.view、live.manage、live.commissions.view、features.live-desk.view），
 * 主播、中控原有资格按岗位类型判断；按业务明确要求，传统电商部门在职人员也可担任中控。
 * 部门例外不修改岗位类型，也不授予管理、审批或菜单权限。
 */
export interface LiveAccess {
  userId: number;
  companyId: number;
  canView: boolean;
  canManage: boolean;
  canViewAll: boolean;
  canDesk: boolean;
  isAnchor: boolean;
  isControl: boolean;
  isLiveControl: boolean;
}

export async function loadLiveAccess(em: EntityManager, user: AuthUser): Promise<LiveAccess> {
  const types = await positionTypesOf(em, user.companyId, user.id);
  const canManage = can(user, 'live.manage');
  const departmentControl = !types.has('live_control') && !types.has('operations') && (await traditionalControlPeople(em, user.companyId, user.id)).length > 0;
  return {
    userId: user.id, companyId: user.companyId,
    canManage,
    canView: canManage || can(user, 'features.live.view'),
    canViewAll: can(user, 'live.commissions.view'),
    canDesk: can(user, 'features.live-desk.view'),
    isAnchor: types.has('live_anchor'),
    isLiveControl: types.has('live_control'),
    isControl: types.has('live_control') || types.has('operations') || departmentControl,
  };
}
export function requireView(a: LiveAccess) { if (!a.canView) liveFail('没有查看直播管理的权限', 403); }
export function requireManage(a: LiveAccess) { if (!a.canManage) liveFail('没有排场、修改提成规则的权限', 403); }
export function requireUse(a: LiveAccess) { if (!a.canView && !a.canDesk) liveFail('无权使用直播管理', 403); }

export interface LivePerson { id: number; name: string; detail: string; partTime: boolean; trial?: boolean }

/** 用户明确指定的部门范围；完整名称匹配，避免把同名岗位或其他协作部门误纳入。 */
const TRADITIONAL_ECOMMERCE_DEPARTMENTS = new Set(['传统电商', '传统电商部', '传统电商部门']);

async function traditionalControlPeople(em: EntityManager, companyId: number, userId?: number): Promise<LivePerson[]> {
  const departments: Row[] = await em.query('SELECT id, parent_id, name, status FROM departments WHERE company_id = ?', [companyId]);
  const active = departments.filter((d) => d.status === 'active');
  const ids = new Set<number>(active.filter((d) => TRADITIONAL_ECOMMERCE_DEPARTMENTS.has(String(d.name).trim())).map((d) => Number(d.id)));
  // 只沿启用的部门向下展开；停用的部门不会成为通向下级部门的桥梁。
  let previous = -1;
  while (previous !== ids.size) {
    previous = ids.size;
    for (const d of active) if (ids.has(Number(d.parent_id))) ids.add(Number(d.id));
  }
  if (!ids.size) return [];
  const list = [...ids], placeholders = list.map(() => '?').join(',');
  const rows: Row[] = await em.query(
    `SELECT u.id, u.name, u.employment_type, p.name position_name, COALESCE(pd.name, ud.name) department_name
       FROM users u
       LEFT JOIN departments ud ON ud.id = u.department_id AND ud.company_id = u.company_id AND ud.status = 'active'
       LEFT JOIN positions p ON p.company_id = u.company_id AND p.status = 'active' AND p.department_id IN (${placeholders})
        AND (p.id = u.position_id OR JSON_CONTAINS(COALESCE(u.extra_position_ids, JSON_ARRAY()), CAST(p.id AS JSON)))
       LEFT JOIN departments pd ON pd.id = p.department_id AND pd.company_id = u.company_id AND pd.status = 'active'
      WHERE u.company_id = ? AND u.status = 'active' AND (ud.id IN (${placeholders}) OR pd.id IS NOT NULL)
        ${userId === undefined ? '' : 'AND u.id = ?'}
      ORDER BY u.id, p.id`, [...list, companyId, ...list, ...(userId === undefined ? [] : [userId])]);
  const people = new Map<number, LivePerson>();
  for (const r of rows) if (!people.has(Number(r.id))) people.set(Number(r.id), {
    id: Number(r.id), name: r.name, partTime: !!r.employment_type && r.employment_type !== 'regular',
    detail: [r.department_name, r.position_name].filter(Boolean).join(' · '),
  });
  return [...people.values()];
}

/** 主播仍按live_anchor；中控包含live_control、operations及明确指定的传统电商部门人员。 */
export async function livePeople(em: EntityManager, companyId: number): Promise<{ anchors: LivePerson[]; controls: LivePerson[] }> {
  const rows: Row[] = await em.query(
    `SELECT u.id, u.name, u.employment_type, p.name position_name, p.workspace_type, d.name department_name
       FROM users u JOIN positions p ON p.company_id = u.company_id AND p.status = 'active'
        AND (p.id = u.position_id OR JSON_CONTAINS(COALESCE(u.extra_position_ids, JSON_ARRAY()), CAST(p.id AS JSON)))
       LEFT JOIN departments d ON d.id = p.department_id AND d.company_id = u.company_id
      WHERE u.company_id = ? AND u.status = 'active' AND p.workspace_type IN ('live_anchor','live_control','operations') ORDER BY u.id`, [companyId]);
  const anchors = new Map<number, LivePerson>(), controls = new Map<number, LivePerson>();
  for (const r of rows) {
    const person: LivePerson = { id: Number(r.id), name: r.name, partTime: !!r.employment_type && r.employment_type !== 'regular', detail: [r.department_name, r.position_name].filter(Boolean).join(' · ') };
    if (r.workspace_type === 'live_anchor') anchors.set(person.id, person);
    else controls.set(person.id, person);
  }
  const trials: Row[] = await em.query("SELECT id,name FROM users WHERE company_id=? AND status='active' AND live_trial=1 ORDER BY id", [companyId]);
  for (const r of trials) anchors.set(Number(r.id), { id:Number(r.id), name:r.name, detail:'试播主播', partTime:true, trial:true });
  for (const person of await traditionalControlPeople(em, companyId)) if (!controls.has(person.id)) controls.set(person.id, person);
  return { anchors: [...anchors.values()], controls: [...controls.values()].sort((a, b) => a.id - b.id) };
}

/** 所有在职员工（运营可以是任何人）。 */
export async function liveEmployees(em: EntityManager, companyId: number): Promise<LivePerson[]> {
  const rows: Row[] = await em.query(
    `SELECT u.id, u.name, u.employment_type, d.name department_name FROM users u LEFT JOIN departments d ON d.id = u.department_id AND d.company_id = u.company_id
      WHERE u.company_id = ? AND u.status = 'active' ORDER BY u.id`, [companyId]);
  return rows.map((r) => ({ id: Number(r.id), name: r.name, partTime: !!r.employment_type && r.employment_type !== 'regular', detail: r.department_name ?? '' }));
}

const json = (v: unknown): Record<string, any> => (typeof v === 'string' ? JSON.parse(v) : (v as Record<string, any>)) ?? {}; // eslint-disable-line @typescript-eslint/no-explicit-any

/** 资料「房间与档案位置」→ 直播间（西走廊办公室下名称含「直播间」的启用房间）。 */
export async function liveRoomList(em: EntityManager, companyId: number): Promise<Array<LiveRoom & {ownerId:number|null; ownerName:string; products:string}>> {
  const rows: Row[] = await em.query("SELECT id, title, status, data, archived_at FROM resource_records WHERE company_id = ? AND type = 'locations'", [companyId]);
  const locations: LiveLocation[] = rows.map((r) => {
    const d = json(r.data);
    return { id: Number(r.id), name: String(d.name ?? r.title), parentId: d.parentId ? Number(d.parentId) : null, locationType: d.locationType ?? null, scope: d.scope ?? null, status: r.status, archived: !!r.archived_at };
  });
  const settings: Row[] = await em.query(`SELECT r.room_id,r.owner_user_id,r.products,u.name owner_name FROM live_room_settings r LEFT JOIN users u ON u.company_id=r.company_id AND u.id=r.owner_user_id WHERE r.company_id=?`, [companyId]);
  return liveRooms(locations).map((r) => { const v=settings.find((x)=>Number(x.room_id)===r.id); return {...r, ownerId:v?.owner_user_id ? Number(v.owner_user_id):null, ownerName:v?.owner_name??'', products:v?.products??''}; });
}

export interface LiveNamed { id: number; name: string; detail: string; jstShopId?: string; platform?: string; storeIds?: number[] }

/** 资料「自媒体账号」里有直播权限、未停用的各平台账号。 */
export async function liveDouyinAccounts(em: EntityManager, companyId: number): Promise<LiveNamed[]> {
  const rows: Row[] = await em.query(
    `SELECT id, title, data FROM resource_records WHERE company_id = ? AND type = 'self-media' AND archived_at IS NULL AND status NOT IN ('inactive','cancelled')
      AND JSON_EXTRACT(data, '$.livePermission') = true ORDER BY title, id`, [companyId]);
  return rows.map((r) => ({ id: Number(r.id), name: json(r.data).name ?? r.title, detail: json(r.data).accountNo ?? '', platform: json(r.data).platform, storeIds: [...new Set([json(r.data).storeId, ...(json(r.data).storeIds ?? [])].filter(Boolean).map(Number))] }));
}

/** 资料「店铺档案」里未注销的各平台店铺；jstShopId 是店铺档案里填的聚水潭店铺编号。 */
export async function liveDouyinStores(em: EntityManager, companyId: number): Promise<LiveNamed[]> {
  const rows: Row[] = await em.query(
    `SELECT id, title, data FROM resource_records WHERE company_id = ? AND type = 'stores' AND archived_at IS NULL AND status NOT IN ('cancelled','inactive')
      ORDER BY title, id`, [companyId]);
  return rows.map((r) => ({ id: Number(r.id), name: json(r.data).name ?? r.title, detail: json(r.data).storeNo ?? '', platform: json(r.data).platform, jstShopId: String(json(r.data).jushuitanShopId ?? '').trim() }));
}

/** 在卖产品：商品基础编码，只返回编码、名称、规格，绝不返回成本字段。 */
export async function liveProducts(em: EntityManager, companyId: number, ids: number[] | null, keyword = ''): Promise<Array<{ id: number; code: string; name: string; spec: string }>> {
  if (ids && !ids.length) return [];
  const where = ["company_id = ?", "type = 'finance-base-codes'", 'archived_at IS NULL', "status NOT IN ('disabled','deleted')"], params: unknown[] = [companyId];
  if (ids) { where.push(`id IN (${ids.map(() => '?').join(',')})`); params.push(...ids); }
  if (keyword) { where.push("(title LIKE ? OR search_text LIKE ?)"); params.push(`%${keyword}%`, `%${keyword.toLowerCase()}%`); }
  const rows: Row[] = await em.query(`SELECT id, title, data FROM resource_records WHERE ${where.join(' AND ')} ORDER BY title LIMIT ${ids ? 200 : 50}`, params);
  return rows.map((r) => ({ id: Number(r.id), code: r.title, name: json(r.data).name ?? '', spec: json(r.data).spec ?? '' }));
}

/** 原产品编号接口继续兼容；新输入逐项区分真实引用与手填名称，保留顺序。 */
export async function resolveLiveProducts(em: EntityManager, companyId: number, input: { productIds?: number[]; productEntries?: LiveProductEntry[] }, required = false): Promise<LiveProductSnapshot[]> {
  if (input.productIds !== undefined && input.productEntries !== undefined) liveFail('产品输入不能同时使用两种格式', 400);
  if ((input.productIds != null && !Array.isArray(input.productIds)) || (input.productEntries != null && !Array.isArray(input.productEntries))) liveFail('产品格式无效', 400);
  const entries: LiveProductEntry[] = input.productEntries ?? (input.productIds ?? []).map((productId) => ({ productId }));
  if (entries.length > 100) liveFail('最多填写 100 个产品', 400);
  if (required && !entries.length) liveFail('请至少填写 1 个在卖产品', 400);
  for (const e of entries) {
    if (!e || typeof e !== 'object' || Array.isArray(e) || Object.keys(e).some((k) => !['productId', 'name'].includes(k))) liveFail('产品格式无效', 400);
    const hasId = e.productId != null, hasName = e.name != null;
    if (hasId === hasName) liveFail('每项产品只能填写名称或引用已有产品', 400);
    if (hasId && (!Number.isSafeInteger(e.productId) || !idOf(e.productId))) liveFail('产品编号无效', 400);
    if (hasName && (typeof e.name !== 'string' || !e.name.trim() || e.name.trim().length > 200)) liveFail('产品名称不能为空且不能超过 200 个字符', 400);
  }
  const ids = [...new Set(entries.filter((e) => e.productId != null).map((e) => e.productId!))];
  const catalog = new Map((await liveProducts(em, companyId, ids)).map((p) => [p.id, p]));
  if (catalog.size !== ids.length) liveFail('有产品不存在或已停用，请重新选择', 400);
  const used = new Set<number>(), products: LiveProductSnapshot[] = [];
  for (const e of entries) {
    if (e.productId != null) {
      if (!used.has(e.productId)) { products.push(catalog.get(e.productId)!); used.add(e.productId); }
    } else products.push({ id: null, code: '', name: e.name!.trim(), spec: '' });
  }
  return products;
}
