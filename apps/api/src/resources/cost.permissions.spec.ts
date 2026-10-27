import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthUser } from '../common/auth.decorators';
import { PermissionsGuard } from '../common/permissions.guard';
import { CostController } from './cost.controller';

const user = (allow: string[]): AuthUser => ({ id: 1, companyId: 1, name: 't', permissions: { isCompanyAdmin: false, allow, deny: [] } });
const guard = new PermissionsGuard(new Reflector());
const can = (handler: keyof CostController, u: AuthUser) => {
  const ctx = { getHandler: () => CostController.prototype[handler], getClass: () => CostController, switchToHttp: () => ({ getRequest: () => ({ user: u, params: {} }) }) } as unknown as ExecutionContext;
  try { return guard.canActivate(ctx); } catch (e) { if (e instanceof ForbiddenException) return false; throw e; }
};

describe('成本表 / 定价调试表的接口权限', () => {
  const pageOnly = user(['finance.cost-table.view', 'finance.pricing-debug.view', 'finance.cost-history.view']);
  const viewer = user(['finance.cost-table.view', 'finance.cost-history.view', 'product.cost.view']);
  const editor = user(['finance.cost-table.view', 'product.cost.view', 'product.cost.edit']);
  const ops = user(['finance.pricing-debug.view']);

  it('没有 product.cost.view：成本表、成本历史一律拒绝（不是前端隐藏）', () => {
    for (const h of ['table', 'one', 'skuHistory', 'marginHistory', 'pricingHistory', 'exportTable'] as const) expect(can(h, pageOnly)).toBe(false);
  });
  it('有成本查看权限但没有 product.cost.edit：不能维护售价、不能改分类利润率', () => {
    expect(can('table', viewer)).toBe(true);
    expect(can('exportTable', viewer)).toBe(true);
    expect(can('marginHistory', viewer)).toBe(true);
    expect(can('pricing', viewer)).toBe(false);
    expect(can('categoryMargin', viewer)).toBe(false);
    expect(can('pricing', editor)).toBe(true);
    expect(can('categoryMargin', editor)).toBe(true);
  });
  it('定价调试表：运营只要页面权限即可使用，其余接口仍然拒绝；没有页面权限的人全部拒绝', () => {
    for (const h of ['debugComponents', 'debugList', 'debugSlider', 'debugQuote', 'debugExport'] as const) {
      expect(can(h, ops)).toBe(true);
      expect(can(h, editor)).toBe(false);
    }
    expect(can('table', ops)).toBe(false);
    expect(can('pricing', ops)).toBe(false);
    expect(can('freight', ops)).toBe(false);
  });
  it('每个路由都声明了权限（默认拒绝：没声明的拒绝）', () => {
    const names = Object.getOwnPropertyNames(CostController.prototype).filter((n) => n !== 'constructor') as Array<keyof CostController>;
    const admin: AuthUser = { id: 1, companyId: 1, name: 'a', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    for (const n of names) expect(can(n, admin)).toBe(true);
  });
});
