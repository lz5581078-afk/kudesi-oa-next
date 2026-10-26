import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { EffectivePermissions, ResourceAction } from '@kudesi/shared';

/** 当前请求的登录人。身份只来自令牌 + 数据库，绝不来自请求体。 */
export interface AuthUser {
  id: number;
  companyId: number;
  name: string;
  permissions: EffectivePermissions;
}

export const IS_PUBLIC = 'auth:public';
export const AUTHENTICATED_ONLY = 'auth:authenticated-only';
export const REQUIRED_PERMISSIONS = 'auth:permissions';
export const RESOURCE_ACTION = 'auth:resource-action';

/** 无需登录（仅登录、健康检查等） */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** 只要登录即可，不要求具体权限（如查看自己的信息）。必须显式声明，不能省略。 */
export const AuthenticatedOnly = () => SetMetadata(AUTHENTICATED_ONLY, true);

/** 需要全部列出的权限键。 */
export const RequirePermission = (...permissions: string[]) => SetMetadata(REQUIRED_PERMISSIONS, permissions);

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user as AuthUser;
});

/**
 * 资料接口专用：权限键由路径里的资源类型 + 动作拼出（resource.<type>.<action>），
 * 由全局守卫校验。子资源沿用父资源的权限。
 */
export const RequireResourceAction = (action: ResourceAction) => SetMetadata(RESOURCE_ACTION, action);
