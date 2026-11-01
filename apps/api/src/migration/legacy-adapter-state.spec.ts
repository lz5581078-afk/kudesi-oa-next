import { getResourceDef } from '@kudesi/shared';
import { readFakeLegacy } from './fake-legacy';
import { parseWeightScope } from '../integrations/express-recognition';

describe('全公司迁移的旧状态与资料关联', () => {
  it('即将到期执照、需充值号码保留原状态，不静默改为正常', async () => {
    const out = await readFakeLegacy({ companies: [{ id: 7, name: '测试公司' }], business_licenses: [{ id: 2, company_id: 7, status: 'expiring', license_category: '公司' }], phone_numbers: [{ id: 2, company_id: 7, status: 'needs_recharge' }] });
    expect(out.records.find(r => r.type === 'licenses')?.status).toBe('expiring');
    expect(out.records.find(r => r.type === 'phones')?.status).toBe('needs_recharge');
    expect(getResourceDef('licenses')?.statuses.some(s => s.value === 'expiring')).toBe(true);
    expect(getResourceDef('phones')?.statuses.some(s => s.value === 'needs_recharge')).toBe(true);
  });
  it('抖店是抖音店铺别名；档案关联类型转换同时保留执照引用', async () => {
    const out = await readFakeLegacy({ companies: [{ id: 7, name: '测试公司' }], stores: [{ id: 1, company_id: 7, platform: '抖店', name: '测试店', status: 'normal' }], archive_items: [{ id: 1, company_id: 7, name: '原执照档案', related_type: 'business_license', related_id: 2, status: 'stored' }] });
    expect(out.records.find(r => r.type === 'stores')?.data.platform).toBe('douyin');
    expect(out.records.find(r => r.type === 'archives')?.data).toMatchObject({ relatedType: 'license', licenseId: { legacyRef: { type: 'licenses', id: '2' } } });
  });
  it('旧总位置的外公司默认引用只留档；真实分项位置保留，其他外公司引用不擅自删除', async () => {
    const tables = { companies: [{ id: 7, name: '测试公司' }], company_locations: [{ id: 3, company_id: 1, code: 'A-02', name: '示例柜层' }, { id: 32, company_id: 7, code: 'REAL', name: '本公司真实位置' }, { id: 99, company_id: 1, code: 'OTHER', name: '其他位置' }], business_licenses: [{ id: 2, company_id: 7, location_id: 3, original_location_id: 32, duplicate_location_id: 32, status: 'normal' }, { id: 4, company_id: 7, location_id: 99, status: 'normal' }] };
    const out = await readFakeLegacy(tables, 7, { preserveLegacyStates: true });
    const license = out.records.find(r => r.type === 'licenses' && r.id === '2')!;
    expect(license.data.locationId).toBeUndefined();
    expect(license.data.originalLocationId).toEqual({ legacyRef: { type: 'locations', id: '32' } });
    expect(license.sourceLocationOmission?.row.location_id).toBe(3);
    expect(out.exclusions).toContainEqual(expect.objectContaining({ type: 'licenses.locationId', id: '2', reason: expect.stringContaining('留档') }));
    expect(out.records.find(r => r.type === 'licenses' && r.id === '4')?.data.locationId).toEqual({ legacyRef: { type: 'locations', id: '99' } });
    const ordinary = await readFakeLegacy(tables);
    expect(ordinary.records.find(r => r.type === 'licenses' && r.id === '2')?.data.locationId).toEqual({ legacyRef: { type: 'locations', id: '3' } });
  });
  it('全量切换把旧账户现有余额保留为新站期初，不回放旧收支；旧的局部迁移仍不覆盖余额', async () => {
    const tables = { companies: [{ id: 7, name: '测试公司' }], bank_accounts: [{ id: 1, company_id: 7, current_balance: '1.23', account_kind: 'company_card' }] };
    const full = await readFakeLegacy(tables, 7, { preserveLegacyStates: true });
    expect(full.records.find(r => r.type === 'bank-accounts')?.data.balance).toBe(123);
    expect(full.exclusions.some(r => r.type === 'bank-accounts.balance')).toBe(false);
    const partial = await readFakeLegacy(tables);
    expect(partial.records.find(r => r.type === 'bank-accounts')?.data.balance).toBeUndefined();
    expect(partial.exclusions.some(r => r.type === 'bank-accounts.balance')).toBe(true);
  });
  it('加收起点空缺仅按明确范围文字补回；与原结束重量冲突时拒绝猜测', async () => {
    const surcharge = (id: string, weight_end: number) => ({ id, surcharge_name: id, weight_mode: 'between', weight_start: '', weight_end, weight_scope: '0-3kg', charge_type: 'fixed', amount: '0.10', status: '启用' });
    const tables = { companies: [{ id: 7, name: '测试公司' }], finance_express_catalogs: [{ id: 1, company_id: 7, carriers_json: [{ id: 'c', name: '快递', branches: [{ id: 'b', name: '网点', versions: [{ id: 'v', name: '原版', surcharges: [surcharge('valid', 3), surcharge('conflict', 4)] }] }] }] }] };
    const out = await readFakeLegacy(tables, 7, { parseWeightScope });
    expect(out.records.find(r => r.type === 'finance-express-surcharges' && r.id === 'valid')?.data).toMatchObject({ weightStart: 0, weightEnd: 3, amount: 10 });
    expect(out.records.some(r => r.type === 'finance-express-surcharges' && r.id === 'conflict')).toBe(false);
    expect(out.exclusions.some(r => r.id === 'conflict' && r.reason.includes('重量范围'))).toBe(true);
  });
});
