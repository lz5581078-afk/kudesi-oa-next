/**
 * 发起人范围：这条流程允许哪些部门/岗位/角色（岗位类型）/职责组/具体员工发起。
 * 沿用旧系统（采购、专属品领取真实配置过：多个来源任一命中即可，公司管理员始终可发起）。
 * 范围为空 = 不限制，沿用“有申请中心权限即可发起”的原有行为（向后兼容）。随流程版本保存、发布后生效。
 */
import { POSITION_TYPE_LABEL } from './flow';

export interface StarterScope {
  users?: number[];
  departments?: number[];
  positions?: number[];
  /** 角色 = 岗位类型（positions.workspace_type） */
  positionTypes?: string[];
  dutyGroups?: number[];
}

export const STARTER_SCOPE_KEYS = ['users', 'departments', 'positions', 'positionTypes', 'dutyGroups'] as const;
export type StarterScopeKey = (typeof STARTER_SCOPE_KEYS)[number];
export const STARTER_SCOPE_LABEL: Record<StarterScopeKey, string> = { users: '指定员工', departments: '部门', positions: '岗位', positionTypes: '角色', dutyGroups: '职责组' };
const MAX_EACH = 200;

/** 发起人的身份快照（服务端从数据库取，绝不读请求） */
export interface StarterWho { userId: number; departmentId: number | null; positionIds: number[]; positionTypes: string[]; dutyGroupIds: number[] }

export const starterScopeEmpty = (s: StarterScope | null | undefined): boolean => !s || STARTER_SCOPE_KEYS.every((k) => (s[k]?.length ?? 0) === 0);

/** 整理并校验保存的范围：只留认识的键、去重、编号必须是正整数、角色必须是已知岗位类型。全空返回 null。 */
export function normalizeStarterScope(input: unknown): { scope: StarterScope | null; errors: string[] } {
  if (input === null || input === undefined) return { scope: null, errors: [] };
  if (typeof input !== 'object' || Array.isArray(input)) return { scope: null, errors: ['发起人范围的格式不对'] };
  const src = input as Record<string, unknown>;
  const errors: string[] = [];
  for (const k of Object.keys(src)) if (!(STARTER_SCOPE_KEYS as readonly string[]).includes(k)) errors.push(`发起人范围里有不认识的项「${k}」`);
  const out: StarterScope = {};
  for (const k of STARTER_SCOPE_KEYS) {
    const v = src[k];
    if (v === undefined || v === null) continue;
    if (!Array.isArray(v)) { errors.push(`发起人范围的「${STARTER_SCOPE_LABEL[k]}」格式不对`); continue; }
    if (v.length > MAX_EACH) { errors.push(`发起人范围的「${STARTER_SCOPE_LABEL[k]}」最多 ${MAX_EACH} 项`); continue; }
    if (k === 'positionTypes') {
      const bad = v.find((x) => typeof x !== 'string' || !POSITION_TYPE_LABEL[x]);
      if (bad !== undefined) { errors.push('发起人范围里有不认识的角色'); continue; }
      if (v.length) out.positionTypes = [...new Set(v as string[])];
    } else {
      if (v.some((x) => !Number.isInteger(x) || (x as number) < 1)) { errors.push(`发起人范围的「${STARTER_SCOPE_LABEL[k]}」编号不合法`); continue; }
      if (v.length) out[k] = [...new Set(v as number[])];
    }
  }
  return { scope: errors.length || starterScopeEmpty(out) ? null : out, errors };
}

/** 这个人在不在范围内（不含“公司管理员始终可发起”，那一条由服务端先判断）。范围为空 = 不限制。 */
export function starterScopeAllows(scope: StarterScope | null | undefined, who: StarterWho): boolean {
  if (starterScopeEmpty(scope)) return true;
  const s = scope!;
  if (s.users?.includes(who.userId)) return true;
  if (who.departmentId != null && s.departments?.includes(who.departmentId)) return true;
  if (who.positionIds.some((p) => s.positions?.includes(p))) return true;
  if (who.positionTypes.some((t) => s.positionTypes?.includes(t))) return true;
  if (who.dutyGroupIds.some((g) => s.dutyGroups?.includes(g))) return true;
  return false;
}
