import { describe, expect, it } from 'vitest';
import {
  addDays,
  allGrantableKeys,
  PAGE_TABS,
  daysUntil,
  findPageByPath,
  getResourceDef,
  maskSensitive,
  NAV_SECTIONS,
  normalizePhone,
  permissionOwner,
  RESOURCE_DEFS,
  RESOURCE_VIEWS,
  resourceNavGroups,
  validateResourceInput,
  validateStatusChange,
  visibleSections,
} from './index';

describe('资源定义自身的一致性', () => {
  it('key 不重复，标题字段/唯一字段/页签字段/父子关系/引用目标都真实存在', () => {
    const keys = RESOURCE_DEFS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k.length, `${k} 超过 32 个字符，放不进资料表的类型列`).toBeLessThanOrEqual(32);
    for (const def of RESOURCE_DEFS) {
      const fieldKeys = def.fields.map((f) => f.key);
      expect(new Set(fieldKeys).size).toBe(fieldKeys.length);
      expect(fieldKeys).toContain(def.titleField);
      if (def.uniqueField) expect(fieldKeys).toContain(def.uniqueField);
      if (def.tabsBy) expect(def.fields.find((f) => f.key === def.tabsBy)?.type).toBe('select');
      expect(def.statuses.some((s) => s.value === def.defaultStatus)).toBe(true);
      for (const f of def.fields) {
        if (f.type === 'select') expect(f.options?.length, `${def.key}.${f.key}`).toBeGreaterThan(0);
        if (f.type === 'ref') expect(f.ref === 'user' || f.ref === 'department' || getResourceDef(f.ref!), `${def.key}.${f.key} → ${f.ref}`).toBeTruthy();
        if (f.showWhen && f.showWhen.field !== 'status') expect(fieldKeys, `${def.key}.${f.key} showWhen`).toContain(f.showWhen.field);
      }
      for (const rule of def.uniqueTogether ?? []) for (const k of rule.fields) expect(fieldKeys).toContain(k);
      for (const c of def.children ?? []) expect(getResourceDef(c)?.parent?.type).toBe(def.key);
      if (def.parent) {
        expect(getResourceDef(def.parent.type)).toBeTruthy();
        expect(fieldKeys).toContain(def.parent.field);
        expect(def.nav).toBeUndefined();
      }
    }
  });

  it('资料菜单由定义生成，同一分组的页面挨在一起，且每页都有 ready 与权限键', () => {
    const resource = NAV_SECTIONS.find((s) => s.id === 'resource')!;
    const groups = resource.pages.filter((p) => p.group).map((p) => p.group);
    const seen: string[] = [];
    for (const g of groups) if (seen[seen.length - 1] !== g) seen.push(g!);
    expect(new Set(seen).size).toBe(seen.length); // 没有“分组被拆成两段”
    expect(resourceNavGroups().flatMap((g) => g.items).length + resourceNavGroups('finance').flatMap((g) => g.items).length).toBe(RESOURCE_DEFS.filter((d) => d.nav).length);
    for (const p of resource.pages) {
      expect(p.ready).toBe(true);
      // 银行卡分类入口、资金概况、费用模块的权限跟着它们背后的资料走
      if (!['bank-fund', 'fee-settings', 'org-tree', 'employees', 'position-profiles', ...RESOURCE_VIEWS.map((v) => v.id)].includes(p.id)) expect(p.permission).toBe(`resource.${p.id}.view`);
    }
    expect(findPageByPath('/resource/stores/12')?.page.id).toBe('stores');
  });

  it('没有权限就看不到任何资料菜单；只有店铺查看权限只看到店铺和总览之外的页面', () => {
    const none = visibleSections((p) => p === 'workbench.todos.view');
    expect(none.some((s) => s.id === 'resource')).toBe(false);
    const some = visibleSections((p) => p === 'resource.stores.view');
    expect(some.find((s) => s.id === 'resource')?.pages.map((p) => p.id)).toEqual(['stores']);
  });

  it('子资源沿用父资源的权限', () => {
    expect(permissionOwner('license-borrows')).toBe('licenses');
    expect(permissionOwner('stores')).toBe('stores');
  });
});

