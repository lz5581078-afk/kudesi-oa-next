import { useRef, useState } from 'react';
import { liveYuanToCents } from '@kudesi/shared';
import { liveApi, type SettlementDetail } from './liveApi';
import { errText, money } from './liveFormat';

export function SettlementActions({detail:d,canManage,onChanged}:{detail:SettlementDetail;canManage:boolean;onChanged:()=>void}) {
  const [userId,setUserId]=useState(''),[amount,setAmount]=useState(''),[reference,setReference]=useState(''),[reason,setReason]=useState('');
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [lineId,setLineId]=useState(''),[adjustAmount,setAdjustAmount]=useState(''),[adjustReference,setAdjustReference]=useState(''),[adjustReason,setAdjustReason]=useState(''),[createdId,setCreatedId]=useState<number|null>(null);
  const [adjustKind,setAdjustKind]=useState<'wage'|'commission'>('commission');
  const signedCents=(value:string,label:string)=>(value.trim().startsWith('-')?-1:1)*(liveYuanToCents(value.trim().replace(/^-/,''),label,{allowEmpty:false}) as number);
  const key=useRef(crypto.randomUUID());
  if(!canManage)return null;
  const people=[...new Map(d.byPerson.map(p=>[p.userId,p])).values()];
  async function act(kind:'payment'|'void'|'adjustment'){
    if(busy)return;setBusy(true);setError('');
    try{
      if(kind==='payment'){
        const amountCents=signedCents(amount,'付款/追回金额');
        await liveApi.paySettlement(d.id,{userId:Number(userId),amountCents,requestKey:key.current,reference});
        key.current=crypto.randomUUID();setAmount('');setReference('');
      }else if(kind==='adjustment'){const made=await liveApi.adjustSettlement(d.id,{kind:adjustKind,lineId:Number(lineId),amountCents:signedCents(adjustAmount,'调整金额'),reference:adjustReference,reason:adjustReason});setCreatedId(made.id);}
      else await liveApi.voidSettlement(d.id,reason);
      onChanged();
    }catch(e){setError(errText(e));}finally{setBusy(false);}
  }
  return <section aria-label="结算操作">
    {d.status==='approved'&&<details><summary>登记付款或追回 · 未付 {money(d.payableTotalCents-(d.paidTotalCents??0))}</summary><p className="muted">请在实际付款后登记；凭证编号用于追溯，每位人员累计付款不能超过本单应付金额。</p><div className="live-filter">
      <label className="live-field">收款人员<select aria-label="收款人员" value={userId} onChange={e=>{setUserId(e.target.value);key.current=crypto.randomUUID();}}><option value="">请选择</option>{people.map(p=><option key={p.userId} value={p.userId}>{p.name}</option>)}</select></label>
      <label className="live-field">付款金额（元，负数为追回）<input aria-label="付款金额" inputMode="decimal" value={amount} onChange={e=>{setAmount(e.target.value);key.current=crypto.randomUUID();}}/></label>
      <label className="live-field">付款凭证编号<input aria-label="付款凭证编号" maxLength={200} value={reference} onChange={e=>setReference(e.target.value)}/></label>
      <button className="primary-button" disabled={busy||!userId||!amount||!reference.trim()} onClick={()=>void act('payment')}>登记付款 / 追回</button>
    </div></details>}
    {d.status==='approved'&&!d.originalSettlementId&&<details><summary>新增补扣款调整（需审批）</summary><p className="muted">结算后发生退款或工资差错时，关联原明细另建调整单。正数补发、负数追扣；同一明细和业务凭证不能重复登记，累计追扣不超过原应付。请在业务凭证中填写退款单号等唯一编号。</p><div className="live-filter">
      <label className="live-field">调整类型<select aria-label="调整类型" value={adjustKind} onChange={e=>setAdjustKind(e.target.value as 'wage'|'commission')}><option value="commission">提成（含退款追扣）</option><option value="wage">工资</option></select></label>
      <label className="live-field">原结算明细<select aria-label="原结算明细" value={lineId} onChange={e=>setLineId(e.target.value)}><option value="">请选择</option>{d.lines.map(l=><option key={l.id} value={l.id}>{l.date} · {l.userName} · {l.roomName} · {money(l.payableCents)}</option>)}</select></label>
      <label className="live-field">调整金额（元）<input aria-label="调整金额" value={adjustAmount} onChange={e=>setAdjustAmount(e.target.value)}/></label>
      <label className="live-field">业务凭证编号<input aria-label="调整凭证编号" maxLength={100} value={adjustReference} onChange={e=>setAdjustReference(e.target.value)}/></label>
      <label className="live-field">调整原因<input aria-label="调整原因" maxLength={500} value={adjustReason} onChange={e=>setAdjustReason(e.target.value)}/></label>
      <button className="primary-button" disabled={busy||!lineId||!adjustAmount||!adjustReference.trim()||!adjustReason.trim()} onClick={()=>void act('adjustment')}>生成调整草稿</button>
    </div>{createdId&&<p role="status">调整单 #{createdId} 已生成，请在历史结算中打开核对并提交审批。</p>}</details>}
    {['draft','returned'].includes(d.status)&&!d.flowRunId&&<details><summary>作废草稿并释放明细</summary><div className="live-filter"><label className="live-field">作废原因<input aria-label="作废原因" maxLength={500} value={reason} onChange={e=>setReason(e.target.value)}/></label><button className="secondary-button" disabled={busy||!reason.trim()} onClick={()=>void act('void')}>确认作废</button></div></details>}
    {error&&<p role="alert" className="notice error">{error}</p>}
  </section>;
}
