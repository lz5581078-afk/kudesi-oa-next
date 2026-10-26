import { describe, expect, it } from 'vitest';
import {
  createChecker,
  findPageByPath,
  matchesPermission,
  minSalePriceCents,
  NAV_SECTIONS,
  resolveMargin,
  resolvePermissions,
  visibleSections,
} from './index';

describe('权限解析', () => {
  it('通配符匹配', () => {
    expect(matchesPermission('*', 'a.b.c')).toBe(true);
    expect(matchesPermission('product.*', 'product.bundles.view')).toBe(true);
    expect(matchesPermission('product.*', 'production.x')).toBe(false);
    expect(matchesPermission('product.bundles.view', 'product.bundles.view')).toBe(true);
    expect(matchesPermission('product.bundles.view', 'product.bundles.edit')).toBe(false);
  });

  it('岗位权限与个人允许叠加', () => {
    const eff = resolvePermissions({
      isCompanyAdmin: false,
      positionPermissions: ['product.bundles.view'],
      overrides: [{ permission: 'cost.table.view', effect: 'allow' }],
    });
    const can = createChecker(eff);
    expect(can('product.bundles.view')).toBe(true);
    expect(can('cost.table.view')).toBe(true);
    expect(can('org.staff.view')).toBe(false);
  });

  it('个人拒绝优先于岗位权限，包括通配', () => {
    const eff = resolvePermissions({
      isCompanyAdmin: false,
      positionPermissions: ['product.*'],
      overrides: [{ permission: 'product.cost.view', effect: 'deny' }],
    });
    const can = createChecker(eff);
    expect(can('product.bundles.view')).toBe(true);
    expect(can('product.cost.view')).toBe(false);
  });

  it('公司管理员不受个人拒绝影响', () => {
    const eff = resolvePermissions({
      isCompanyAdmin: true,
      positionPermissions: [],
      overrides: [{ permission: 'org.staff.view', effect: 'deny' }],
    });
    expect(createChecker(eff)('org.staff.view')).toBe(true);
  });

  it('没有任何授予时全部拒绝', () => {
    const can = createChecker(resolvePermissions({ isCompanyAdmin: false, positionPermissions: [], overrides: [] }));
    expect(can('workbench.todos.view')).toBe(false);
  });
});

describe('导航注册表', () => {
  it('页面 id、路径、权限键全局唯一', () => {
    const pages = NAV_SECTIONS.flatMap((s) => s.pages);
    expect(new Set(pages.map((p) => p.path)).size).toBe(pages.length);
    // 资料里几个入口（银行卡按类型分页、资金概况、费用模块）共用背后资料的查看权限
    const own = pages.filter((p) => p.permission === `${p.path.split('/')[1]}.${p.id}.view`);
    expect(new Set(pages.map((p) => p.id + p.path)).size).toBe(pages.length);
    expect(new Set(own.map((p) => p.permission)).size).toBe(own.length);
  });

  it('一级菜单收敛为 6 个（首页 + 5 个业务分区，组织页面并入资料）', () => {
    expect(NAV_SECTIONS).toHaveLength(6);
    expect(NAV_SECTIONS[0]).toMatchObject({ id: 'home', pages: [{ path: '/', open: true, ready: true }] });
  });

  it('只显示已完成且有权限的页面，空的一级菜单被去掉', () => {
    const can = createChecker(
      resolvePermissions({ isCompanyAdmin: false, positionPermissions: ['workbench.todos.view'], overrides: [] }),
    );
    const sections = visibleSections(can);
    // 首页人人可见，其余按权限
    expect(sections.map((s) => s.id)).toEqual(['home', 'workbench']);
    expect(sections[0].landingPath).toBe('/');
    expect(sections[1].pages.map((p) => p.id)).toEqual(['todos']);
    expect(sections[1].landingPath).toBe('/workbench/todos');
    expect(visibleSections(() => false).map((s) => s.id)).toEqual(['home']);
  });

  it('管理员能看到所有已完成页面，includePlanned 时能看到全部', () => {
    const can = createChecker(resolvePermissions({ isCompanyAdmin: true, positionPermissions: [], overrides: [] }));
    const ready = visibleSections(can).flatMap((s) => s.pages);
    const all = visibleSections(can, { includePlanned: true }).flatMap((s) => s.pages);
    expect(ready.every((p) => p.ready)).toBe(true);
    expect(all.length).toBeGreaterThan(ready.length);
  });

  it('按路径定位页面，支持子路径', () => {
    expect(findPageByPath('/finance/finance-bundles')?.page.label).toBe('商品组合编码');
    expect(findPageByPath('/finance/finance-bundles/123')?.section.id).toBe('finance');
    expect(findPageByPath('/nope')).toBeUndefined();
  });
});

describe('最低售价', () => {
  it('(8.40 + 3.20) ÷ (1 − 25%) = 15.47，向上取整到分', () => {
    expect(minSalePriceCents({ preShipCostCents: 840, freightCents: 320, marginBasisPoints: 2500 })).toBe(1547);
  });

  it('正好整除时不多进一分', () => {
    expect(minSalePriceCents({ preShipCostCents: 700, freightCents: 300, marginBasisPoints: 5000 })).toBe(2000);
  });

  it('利润率 0% 是有效值', () => {
    expect(minSalePriceCents({ preShipCostCents: 840, freightCents: 320, marginBasisPoints: 0 })).toBe(1160);
  });

  it('运费或利润率缺失、利润率不合法时返回 null，不用 0 兜底', () => {
    expect(minSalePriceCents({ preShipCostCents: 840, freightCents: null, marginBasisPoints: 2500 })).toBeNull();
    expect(minSalePriceCents({ preShipCostCents: 840, freightCents: 320, marginBasisPoints: null })).toBeNull();
    expect(minSalePriceCents({ preShipCostCents: 840, freightCents: 320, marginBasisPoints: 10000 })).toBeNull();
  });

  it('利润率按 单品 > 本分类 > 上级分类 > 默认 取第一个有值的，0 也算有值', () => {
    expect(resolveMargin([null, 0, 2500])).toBe(0);
    expect(resolveMargin([undefined, null, 3000, 2500])).toBe(3000);
    expect(resolveMargin([null, undefined])).toBeNull();
  });
});

import { DOC_DIRECTION, DOC_TYPES, docTypesOfDirection, hasBankRef } from './finance-documents';
describe('经营历程收支方向与银行流水号', () => {
  it('每种单据都有方向；转款和提现是内部流转', () => {
    for (const d of DOC_TYPES) expect(['in', 'out', 'internal']).toContain(DOC_DIRECTION[d.type]);
    expect(docTypesOfDirection('internal').sort()).toEqual(['transfer', 'withdrawal']);
    expect(docTypesOfDirection('in')).toContain('sale');
    expect(docTypesOfDirection('out')).toContain('expense');
  });
  it('动钱的收付款类单据可登记银行流水号，转款不用', () => {
    const t = (k: string) => DOC_TYPES.find((d) => d.type === k)!;
    for (const k of ['payment', 'receipt', 'withdrawal', 'expense', 'sale']) expect(hasBankRef(t(k))).toBe(true);
    expect(hasBankRef(t('transfer'))).toBe(false);
  });
});