describe('字段校验', () => {
  const phones = getResourceDef('phones')!;
  const licenses = getResourceDef('licenses')!;

  it('手机号规范化：去掉符号和 86 前缀', () => {
    expect(normalizePhone('+86 138-0013-8000')).toBe('13800138000');
    expect(normalizePhone('13800138000')).toBe('13800138000');
  });

  it('必填项、日期、选项、MM-DD 格式都会被校验', () => {
    const bad = validateResourceInput(licenses, { category: '乱写', annualAuditDay: '13-40', foundedAt: '2026/01/01' }, { status: 'normal' });
    expect(bad.errors.join('|')).toContain('执照类别的取值不合法');
    expect(bad.errors.join('|')).toContain('主体名称不能为空');
    expect(bad.errors.join('|')).toContain('年审日期(月-日)格式应为 MM-DD');
    expect(bad.errors.join('|')).toContain('成立日期日期格式应为 YYYY-MM-DD');
    const ok = validateResourceInput(licenses, { category: 'operation', companyName: ' 甲 ', creditCode: 'X1', legalPerson: '张', annualAuditDay: '03-15' }, { status: 'normal' });
    expect(ok.errors).toEqual([]);
    expect(ok.values.companyName).toBe('甲');
  });

  it('showWhen 不满足的字段会被清空（非异常状态不保存异常原因，换使用类型清掉旧类型字段）', () => {
    const r = validateResourceInput(phones, { number: '13800138000', usageType: 'personal_used', externalUser: '外人', abnormalReason: '停机' }, { status: 'normal' });
    expect(r.values.externalUser).toBeNull();
    expect(r.values.abnormalReason).toBeNull();
  });

  it('金额必须是整数分，数字字段不能为负或小数', () => {
    const stores = getResourceDef('stores')!;
    const r = validateResourceInput(stores, { platform: 'pdd', name: 'x', deposit: 12.5 }, { status: 'normal' });
    expect(r.errors.join('|')).toContain('保证金必须是以分为单位的整数');
    const n = validateResourceInput(getResourceDef('self-media')!, { platform: 'douyin', name: 'x', followers: -1 }, { status: 'normal' });
    expect(n.errors.join('|')).toContain('粉丝数必须是非负整数');
  });

  it('编辑时没提交的必填字段沿用旧值，不会报错', () => {
    const r = validateResourceInput(licenses, { legalPerson: '李四' }, { status: 'normal', existing: { category: 'operation', companyName: 'A', creditCode: 'C', legalPerson: '张三' } });
    expect(r.errors).toEqual([]);
  });

  it('停用/注销必须写原因，普通状态不用', () => {
    expect(validateStatusChange(licenses, 'inactive', '')).toContain('必须填写原因');
    expect(validateStatusChange(licenses, 'inactive', '公司已注销')).toBeNull();
    expect(validateStatusChange(licenses, 'abnormal', undefined)).toBeNull();
    expect(validateStatusChange(licenses, 'bogus', 'x')).toBe('状态不合法');
  });

  it('脱敏与日期工具', () => {
    expect(maskSensitive('6222020200012345678')).toBe('************5678');
    expect(maskSensitive('123')).toBe('****');
    expect(addDays('2026-10-01', 30)).toBe('2026-10-31');
    expect(daysUntil('2026-10-30', new Date(2026, 9, 25))).toBe(5);
    expect(daysUntil('不是日期')).toBeNull();
  });
});

describe('权限清单', () => {
  it('包含资料各类型操作，且不含重复键；子资料不单列', async () => {
    const { permissionCatalog, allGrantableKeys } = await import('./permission-catalog');
    const keys = permissionCatalog().flatMap((g) => g.items.map((i) => i.key));
    expect(new Set(keys).size).toBe(keys.length);
    expect(allGrantableKeys().has('resource.stores.secret')).toBe(true);
    expect(allGrantableKeys().has('resource.store-daily-metrics.view')).toBe(true);
    expect(allGrantableKeys().has('resource.licenses.secret')).toBe(true); // 公户号、法人卡号是加密字段，查看明文要这个权限
    expect(keys.some((k) => k.startsWith('resource.license-borrows.'))).toBe(false);
    expect(allGrantableKeys().has('org.staff.reset')).toBe(true);
  });

  it('宿主页标签页：资源标签指向存在的资源，页面标签的权限都在权限清单里，且不再单独占菜单', () => {
    const grantable = allGrantableKeys();
    const menuIds = new Set(NAV_SECTIONS.flatMap((sec) => sec.pages.map((p) => p.path)));
    for (const [host, tabs] of Object.entries(PAGE_TABS)) {
      expect(menuIds.has(`/${host}`)).toBe(true); // 宿主页本身在菜单里
      tabs.forEach((t, i) => {
        if (t.ref.startsWith('finance-')) expect(RESOURCE_DEFS.some((d) => d.key === t.ref)).toBe(true);
        expect(grantable.has(t.permission)).toBe(true);
        if (i > 0) expect(menuIds.has(`/${host.split('/')[0]}/${t.id}`)).toBe(false); // 子标签不另占菜单
      });
    }
  });
});
