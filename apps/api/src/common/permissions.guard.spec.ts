import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthenticatedOnly, AuthUser, Public, RequirePermission, RequireResourceAction } from './auth.decorators';
import { PermissionsGuard } from './permissions.guard';

class Sample {
  @Public()
  open() {}

  @AuthenticatedOnly()
  mine() {}

  @RequirePermission('org.structure.view')
  protected_() {}

  @RequirePermission('org.structure.view', 'product.cost.view')
  needsTwo() {}

  @RequireResourceAction('secret')
  reveal() {}

  forgotten() {}
}

function contextFor(handlerName: keyof Sample, user?: AuthUser, type = 'stores'): ExecutionContext {
  return {
    getHandler: () => Sample.prototype[handlerName],
    getClass: () => Sample,
    switchToHttp: () => ({ getRequest: () => ({ user, params: { type } }) }),
  } as unknown as ExecutionContext;
}

const userWith = (allow: string[], deny: string[] = [], admin = false): AuthUser => ({
  id: 1,
  companyId: 1,
  name: 't',
  permissions: { isCompanyAdmin: admin, allow, deny },
});

describe('PermissionsGuard（默认拒绝）', () => {
  const guard = new PermissionsGuard(new Reflector());

  it('公开接口无需登录', () => {
    expect(guard.canActivate(contextFor('open'))).toBe(true);
  });

  it('没声明任何权限策略的接口一律拒绝，即使已登录', () => {
    expect(() => guard.canActivate(contextFor('forgotten', userWith([], [], true)))).toThrow(ForbiddenException);
  });

  it('未登录访问非公开接口被拒绝', () => {
    expect(() => guard.canActivate(contextFor('mine'))).toThrow(ForbiddenException);
  });

  it('AuthenticatedOnly 只要登录即可', () => {
    expect(guard.canActivate(contextFor('mine', userWith([])))).toBe(true);
  });

  it('有权限放行，没权限拒绝', () => {
    expect(guard.canActivate(contextFor('protected_', userWith(['org.structure.view'])))).toBe(true);
    expect(() => guard.canActivate(contextFor('protected_', userWith(['workbench.todos.view'])))).toThrow(ForbiddenException);
  });

  it('个人拒绝优先；管理员不受影响', () => {
    expect(() =>
      guard.canActivate(contextFor('protected_', userWith(['org.*'], ['org.structure.view']))),
    ).toThrow(ForbiddenException);
    expect(guard.canActivate(contextFor('protected_', userWith([], ['org.structure.view'], true)))).toBe(true);
  });

  it('要求多个权限时必须全部具备', () => {
    expect(() => guard.canActivate(contextFor('needsTwo', userWith(['org.structure.view'])))).toThrow(ForbiddenException);
    expect(guard.canActivate(contextFor('needsTwo', userWith(['org.structure.view', 'product.cost.view'])))).toBe(true);
  });

  describe('资料接口的动态权限（resource.<类型>.<动作>）', () => {
    it('有查看权限但没有 secret 权限时不能查看明文', () => {
      expect(() => guard.canActivate(contextFor('reveal', userWith(['resource.stores.view'])))).toThrow(ForbiddenException);
      expect(guard.canActivate(contextFor('reveal', userWith(['resource.stores.secret'])))).toBe(true);
    });

    it('权限按路径里的资料类型区分，店铺权限不能用来看手机号', () => {
      expect(() => guard.canActivate(contextFor('reveal', userWith(['resource.stores.secret']), 'phones'))).toThrow(ForbiddenException);
    });

    it('子资源沿用父资源权限；通配和个人拒绝仍然生效', () => {
      expect(guard.canActivate(contextFor('reveal', userWith(['resource.licenses.secret']), 'license-borrows'))).toBe(true);
      expect(guard.canActivate(contextFor('reveal', userWith(['resource.*'])))).toBe(true);
      expect(() => guard.canActivate(contextFor('reveal', userWith(['resource.*'], ['resource.stores.secret'])))).toThrow(ForbiddenException);
    });

    it('不存在的资料类型返回 404，而不是放行', () => {
      expect(() => guard.canActivate(contextFor('reveal', userWith([], [], true), 'nope'))).toThrow(/没有这种资料/);
    });
  });
});
