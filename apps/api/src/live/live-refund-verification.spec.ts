import { verifyLiveSettlementRefunds } from './live-refund-verification';
import { LiveOrderSource } from './live-order-source';
import { EntityManager } from 'typeorm';
const fake=()=>({query:jest.fn(async(sql:string)=>sql.includes('COUNT(*)')?[{n:1}]:sql.startsWith('SELECT *')?[{shop_id:'SHOP',order_id:'A',order_amount_cents:10000,refund_cents:2000}]:[])});
describe('提成发放前退款复核',()=>{
  it('审批前退款变化必须退回重算，不修改应发金额',async()=>{const em=fake();const source={refunds:async()=>new Map([['A',{cents:3000}]])} as unknown as LiveOrderSource;await expect(verifyLiveSettlementRefunds(em as unknown as EntityManager,source,1,2)).rejects.toThrow(/退款发生变化/);expect(em.query.mock.calls.some(([s])=>s.startsWith('UPDATE'))).toBe(false);});
  it('外部接口不可用和订单结果缺失不能当零退款',async()=>{const em=fake();await expect(verifyLiveSettlementRefunds(em as unknown as EntityManager,undefined,1,2)).rejects.toThrow(/不可用/);await expect(verifyLiveSettlementRefunds(em as unknown as EntityManager,{refunds:async()=>new Map()} as unknown as LiveOrderSource,1,2)).rejects.toThrow(/复核失败/);});
  it('相同最新退款状态可通过，并记录本次核对时间',async()=>{const em=fake(),source={refunds:async()=>new Map([['A',{cents:2000}]])} as unknown as LiveOrderSource;await verifyLiveSettlementRefunds(em as unknown as EntityManager,source,1,2);expect(em.query.mock.calls.some(([s])=>s.startsWith('UPDATE live_settlements SET refunds_checked_at'))).toBe(true);});
});
