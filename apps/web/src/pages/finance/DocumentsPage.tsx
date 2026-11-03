import { useCallback, useEffect, useRef, useState } from 'react';
import { DOC_STATUS_LABEL, DOC_TYPE_MAP, type DocType } from '@kudesi/shared';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { DocDetail } from './DocDetail';
import { DocumentCenter } from './DocumentCenter';
import { CopyButton, useIsMobile } from './fin-ui';
import { DocForm } from './DocForm';
import { DOC_STATUS_TONE, Pager, money } from './common';
import { financeApi, type DocList } from './financeApi';
const PAGE_SIZE=20;

/** 原经营历程/草稿中心共用查询版式；制单页最近单据保留自己的分页和操作。 */
export function DocumentsPage({scope,embedded}:{scope:'drafts'|'history'|DocType;embedded?:boolean}){
  const {user}=useAuth();
  if(scope==='history'||scope==='drafts')return <DocumentCenter scope={scope}/>;
  return <RecentDocuments key={JSON.stringify([scope,user?.companyId,user?.id,user?.permissions])} scope={scope} embedded={embedded}/>;
}
function RecentDocuments({scope,embedded}:{scope:DocType;embedded?:boolean}){
  const {can}=useAuth();const isMobile=useIsMobile(),def=DOC_TYPE_MAP.get(scope)!;
  const [keyword,setKeyword]=useState(''),[status,setStatus]=useState(''),[from,setFrom]=useState(''),[to,setTo]=useState(''),[page,setPage]=useState(1);
  const [data,setData]=useState<DocList|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[selected,setSelected]=useState<number|null>(null),[creating,setCreating]=useState(false);
  const mounted=useRef(false),serial=useRef(0);
  const load=useCallback(()=>{
    const request=++serial.current,current=()=>mounted.current&&serial.current===request;
    setError('');setLoading(true);
    void financeApi.docs({scope,status,from,to,keyword,page}).then(result=>{if(current())setData(result);}).catch(error=>{if(current())setError(error instanceof ApiError?error.message:'加载失败');}).finally(()=>{if(current())setLoading(false);});
  },[scope,status,from,to,keyword,page]);
  useEffect(()=>{mounted.current=true;load();return()=>{mounted.current=false;serial.current++;};},[load]);
  const filtersActive=!!(keyword.trim()||status||from||to),rows=data?.rows??[];
  return <div className={selected?'split':undefined}><div className="split-main">
    <div className="page-head between">{embedded?<span/>:<h1>{def.label}</h1>}{!embedded&&can('finance.docs.create')&&<button type="button" className="primary-button" onClick={()=>setCreating(true)}>+ 新建{def.label}</button>}</div>
    <div className="toolbar">
      <input className="search-box" type="search" aria-label="搜索单号或备注" placeholder="搜索单号、备注" value={keyword} onChange={event=>{setKeyword(event.target.value);setPage(1);}}/>
      <select aria-label="状态" value={status} onChange={event=>{setStatus(event.target.value);setPage(1);}}><option value="">全部状态</option>{(['draft','issued','posted','reversed'] as const).map(value=><option key={value} value={value}>{DOC_STATUS_LABEL[value]}</option>)}</select>
      <input type="date" aria-label="开始日期" value={from} onChange={event=>{setFrom(event.target.value);setPage(1);}}/><span className="muted">至</span><input type="date" aria-label="结束日期" value={to} onChange={event=>{setTo(event.target.value);setPage(1);}}/>
    </div>
    {error&&<div role="alert" className="notice error">{error}<button type="button" className="link-button" onClick={load}>重试</button></div>}
    {isMobile?<div className="bill-cards">
      {loading&&!data&&<p className="muted">正在加载单据…</p>}
      {data?.rows.length===0&&<div className="empty-state muted">{filtersActive?'当前条件下没有单据：可以放宽日期范围，或重置筛选条件':'没有单据'}</div>}
      {rows.map(row=><button type="button" key={row.id} className="bill-card" aria-label={`查看${row.typeLabel} ${row.docNo}`} onClick={()=>setSelected(row.id)}><span className="bill-head"><b>{row.typeLabel}</b><em>{row.docDate}</em></span><span className="bill-main"><span>{row.partyName||row.summary||row.memo||'—'}</span><strong className={row.amountCents<0?'neg':''}>{money(row.amountCents)}</strong></span><span className="bill-meta"><code>{row.docNo}</code><span className={`pill ${DOC_STATUS_TONE[row.status]}`}>{DOC_STATUS_LABEL[row.status]}</span>{row.transitStatus==='pending'&&row.status==='posted'&&<span className="pill warn">在途待确认</span>}</span></button>)}
    </div>:<div className="table-scroll"><table className="data-table"><thead><tr><th>单号</th><th>日期</th><th>往来对象</th><th>金额</th><th>收付款账户</th><th>收付款金额</th><th>状态</th><th>经办人</th><th>制单人</th><th>摘要 / 备注</th></tr></thead><tbody>
      {loading&&!data&&<tr><td colSpan={10} className="muted">正在加载单据…</td></tr>}
      {data?.rows.length===0&&<tr><td colSpan={10} className="empty-state muted">{filtersActive?<>当前条件下没有单据<small className="muted">：可以放宽日期范围，或点“重置筛选”</small></>:'没有单据'}</td></tr>}
      {rows.map(row=><tr key={row.id} className={selected===row.id?'selected':undefined} onClick={()=>setSelected(row.id)} style={{cursor:'pointer'}}><td className="mono"><button type="button" className="link-button" onClick={()=>setSelected(row.id)}>{row.docNo}</button> <CopyButton text={row.docNo} label={`单号 ${row.docNo}`}/></td><td>{row.docDate}</td><td>{row.partyName??''}</td><td className={`num ${row.amountCents<0?'neg':''}`}>{money(row.amountCents)}</td><td>{(row.acctCount??0)>1?`${row.bankName??''} 等 ${row.acctCount} 个账户`:row.bankName??''}</td><td className="num">{row.paidCents?money(row.paidCents):''}</td><td><span className={`pill ${DOC_STATUS_TONE[row.status]}`}>{DOC_STATUS_LABEL[row.status]}</span>{row.transitStatus==='pending'&&row.status==='posted'&&<> <span className="pill warn">在途待确认</span></>}</td><td>{row.handler??''}</td><td>{row.createdByName}</td><td>{row.summary&&<div>{row.summary}</div>}{row.memo&&<div className="muted">{row.memo}</div>}</td></tr>)}
    </tbody></table></div>}
    {data&&<Pager page={page} total={data.total} pageSize={PAGE_SIZE} onPage={setPage}/>}
  </div>{selected&&<DocDetail key={selected} id={selected} onClose={()=>setSelected(null)} onChanged={load}/>} {creating&&<DocForm type={def.type} onClose={()=>setCreating(false)} onSaved={doc=>{setCreating(false);setSelected(doc.id);load();}}/>}</div>;
}
