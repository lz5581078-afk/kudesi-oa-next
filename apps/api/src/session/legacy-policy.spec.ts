import { ForbiddenException } from '@nestjs/common';
import { legacySql } from './legacy-store';
import { legacyRequestPolicy } from './legacy-policy';
import { newLegacyStoreId, validOldStoreId, LEGACY_NEW_STORE_BASE } from './legacy-identity';

describe('旧模块接缝的标识符、用途与Profile身份保护', () => {
  it('只重命名SQL标识符，不改资料类型、来源键、字符串、注释或参数', () => {
    const sql = "SELECT stores.id FROM `stores` JOIN session_managed_shops ON stores.id = store_id WHERE r.type='stores' AND source_key='stores:1' AND note='session_devices' /* stores */";
    expect(legacySql(sql)).toBe("SELECT sm_legacy_stores.id FROM `sm_legacy_stores` JOIN sm_legacy_session_managed_shops ON sm_legacy_stores.id = store_id WHERE r.type='stores' AND source_key='stores:1' AND note='session_devices' /* stores */");
    expect(legacySql("SELECT * FROM stores WHERE title='it\\'s stores' AND id=?")).toContain("title='it\\'s stores' AND id=?");
  });
  it('旧SQL不能直接修改公共资料投影，包含注释前缀或已加命名空间的SQL', () => {
    for (const sql of ['UPDATE stores SET status=?', 'DELETE FROM sm_legacy_stores WHERE id=?', '/* source */ INSERT INTO `stores` VALUES (?)', 'REPLACE INTO employees VALUES (?)']) expect(() => legacySql(sql)).toThrow(ForbiddenException);
  });
  it('普通打开不扩大权限，远程用途明确声明才进入remote动作且原CAS字段保留', () => {
    const request = (path: string, body: any, method = 'POST') => ({ method, path, body, query: {} });
    expect(legacyRequestPolicy(request('/open-requests', { storeId: 1, deviceId: '00000000-0000-0000-0000-000000000001' }))).toBe('manage');
    expect(legacyRequestPolicy(request('/open-requests', { storeId: 1, deviceId: '00000000-0000-0000-0000-000000000001', purpose: 'remote' }))).toBe('remote');
    expect(() => legacyRequestPolicy(request('/open-requests', { storeId: 1, purpose: 'other' }))).toThrow();
    expect(() => legacyRequestPolicy(request('/pairings', { companyId: 2 }))).toThrow();
    expect(legacyRequestPolicy(request(`/managed-shops/1/assigned-device`, { deviceId: null, expectedDeviceId: null }, 'PATCH'))).toBe('manage');
  });
  it('无旧来源资料放入独立安全整数段，不碰历史低编号；不把大旧ID误当安全映射', () => {
    expect(validOldStoreId(1)).toBe(true); expect(validOldStoreId(LEGACY_NEW_STORE_BASE)).toBe(false);
    expect(newLegacyStoreId(1)).toBe(LEGACY_NEW_STORE_BASE + 1);
    expect(Number.isSafeInteger(newLegacyStoreId(0xffffffff))).toBe(true);
    expect(() => newLegacyStoreId(Number.MAX_SAFE_INTEGER)).toThrow();
  });
  it('兼容助手的十进制Profile/数据库编号，员工DTO与非法编号仍拒绝', () => {
    const request = (path: string, storeId: unknown) => ({ method: 'POST', path, body: { storeId }, query: {} });
    const good = request('/agent/bindings', String(LEGACY_NEW_STORE_BASE + 1));
    expect(legacyRequestPolicy(good)).toBe('agent');
    expect(good.body.storeId).toBe(LEGACY_NEW_STORE_BASE + 1);
    for (const id of ['0','01','-1','1.0','1e3','9007199254740992']) expect(() => legacyRequestPolicy(request('/agent/bindings', id))).toThrow();
    expect(() => legacyRequestPolicy(request('/open-requests', '1'))).toThrow();
  });
});
