import { useEffect, useRef, useState } from 'react';
import { OPENING_PREPAYMENT_PERMISSION, lineAmount } from '@kudesi/shared';
import { useAuth } from '../../auth/AuthContext';
import { FinanceModal } from './FinanceModal';
import { OpeningPrepaymentDialog, canRegisterOpeningPrepayment } from './OpeningPrepaymentDialog';
import { referenceMoney } from './common';
import { financeApi, type DocDetailDto, type DocRow } from './financeApi';
import { documentSourceKind, documentSummary } from './documentPresentation';
import './referenceDocumentDetail.css';

/** 查询页的原版查看窗口；事实和预付款操作仍由统一单据服务提供。 */
export function ReferenceDocumentDetail({doc,row,error,onClose,onSaved}:{doc:DocDetailDto|null;row?:DocRow;error:string;onClose:()=>void;onSaved:(doc:DocDetailDto)=>void}){
  const {can}=useAuth();const [busy,setBusy]=useState(false),[fileError,setFileError]=useState('');
  const mounted=useRef(false);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const showDocumentSections=!row||documentSourceKind(row)==='document';
  const posted=doc?.status==='posted',reversed=doc?.status==='reversed';
  const isOpening=doc?.entries.some(entry=>entry.kind==='opening')??false;
  const mayOpen=!!doc&&canRegisterOpeningPrepayment(doc,can(OPENING_PREPAYMENT_PERMISSION));
  return <FinanceModal presentation="reference" title={doc?.typeLabel||row?.typeLabel||'单据详情'} subtitle={`${doc?.docNo||row?.docNo||''} · ${posted?'已过账':reversed?'已红冲':'未过账'}`} className="reference-finance-document" closeOnBackdrop busy={busy} onClose={onClose}>
    {!doc&&!error&&<p className="reference-document-loading" role="status">正在加载单据详情...</p>}
    {(error||fileError)&&<div className="notice error" role="alert">{error||fileError}</div>}
    {doc&&<div className="reference-document-body">
      <div className="reference-document-summary">
        <div><span>单据日期</span><strong>{doc.docDate||'-'}</strong></div><div><span>往来对象</span><strong>{doc.partyName||row?.partyName||'-'}</strong></div>
        <div><span>经办人</span><strong>{doc.handler||row?.handler||'-'}</strong></div><div><span>单据金额</span><strong>{referenceMoney(doc.amountCents)}</strong></div>
        <div><span>已收付金额</span><strong>{referenceMoney(doc.paidCents)}</strong></div><div><span>状态</span><strong>{doc.status==='draft'?'草稿':'已制单'}</strong></div>
      </div>
      {mayOpen&&<section><h3>登记已有预付款余额</h3><p>确认本单金额为真实未使用预付款余额后入账；当前资金余额不再次减少。</p><OpeningPrepaymentDialog doc={doc} inline onBusyChange={setBusy} onClose={onClose} onSaved={onSaved}/></section>}
      {isOpening&&<p role="status">已有预付款余额已入账，可在采购流程中选择使用。</p>}
      <section><h3>单据摘要</h3><p>{doc.summary||(row?documentSummary(row):'-')}</p>{doc.memo&&<p>{doc.memo}</p>}</section>
      {showDocumentSections&&<><section><h3>单据明细</h3><div className="table-scroll"><table className="data-table"><thead><tr><th>项目/商品</th><th>数量</th><th>单位</th><th>单价</th><th>金额</th><th>备注</th></tr></thead><tbody>{doc.lines.map(line=><tr key={line.id}><td>{line.itemName||line.productName||line.feeItemName||'-'}</td><td>{line.qty}</td><td>{line.unit||'-'}</td><td>{referenceMoney(line.unitPriceCents)}</td><td>{referenceMoney(lineAmount(line))}</td><td>{line.memo||'-'}</td></tr>)}</tbody></table></div></section>
      <section><h3>资金账户</h3>{doc.accounts.length?doc.accounts.map(account=><div key={account.id} className="reference-document-account"><span>{account.bankName}</span><strong>{referenceMoney(account.amountCents)}</strong></div>):doc.bankAccountId&&doc.bankName&&doc.paidCents!==0?<div className="reference-document-account"><span>{doc.bankName}</span><strong>{referenceMoney(doc.paidCents)}</strong></div>:<p>本单尚未记录收付账户。</p>}</section></>}
      {!!doc.openingVouchers?.length&&<section><h3>期初预付凭证</h3>{doc.openingVouchers.map(file=><button type="button" className="link-button" key={file.id} onClick={()=>{setFileError('');void financeApi.openingVoucherUrl(doc.id,file.id).then(result=>{if(mounted.current)window.open(result.url,'_blank','noopener');}).catch(error=>{if(mounted.current)setFileError(error instanceof Error?error.message:'凭证加载失败');});}}>{file.name}</button>)}</section>}
    </div>}
  </FinanceModal>;
}
