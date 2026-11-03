import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DOC_DIRECTION, DOC_DIRECTION_LABEL, DOC_TYPES } from '@kudesi/shared';
import { ClipboardList, FileCheck2, Search } from 'lucide-react';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { DocDetail } from './DocDetail';
import { referenceMoney } from './common';
import { financeApi, type DocRow } from './financeApi';
import { QueryPage, QueryPanel, QueryTable, type Col } from './query/QueryKit';
import { ReferenceSearch, querySearchTerms } from './query/ReferenceSearch';
import { documentSourceKind, documentSummary, documentDisplayState } from './documentPresentation';
export { documentSummary, documentDisplayState } from './documentPresentation';
import './documentCenter.css';

type Scope='history'|'drafts';
type Filters={from:string;to:string;type:string;direction:string;status:string;keyword:string};
const empty:Filters={from:'',to:'',type:'',direction:'',status:'',keyword:''};
const statusLabels={draft:'草稿',issued:'已制单',pending:'待确认',completed:'已完成',cancelled:'已取消'};
const statusText=(value:keyof typeof statusLabels)=>value==='issued'?'已开单':value==='pending'?'待处理':statusLabels[value];
const rowDirection=(row:DocRow)=>row.direction||DOC_DIRECTION[row.docType]||'internal';
export function DocumentCenter({scope}:{scope:Scope}){
  const {user}=useAuth();
  return <CenterContent key={JSON.stringify([scope,user?.companyId,user?.id,user?.permissions])} scope={scope}/>;
}
function CenterContent({scope}:{scope:Scope}){
  const {can}=useAuth();
  const includePending=scope==='history'&&can('finance.drafts.view');
  const [filters,setFilters]=useState<Filters>(()=>{const today=new Date().toISOString().slice(0,10);return scope==='history'?{...empty,from:today,to:today}:{...empty};});
  const [records,setRecords]=useState<DocRow[]|null>(null),[todayCount,setTodayCount]=useState<number|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const [selected,setSelected]=useState<DocRow|null>(null);
  const mounted=useRef(false),request=useRef(0);
  const load=useCallback(async()=>{
    const serial=++request.current,current=()=>mounted.current&&request.current===serial;
    setLoading(true);setError('');
    try{
      const collected:DocRow[]=[],seen=new Set<number>();let total:number|undefined,today:number|undefined;
      for(let page=1;;page++){
        if(!current())return;
        const response=await financeApi.docs({scope,...(includePending?{includeDrafts:'yes' as const}:{}),...(scope==='drafts'?{status:'draft'}:{}),page,pageSize:200});
        if(!current())return;
        if(total===undefined){total=response.total;today=response.todayCount;}else if(total!==response.total)throw new Error('读取期间单据发生变动，请重新查询。');
        for(const row of response.rows){if(seen.has(row.id))throw new Error('读取期间单据顺序发生变动，请重新查询。');seen.add(row.id);collected.push(row);}
        if(collected.length>=total)break;
        if(!response.rows.length)throw new Error('单据未能完整读取，请重新查询。');
      }
      if(current()){
        const key=(row:DocRow)=>`${row.docDate}-${documentSourceKind(row)}-${row.id}`;
        setRecords(collected.sort((a,b)=>key(b).localeCompare(key(a))));setTodayCount(typeof today==='number'?today:null);
      }
    }catch(err){if(current())setError(err instanceof ApiError||err instanceof Error?err.message:'财务单据加载失败');}
    finally{if(current())setLoading(false);}
  },[scope,includePending]);
  useEffect(()=>{mounted.current=true;void load();return()=>{mounted.current=false;request.current++;};},[load]);
  const filtered=useMemo(()=>records?.filter(row=>{
    if(filters.from&&row.docDate<filters.from||filters.to&&row.docDate>filters.to)return false;
    if(filters.type&&row.docType!==filters.type||filters.direction&&rowDirection(row)!==filters.direction||filters.status&&documentDisplayState(row)!==filters.status)return false;
    const terms=querySearchTerms(filters.keyword);if(!terms.length)return true;
    const text=[row.docNo,documentSummary(row),row.partyName,row.handler,row.source].join(' ').toLocaleLowerCase();
    return terms.some(term=>text.includes(term.toLocaleLowerCase()));
  })??null,[records,filters]);
  const field=<K extends keyof Filters>(key:K,value:Filters[K])=>setFilters(previous=>({...previous,[key]:value}));
  const columns=useMemo<Array<Col<DocRow>>>(()=>{
    const date:Col<DocRow>={key:'date',head:scope==='drafts'?'草稿日期':'日期',cell:row=>row.docDate,csv:row=>row.docDate};
    const type:Col<DocRow>={key:'type',head:'单据类型',cell:row=>row.typeLabel,csv:row=>row.typeLabel};
    const no:Col<DocRow>={key:'no',head:'单据编号',cell:row=><span className="document-center-main-text">{row.docNo}</span>,csv:row=>row.docNo};
    const summary:Col<DocRow>={key:'summary',head:'摘要',cell:documentSummary,csv:documentSummary};
    const party:Col<DocRow>={key:'party',head:'关联对象',cell:row=>row.partyName||'-',csv:row=>row.partyName||''};
    const amount:Col<DocRow>={key:'amount',head:'金额',cell:row=>referenceMoney(row.amountCents),csv:row=>row.amountCents/100};
    const source:Col<DocRow>={key:'source',head:'来源',cell:row=>row.source||'',csv:row=>row.source||''};
    const action:Col<DocRow>={key:'action',head:'操作',action:true,cell:row=><button type="button" className="link-button" onClick={()=>setSelected(row)}>{scope==='drafts'?'查看草稿':'查看'}</button>};
    return scope==='drafts'?[date,type,no,summary,party,amount,source,action]:[
      date,type,no,summary,{key:'direction',head:'方向',cell:row=>DOC_DIRECTION_LABEL[rowDirection(row)],csv:row=>DOC_DIRECTION_LABEL[rowDirection(row)]},amount,party,
      {key:'handler',head:'经办人',cell:row=>row.handler||'-',csv:row=>row.handler||''},source,
      {key:'posting',head:'过账状态',cell:row=>row.status==='posted'?'已过账':row.status==='reversed'?'已红冲':'未过账',csv:row=>row.status==='posted'?'已过账':row.status==='reversed'?'已红冲':'未过账'},
      {key:'status',head:'状态',cell:row=><span className={`document-center-status ${documentDisplayState(row)}`}>{statusText(documentDisplayState(row))}</span>,csv:row=>statusText(documentDisplayState(row))},action,
    ];
  },[scope]);
  const income=filtered?.filter(row=>rowDirection(row)==='in').reduce((sum,row)=>sum+row.amountCents,0),expense=filtered?.filter(row=>rowDirection(row)==='out').reduce((sum,row)=>sum+row.amountCents,0);
  const title=scope==='history'?'经营历程':'草稿中心';
  const searchText=useCallback((row:DocRow)=>{
    const kind=documentSourceKind(row);
    return[`${kind}-${row.id}`,kind,row.id,row.docDate,row.typeLabel,row.docNo,documentSummary(row),row.amountCents/100,DOC_DIRECTION_LABEL[rowDirection(row)],row.partyName||'-',row.handler||'-',row.source,documentDisplayState(row),row.status==='posted'?'posted':row.status==='reversed'?'reversed':'unposted'].join(' ');
  },[]);
  const stats=scope==='history'?[
    {label:'单据数量',value:filtered?`${filtered.length} 条`:'加载中',tone:'blue'},
    {label:'收入合计',value:referenceMoney(income),tone:'green'},
    {label:'支出合计',value:referenceMoney(expense),tone:'amber'},
    {label:'净额',value:referenceMoney(income===undefined||expense===undefined?undefined:income-expense),tone:'purple'},
  ]:[
    {label:'财务草稿',value:records?`${records.length} 条`:'加载中',tone:'amber'},
    {label:'待补充资料',value:'0 条',tone:'blue'},
    {label:'待提交审核',value:'0 条',tone:'purple'},
    {label:'今日新增草稿',value:todayCount===null?'—':`${todayCount} 条`,tone:'green'},
  ];
  return <QueryPage className="finance-reference-query finance-document-center" title={title} subtitle={scope==='history'?'把费用、付款、收款、提现、入库成本和流程自动生成的财务单据集中查询。':'集中查看尚未提交、待补充和可继续处理的财务单据草稿。后续流程自动生成的草稿也会统一进入这里。'}>
    {scope==='history'&&<QueryPanel title="查询条件" icon={<Search size={18}/>}><div className="reference-query-filters">
      <label><span>开始日期</span><input aria-label="开始日期" type="date" value={filters.from} onChange={event=>field('from',event.target.value)}/></label>
      <label><span>结束日期</span><input aria-label="结束日期" type="date" value={filters.to} onChange={event=>field('to',event.target.value)}/></label>
      <label><span>单据类型</span><select aria-label="单据类型" value={filters.type} onChange={event=>field('type',event.target.value)}><option value="">全部类型</option>{DOC_TYPES.filter(type=>type.type!=='withdrawal').map(type=><option key={type.type} value={type.type}>{type.label}</option>)}</select></label>
      <label><span>收支方向</span><select aria-label="收支方向" value={filters.direction} onChange={event=>field('direction',event.target.value)}><option value="">全部方向</option>{Object.entries(DOC_DIRECTION_LABEL).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      <label><span>单据状态</span><select aria-label="单据状态" value={filters.status} onChange={event=>field('status',event.target.value)}><option value="">全部状态</option>{Object.entries(statusLabels).filter(([value])=>value!=='draft'||includePending).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      <label className="reference-query-keyword"><span>关键词</span><ReferenceSearch label="关键词" value={filters.keyword} onChange={value=>field('keyword',value)} placeholder="搜索单号、摘要、关联对象、经办人"/></label>
      <div className="reference-query-actions"><button type="button" className="primary-button" disabled={loading} onClick={()=>void load()}>{loading?'查询中':'查询'}</button><button type="button" className="secondary-button" onClick={()=>setFilters({...empty})}>重置</button></div>
    </div></QueryPanel>}
    {error&&<div className="notice error" role="alert">{error}<button type="button" className="link-button" onClick={()=>void load()}>重试</button></div>}
    <div className="reference-query-metrics" aria-label="汇总">{stats.map(stat=><div key={stat.label} className={`reference-query-metric ${stat.tone}`}><span>{stat.label}</span><strong>{stat.value}</strong></div>)}</div>
    <QueryPanel title={scope==='history'?'财务单据汇总':'财务单据草稿'} icon={scope==='history'?<ClipboardList size={18}/>:<FileCheck2 size={18}/>}>
      {(!error||records!==null)&&<QueryTable cols={columns} rows={filtered} rowKey={row=>row.id} caption={title} empty="暂无数据" foot={false} controls={{storageKey:`oa.finance.${scope}.reference-columns.v1`,searchText,searchPlaceholder:scope==='history'?'搜索当前单据列表':'搜索草稿单号、摘要、关联对象'}}/>}
    </QueryPanel>
    {selected&&<DocDetail key={selected.id} id={selected.id} row={selected} presentation="reference" onClose={()=>setSelected(null)} onChanged={()=>void load()}/>}
  </QueryPage>;
}
