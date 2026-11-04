import { EntityManager } from 'typeorm';
import { LiveOrderSource } from './live-order-source';
import { Row, liveFail, num, wallNow, liveClock } from './live-core';
/** Final approval re-reads external after-sales state; a stale draft must be returned, never silently repriced. */
export async function verifyLiveSettlementRefunds(em:EntityManager, source:LiveOrderSource|undefined,c:number,id:number){
  const [newMode]:Row[]=await em.query('SELECT COUNT(*) n FROM live_settlement_lines l JOIN live_sessions s ON s.company_id=l.company_id AND s.id=l.session_id WHERE l.company_id=? AND l.settlement_id=? AND l.commission_record_id IS NOT NULL',[c,id]);
  if(!Number(newMode.n))return;
  const saved:Row[]=await em.query('SELECT * FROM live_settlement_refunds WHERE company_id=? AND settlement_id=?',[c,id]);
  if(!saved.length)return;
  if(!source)liveFail('聚水潭退款复核不可用，不能确认发放',409);
  for(const shop of new Set(saved.map(o=>String(o.shop_id)))){
    const orders=saved.filter(o=>String(o.shop_id)===shop);
    try{
      const got=await source!.refunds(c,shop,orders.map(o=>({orderId:String(o.order_id),amountCents:num(o.order_amount_cents)})));
      for(const o of orders){const current=got.get(String(o.order_id));if(!current||current.cents!==num(o.refund_cents))throw new Error('订单退款发生变化，请退回结算单重新生成、核对后审批');}
    }catch(e){liveFail(`聚水潭退款复核失败：${(e as Error).message}`,409);}
  }
  await em.query('UPDATE live_settlements SET refunds_checked_at=? WHERE company_id=? AND id=?',[wallNow(liveClock.now()),c,id]);
}
