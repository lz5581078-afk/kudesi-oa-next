/**
 * 权限模型（前后端共用同一份实现，避免“菜单隐藏≠接口受限”）。
 *
 * 权限键形如 `product.bundles.view`，点号分隔。
 * - 岗位权限 + 个人“允许”叠加成授予集合
 * - 个人“拒绝”优先于一切授予（包括岗位权限）
 * - 公司管理员不受个人“拒绝”影响，防止把自己锁在系统外
 * - 通配：`*` 匹配全部，`product.*` 匹配 `product.` 开头的所有键
 */

export type PermissionEffect = 'allow' | 'deny';

export interface PermissionOverride {
  permission: string;
  effect: PermissionEffect;
}

export interface PermissionInput {
  isCompanyAdmin: boolean;
  /** 岗位授予的权限（可含通配） */
  positionPermissions: readonly string[];
  /** 员工个人覆盖 */
  overrides: readonly PermissionOverride[];
}

/** 可序列化的有效权限，后端放进 /auth/me，前端据此判断菜单与按钮。 */
export interface EffectivePermissions {
  isCompanyAdmin: boolean;
  allow: string[];
  deny: string[];
}

export function matchesPermission(pattern: string, permission: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) {
    return permission.startsWith(pattern.slice(0, -1));
  }
  return pattern === permission;
}

export function resolvePermissions(input: PermissionInput): EffectivePermissions {
  const allow = new Set<string>(input.positionPermissions);
  const deny = new Set<string>();
  for (const item of input.overrides) {
    if (item.effect === 'allow') allow.add(item.permission);
    else deny.add(item.permission);
  }
  return {
    isCompanyAdmin: input.isCompanyAdmin,
    allow: [...allow].sort(),
    deny: [...deny].sort(),
  };
}

export type PermissionChecker = (permission: string) => boolean;

export function createChecker(effective: EffectivePermissions): PermissionChecker {
  return (permission: string) => {
    if (effective.isCompanyAdmin) return true;
    if (effective.deny.some((p) => matchesPermission(p, permission))) return false;
    return effective.allow.some((p) => matchesPermission(p, permission));
  };
}
