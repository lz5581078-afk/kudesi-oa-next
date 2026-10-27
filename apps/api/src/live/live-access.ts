import { EntityManager } from 'typeorm';
import { liveRooms, type LiveLocation, type LiveRoom } from '@kudesi/shared';
import type { AuthUser } from '../common/auth.decorators';
import { Row, can, liveFail, positionTypesOf } from './live-core';

/**
 * 直播管理里“这个人能做什么”：
 * 管理/查看靠权限键（features.live.view、live.manage、live.commissions.view、features.live-desk.view），
 * 能不能当主播、中控靠岗位类型（positions.workspace_type：live_anchor、live_control；运营岗位 operations 可以以中控资格上播）。
 * 绝不按岗位名称或部门名称判断。
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
  return {
    userId: user.id, companyId: user.companyId,
    canManage,
    canView: canManage || can(user, 'features.live.view'),
    canViewAll: can(user, 'live.commissions.view'),
    canDesk: can(user, 'features.live-desk.view'),
    isAnchor: types.has('live_anchor'),
    isLiveControl: types.has('live_control'),
    isControl: types.has('live_control') || types.has('operations'),
  };
}
export function requireView(a: LiveAccess) { if (!a.canView) liveFail('没有查看直播管理的权限', 403); }
export function requireManage(a: LiveAccess) { if (!a.canManage) liveFail('没有排场、修改提成规则的权限', 403); }
export function requireUse(a: LiveAccess) { if (!a.canView && !a.canDesk) liveFail('无权使用直播管理', 403); }

export interface LivePerson { id: number; name: string; detail: string; partTime: boolean }

/** 主播（岗位类型 live_anchor）、中控（live_control 或 operations）候选人。 */
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
  return { anchors: [...anchors.values()], controls: [...controls.values()] };
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
export async function liveRoomList(em: EntityManager, companyId: number): Promise<LiveRoom[]> {
  const rows: Row[] = await em.query("SELECT id, title, status, data, archived_at FROM resource_records WHERE company_id = ? AND type = 'locations'", [companyId]);
  const locations: LiveLocation[] = rows.map((r) => {
    const d = json(r.data);
    return { id: Number(r.id), name: String(d.name ?? r.title), parentId: d.parentId ? Number(d.parentId) : null, locationType: d.locationType ?? null, scope: d.scope ?? null, status: r.status, archived: !!r.archived_at };
  });
  return liveRooms(locations);
}

export interface LiveNamed { id: number; name: string; detail: string; jstShopId?: string }

/** 资料「自媒体账号」里平台为抖音、未停用的账号。 */
export async function liveDouyinAccounts(em: EntityManager, companyId: number): Promise<LiveNamed[]> {
  const rows: Row[] = await em.query(
    `SELECT id, title, data FROM resource_records WHERE company_id = ? AND type = 'self-media' AND archived_at IS NULL AND status NOT IN ('inactive','cancelled')
      AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.platform')) = 'douyin' ORDER BY title, id`, [companyId]);
  return rows.map((r) => ({ id: Number(r.id), name: json(r.data).name ?? r.title, detail: json(r.data).accountNo ?? '' }));
}

/** 资料「店铺档案」里平台为抖音、未注销的店铺；jstShopId 是店铺档案里填的聚水潭店铺编号。 */
export async function liveDouyinStores(em: EntityManager, companyId: number): Promise<LiveNamed[]> {
  const rows: Row[] = await em.query(
    `SELECT id, title, data FROM resource_records WHERE company_id = ? AND type = 'stores' AND archived_at IS NULL AND status NOT IN ('cancelled','inactive')
      AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.platform')) = 'douyin' ORDER BY title, id`, [companyId]);
  return rows.map((r) => ({ id: Number(r.id), name: json(r.data).name ?? r.title, detail: json(r.data).storeNo ?? '', jstShopId: String(json(r.data).jushuitanShopId ?? '').trim() }));
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
