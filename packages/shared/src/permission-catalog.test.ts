import { describe, expect, it } from 'vitest';
import { NAV_SECTIONS } from './navigation';
import { allGrantableKeys, permissionCatalog } from './permission-catalog';

describe('资料页面授权入口', () => {
  it('所有已开放的资料页面都能通过岗位授权进入', () => {
    const grantable = allGrantableKeys();
    for (const page of NAV_SECTIONS.find((s) => s.id === 'resource')!.pages.filter((p) => p.ready)) {
      expect(grantable.has(page.permission), page.label).toBe(true);
    }
    expect(grantable.has('resource.company-store-maintenance.view')).toBe(true);
    const keys = permissionCatalog().flatMap((g) => g.items.map((i) => i.key));
    expect(keys.filter((k) => k === 'resource.company-store-maintenance.view')).toHaveLength(1);
  });
});
