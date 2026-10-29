/** 迁移适配器：费用模块用到的手机号费用 / 主子卡 / 充值周期，以及宽带的区域和手机号绑定（假旧库） */
import { FakeOut, readFakeLegacy } from './fake-legacy';

const phone = (id: number, extra: Record<string, unknown>) => ({ id, company_id: 7, number: `1380000000${id}`, carrier: '中国移动', package_name: '商务套餐', monthly_fee: '30.00', status: 'normal', usage_type: 'company_kept', fee_cycle: 'monthly', recharge_cycle: '30', ...extra });

describe('迁移适配器：费用模块数据', () => {
  let out: FakeOut;
  beforeAll(async () => {
    out = await readFakeLegacy({
      companies: [{ id: 7, name: '测试公司' }],
      phone_numbers: [
        phone(1, {}),
        phone(2, { parent_phone_id: 1, monthly_fee: '12.50', last_recharge_at: '2026-10-01' }),
        phone(3, { fee_cycle: '365', recharge_cycle: '365', monthly_fee: '360.00' }),
        phone(4, { recharge_cycle: 'quarterly', next_recharge_at: '2026-07-05' }),
        phone(5, { recharge_cycle: '不知道' }),
      ],
      company_locations: [
        { id: 20, company_id: 7, name: '运营室', parent_id: null, location_scope: 'area', status: 'normal' },
        { id: 21, company_id: 7, name: '仓库', parent_id: null, location_scope: 'area', status: 'normal' },
        { id: 22, company_id: 7, name: '仓库', parent_id: null, location_scope: 'area', status: 'normal' },
      ],
      broadband_accounts: [
        { id: 1, company_id: 7, account_no: 'bb1', phone_number_id: 1, package_cycle: 'yearly', package_amount: '2400.00', broadband_location: '运营室', location_id: null, status: 'normal' },
        { id: 2, company_id: 7, account_no: 'bb2', phone_number_id: 2, package_cycle: 'monthly', package_amount: '100.00', broadband_location: '仓库', location_id: null, status: 'normal' },
        { id: 3, company_id: 7, account_no: 'bb3', phone_number_id: 3, package_cycle: 'monthly', package_amount: '0.00', broadband_location: null, location_id: 21, status: 'normal' },
      ],
    });
  });
  const rec = (type: string, id: string) => out.records.find((r) => r.type === type && r.id === id)!;

  it('手机号：主卡、费用（分）、费用周期、最后充值日按原值带入', () => {
    expect(rec('phones', '2').data).toMatchObject({ parentPhoneId: { legacyRef: { type: 'phones', id: '1' } }, monthlyFee: 1250, lastRechargeAt: '2026-10-01' });
    expect(rec('phones', '1').data.parentPhoneId).toBeUndefined();
    expect(rec('phones', '3').data).toMatchObject({ monthlyFee: 36000, feeCycle: 'yearly' });
  });

  it('充值周期：旧的天数文字和 monthly/quarterly/yearly 都换成天数；不认识的不猜，记入待核对', () => {
    expect(rec('phones', '1').data.rechargeCycleDays).toBe(30);
    expect(rec('phones', '3').data.rechargeCycleDays).toBe(365);
    expect(rec('phones', '4').data.rechargeCycleDays).toBe(90);
    expect(rec('phones', '5').data.rechargeCycleDays).toBeUndefined();
    expect(rec('phones', '5').notices?.join('')).toContain('不是天数');
    expect(rec('phones', '4').data.nextRechargeAt).toBe('2026-07-05');
  });

  it('宽带：绑定手机号、金额（分）、周期带入；位置文字与唯一区域同名就对上区域，重名不猜', () => {
    expect(rec('broadband', '1').data).toMatchObject({ phoneId: { legacyRef: { type: 'phones', id: '1' } }, amount: 240000, cycle: 'yearly', locationId: { legacyRef: { type: 'locations', id: '20' } } });
    expect(rec('broadband', '1').data.locationNote).toBeUndefined();
    expect(rec('broadband', '2').data.locationId).toBeUndefined();
    expect(rec('broadband', '2').data.locationNote).toBe('仓库');
    expect(rec('broadband', '3').data.locationId).toEqual({ legacyRef: { type: 'locations', id: '21' } });
  });
});
