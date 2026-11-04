import {useState} from 'react';
import {SearchPick,money} from './common';
import type {AcctState} from './voucher/types';
import {ReferenceVoucherHeading} from './ReferenceVoucherPayment';
import './referenceTransferFields.css';

function AccountField({role,accounts,onChange}:{role:'转出'|'转入';accounts:AcctState[];onChange:(accounts:AcctState[])=>void}){
  const [pending,setPending]=useState<{id:number|null;name:string}>({id:null,name:''});
  return <div className="reference-transfer-accounts">
    <span>{role}账户 <em>可多选</em></span>
    <div className="reference-transfer-account-input"><SearchPick type="bank-accounts" ariaLabel={`选择${role}账户`} value={pending.id} label={pending.name} placeholder={`搜索${role}账户`} excludeIds={accounts.map(account=>account.id)} onChange={(id,name)=>setPending({id,name})}/><button type="button" aria-label={`添加${role}账户`} onClick={()=>{if(!pending.id||accounts.some(account=>account.id===pending.id))return;onChange([...accounts,{id:pending.id,name:pending.name,amount:''}]);setPending({id:null,name:''});}}>添加</button></div>
    <div className="reference-transfer-tags">{accounts.map(account=><div className="reference-transfer-tag" key={account.id}><span>{account.name}</span><input type="number" min="0" step="0.01" aria-label={`${role}账户${account.name}金额`} placeholder={`${role}金额`} value={account.amount} onChange={event=>onChange(accounts.map(current=>current.id===account.id?{...current,amount:event.target.value}:current))}/><button type="button" aria-label={`移除${role}账户${account.name}`} onClick={()=>onChange(accounts.filter(current=>current.id!==account.id))}>×</button></div>)}</div>
  </div>;
}
export function ReferenceTransferFields({outs,ins,setOuts,setIns}:{outs:AcctState[];ins:AcctState[];setOuts:(accounts:AcctState[])=>void;setIns:(accounts:AcctState[])=>void}){
  return <><AccountField role="转出" accounts={outs} onChange={setOuts}/><AccountField role="转入" accounts={ins} onChange={setIns}/></>;
}
export function ReferenceTransferSummary({title,outs,ins,totalCents}:{title:string;outs:AcctState[];ins:AcctState[];totalCents:number}){
  return <section className="reference-voucher-payment"><ReferenceVoucherHeading step={3} title={title} compact/><div className="reference-transfer-summary"><strong>{outs.length?outs.map(account=>account.name).join('、'):'未填写转出账户'}</strong><b>转入</b><strong>{ins.length?ins.map(account=>account.name).join('、'):'未填写转入账户'}</strong><p>本次计划转款 {money(totalCents)}；明细与备注以左侧填写内容为准。</p></div></section>;
}
