import { describe, expect, it } from 'vitest';
import { allGrantableKeys } from './permission-catalog';
import { DESK_DEFS, deskLinks } from './workspace';
import { deskAccessPermissions } from './desk-access';

describe('岗位入口权限与流程办理分离', () => {
  it('各类岗位能进入配置的工作台功能，主管入口按层级开放', () => {
    for (const def of Object.values(DESK_DEFS)) for (const level of ['staff', 'manager', 'boss']) {
      const keys = deskAccessPermissions(def.type, level);
      for (const page of deskLinks(def, level, () => true)) expect(keys).toContain(page.permission);
      for (const key of keys) expect(allGrantableKeys().has(key), key).toBe(true);
      expect(keys.every((k) => k.endsWith('.view') || k === 'flow.purchase.inbound-draft')).toBe(true);
      expect(keys).not.toContain('finance.docs.post');
      expect(keys).not.toContain('live.manage');
      expect(keys).not.toContain('org.staff.edit');
      expect(keys.some((k) => k.endsWith('.secret') || k === '*')).toBe(false);
    }
    expect(deskAccessPermissions('operations', 'staff')).not.toContain('features.live.view');
    expect(deskAccessPermissions('operations', 'manager')).toContain('features.live.view');
  });
  it('主播不获得全员直播数据，空白工作台仍能处理本人流程和任务', () => {
    expect(deskAccessPermissions('live_anchor', 'staff')).toContain('features.live-desk.view');
    expect(deskAccessPermissions('live_anchor', 'staff')).not.toContain('live.commissions.view');
    expect(deskAccessPermissions('blank', 'staff')).toContain('workbench.todos.view');
    expect(deskAccessPermissions('blank', 'staff')).toContain('flow.apply.view');
  });
});
