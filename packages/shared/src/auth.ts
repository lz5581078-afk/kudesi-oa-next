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

export interface LoginRequest {
  companyCode: string;
  account: string;
  password: string;
}

export interface LoginResponse {
  accessToken: string;
  user: CurrentUserDto;
}
