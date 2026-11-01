/** 迁移适配器：店铺档案的资金字段迁成“旧系统档案登记”资金快照（假旧库） */
import { FakeOut, readFakeLegacy } from './fake-legacy';

const store = (id: number, extra: Record<string, unknown>) => ({ id, company_id: 7, platform: 'pdd', name: `店${id}`, status: 'normal', store_no: `N${id}`, deposit_amount: '0.00', frozen_amount: '0.00', goods_payment_amount: '0.00', promotion_fee_balance: '0.00', updated_at: '2026-08-15 10:30:00', ...extra });

describe('迁移适配器：店铺资金', () => {
  let out: FakeOut;
  beforeAll(async () => {
    out = await readFakeLegacy({
      companies: [{ id: 7, name: '测试公司' }],
      stores: [
        store(1, { deposit_amount: '5000.00', frozen_amount: '12.50', goods_payment_amount: '300.00', promotion_fee_balance: '88.00', fund_remark: '先放着' }),
        store(2, {}),
        store(3, { deposit_amount: '1.005' }),
      ],
    });
  });
  const of = (type: string) => out.records.filter((r) => r.type === type);

  it('店铺档案本身不带资金字段，旧值迁成一条快照（日期取旧记录更新时间，货款对应可提现，来源标注旧系统档案登记）', () => {
    const s1 = of('stores').find((r) => r.id === '1')!;
    for (const k of ['deposit', 'frozen', 'goodsFund', 'promotionBalance']) expect(s1.data[k]).toBeUndefined();
    expect(s1.data.fundNote).toBe('先放着');
    const snaps = of('store-funds');
    const f = snaps.find((r) => r.id === 'legacy-store:1')!;
    expect(f.data).toMatchObject({ snapshotDate: '2026-08-15', deposit: 500000, frozen: 1250, withdrawable: 30000, promotion: 8800, source: 'legacy', note: '旧系统档案登记' });
    expect(f.data.storeId).toEqual({ legacyRef: { type: 'stores', id: '1' } });
    expect(f.status).toBe('recorded');
    // 快照排在店铺后面（引用要先有店铺）
    expect(out.records.indexOf(f)).toBeGreaterThan(out.records.indexOf(s1));
  });

  it('全是 0 的店铺不造快照；精度超范围的金额不舍入，记入待核对', () => {
    expect(of('store-funds').some((r) => r.id === 'legacy-store:2')).toBe(false);
    expect(of('store-funds').some((r) => r.id === 'legacy-store:3')).toBe(false);
    expect(out.exclusions.some((e) => e.type === 'stores.deposit' && e.id === '3')).toBe(true);
  });
  it('全量替换保留明确的0与原登记时点；已迁范围不再整类误报，缺时点不编迁移日',async()=>{
    const full=await readFakeLegacy({companies:[{id:7,name:'测试公司'}],stores:[store(1,{}),store(2,{updated_at:null}),store(3,{updated_at:'2026-02-30 10:00:00'})]},7,{preserveLegacyStates:true});
    const funds=full.records.filter(r=>r.type==='store-funds');
    expect(funds).toHaveLength(1);
    expect(funds[0]).toMatchObject({id:'legacy-store:1',status:'recorded',data:{snapshotDate:'2026-08-15',deposit:0,frozen:0,withdrawable:0,promotion:0,source:'legacy',note:'旧系统档案登记；原档案更新时间：2026-08-15 10:30:00'}});
    expect(full.exclusions.filter(e=>e.type==='store-funds').map(e=>e.id).sort()).toEqual(['2','3']);
    expect(full.exclusions.filter(e=>e.type==='store-funds').every(e=>e.reason.includes('不能用迁移日'))).toBe(true);
    expect(full.sourceRows?.find((r:any)=>r.table==='stores'&&r.key==='1')?.row.updated_at).toBe('2026-08-15 10:30:00');
  });
});
