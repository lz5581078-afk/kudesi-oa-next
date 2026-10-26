import { CanActivate, ExecutionContext, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createChecker, getResourceDef, permissionOwner, resourcePermission, ResourceAction } from '@kudesi/shared';
import { AUTHENTICATED_ONLY, AuthUser, IS_PUBLIC, REQUIRED_PERMISSIONS, RESOURCE_ACTION } from './auth.decorators';

/**
 * 全局权限守卫，默认拒绝：
 * 每个路由必须声明 @Public()、@AuthenticatedOnly() 或 @RequirePermission(...) 之一，
 * 漏写就返回 403。这样新增接口时不可能“忘了校验权限”（旧系统的资料接口大多没有服务端校验）。
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const user = context.switchToHttp().getRequest().user as AuthUser | undefined;
    if (!user) throw new ForbiddenException('未登录');

    const required = this.reflector.getAllAndOverride<string[] | undefined>(REQUIRED_PERMISSIONS, targets);
    if (required && required.length > 0) {
      const can = createChecker(user.permissions);
      const missing = required.filter((permission) => !can(permission));
      if (missing.length > 0) throw new ForbiddenException('没有权限执行此操作');
      return true;
    }

    const resourceAction = this.reflector.getAllAndOverride<ResourceAction | undefined>(RESOURCE_ACTION, targets);
    if (resourceAction) {
      const type = String(context.switchToHttp().getRequest().params?.type ?? '');
      if (!getResourceDef(type)) throw new NotFoundException('没有这种资料');
      if (!createChecker(user.permissions)(resourcePermission(permissionOwner(type), resourceAction))) {
        throw new ForbiddenException('没有权限执行此操作');
      }
      return true;
    }

    if (this.reflector.getAllAndOverride<boolean>(AUTHENTICATED_ONLY, targets)) return true;

    // 没声明任何权限策略：拒绝，并让开发者在测试中尽早发现
    throw new ForbiddenException('该接口没有声明权限策略');
  }
}
