import 'reflect-metadata';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthUser } from '../common/auth.decorators';
import { PermissionsGuard } from '../common/permissions.guard';
import { ResourcesController } from './resources.controller';

describe('通用资源编号预览路由权限', () => {
  const guard = new PermissionsGuard(new Reflector());
  const context = (handler: 'codePreview' | 'codePreviewExisting', allow: string[]): ExecutionContext => ({
    getHandler: () => ResourcesController.prototype[handler], getClass: () => ResourcesController,
    switchToHttp: () => ({ getRequest: () => ({ params: { type: 'finance-labor-costs', id: '10' }, user: { id: 1, companyId: 1, name: '合成用户', permissions: { isCompanyAdmin: false, allow, deny: [] } } as AuthUser }) }),
  } as unknown as ExecutionContext);
  it('新建只允许新增权限，编辑只允许修改权限，查看权限不能借预览越权', () => {
    expect(guard.canActivate(context('codePreview', ['resource.finance-labor-costs.create']))).toBe(true);
    expect(guard.canActivate(context('codePreviewExisting', ['resource.finance-labor-costs.edit']))).toBe(true);
    expect(() => guard.canActivate(context('codePreview', ['resource.finance-labor-costs.edit']))).toThrow();
    expect(() => guard.canActivate(context('codePreviewExisting', ['resource.finance-labor-costs.create']))).toThrow();
    expect(() => guard.canActivate(context('codePreviewExisting', ['resource.finance-labor-costs.view']))).toThrow();
  });
});
