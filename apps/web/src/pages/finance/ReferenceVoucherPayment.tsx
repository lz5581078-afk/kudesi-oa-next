import type {DocTypeDef,PayMode} from '@kudesi/shared';
import {SearchPick} from './common';
import './referenceVoucherPayment.css';

export function ReferenceVoucherHeading({step,title,hint,compact=false}:{step:number;title:string;hint?:string;compact?:boolean}){
  return <div className={`reference-voucher-section-head${compact?' compact':''}`}><span>{step}</span><div><h2>{title}</h2>{hint&&<p>{hint}</p>}</div></div>;
}
/** 原开单收付控件只负责展示和录入，共用DocForm的金额、模式及保存规则。 */
export function ReferenceVoucherPayment({ui,title,expense,mode,onMode,bank,onBank,paid,onPaid,payModes=ui.payModes}:{
  ui:DocTypeDef['ui'];title:string;expense:boolean;mode:PayMode|'';onMode:(mode:PayMode)=>void;
  payModes?:DocTypeDef['ui']['payModes'];
  bank:{id:number|null;name:string};onBank:(id:number|null,name:string)=>void;paid:string;onPaid:(value:string)=>void;
}){
  return <section className="reference-voucher-payment">
    <ReferenceVoucherHeading step={3} title={title} compact/>
    <div className="reference-voucher-pay-modes" role="group" aria-label="结算方式">{payModes.map(item=><button type="button" key={item.mode} className={mode===item.mode?'active':''} aria-pressed={mode===item.mode} onClick={()=>onMode(item.mode)}>{item.label}</button>)}</div>
    <label className="reference-voucher-field"><span>{ui.accountLabel}</span><SearchPick type="bank-accounts" ariaLabel={ui.accountLabel} value={bank.id} label={bank.name} placeholder={expense?'搜索付款账户':'选择资料中的资金账户'} onChange={onBank}/></label>
    <label className="reference-voucher-field"><span>{ui.amountLabel}</span><input type="number" min="0" step="0.01" aria-label={ui.amountLabel} value={paid} onChange={event=>onPaid(event.target.value)} placeholder="0.00"/></label>
  </section>;
}
export function ReferenceVoucherNote({expense,summary,onSummary,memo,onMemo}:{expense:boolean;summary:string;onSummary:(value:string)=>void;memo:string;onMemo:(value:string)=>void}){
  return <section className="reference-voucher-note">
    {expense&&<label className="reference-voucher-field"><span>单据摘要</span><input aria-label="单据摘要" maxLength={255} value={summary} onChange={event=>onSummary(event.target.value)} placeholder="不填则自动生成"/></label>}
    <label className="reference-voucher-field"><span>单据备注</span>{expense?<textarea aria-label="备注" maxLength={500} value={memo} onChange={event=>onMemo(event.target.value)}/>:<input aria-label="备注" maxLength={500} value={memo} onChange={event=>onMemo(event.target.value)}/>}</label>
  </section>;
}
