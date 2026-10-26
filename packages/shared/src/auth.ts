import type { EffectivePermissions } from './permissions';

/** 登录与 /auth/me 返回给前端的当前用户。 */
export interface CurrentUserDto {
  id: number;
  name: string;
  account: string;
  companyId: number;
  companyName: string;
  positionName: string | null;
  mustChangePassword: boolean;
  permissions: EffectivePermissions;
}

/** 登录只需要账号和密码：账号在全系统唯一，公司由账号决定。 */
export interface LoginRequest {
  account: string;
  password: string;
}

/** 平台管理员（酷得斯自己人，不属于任何公司）。 */
export interface PlatformAdminDto {
  id: number;
  name: string;
  account: string;
}

export type LoginResponse =
  | { type: 'company'; accessToken: string; user: CurrentUserDto }
  | { type: 'platform'; accessToken: string; admin: PlatformAdminDto };
