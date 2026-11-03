import { useEffect, useRef, useState } from 'react';
import { Database, Search } from 'lucide-react';
import { useAuth } from '../../auth/AuthContext';
import { referenceMoney } from './common';
import { financeApi, type StockRow } from './financeApi';
import { QueryPage, QueryPanel, QueryTable, type Col } from './query/QueryKit';
import { ReferenceSearch } from './query/ReferenceSearch';

interface Filters { keyword: string; warehouse: string; stockStatus: string }
const empty:Filters={keyword:'',warehouse:'',stockStatus:''};
/** 原库存查询只在明确查询后读取，重置条件保留已读取的库存事实。 */
export function InventoryPage(){
  const {user}=useAuth();
  return <InventoryQuery key={JSON.stringify([user?.companyId,user?.id,user?.permissions])}/>;
}
function InventoryQuery(){
  const [filters,setFilters]=useState<Filters>({...empty}),[rows,setRows]=useState<StockRow[]>([]),[busy,setBusy]=useState(false),[queried,setQueried]=useState(false),[error,setError]=useState('');
  const mounted=useRef(false),serial=useRef(0);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;serial.current++;};},[]);
  const query=async()=>{
    const request=++serial.current,current=()=>mounted.current&&serial.current===request;
    setError('');setBusy(true);setQueried(true);
    try{const result=await financeApi.inventory({keyword:filters.keyword.trim()||undefined,warehouse:filters.warehouse||undefined,stockStatus:filters.stockStatus||undefined});if(current())setRows(result);}
    catch(error){if(current())setError(error instanceof Error?error.message:'库存读取失败');}
    finally{if(current())setBusy(false);}
  };
  const reset=()=>{serial.current++;setFilters({...empty});setQueried(false);setBusy(false);setError('');};
  const hasCost=rows.some(row=>row.amountCents!==null);
  const cols:Col<StockRow>[]=[
    {key:'code',head:'商品编码',cell:row=>row.code,csv:row=>row.code},
    {key:'name',head:'商品名称',cell:row=>row.productName||'历史商品',csv:row=>row.productName},
    {key:'warehouse',head:'仓库',cell:row=>row.warehouseName,csv:row=>row.warehouseName},
    {key:'qty',head:'数量',cell:row=>row.qty,csv:row=>row.qty},
    {key:'unit',head:'单位',cell:row=>row.unit,csv:row=>row.unit},
    ...(hasCost?[
      {key:'amount',head:'库存成本',cell:(row:StockRow)=>referenceMoney(row.amountCents),csv:(row:StockRow)=>row.amountCents===null?'':row.amountCents/100},
      {key:'avg',head:'平均单位成本',cell:(row:StockRow)=>row.avgCostCents===null?'—':referenceMoney(row.avgCostCents),csv:(row:StockRow)=>row.avgCostCents===null?'':row.avgCostCents/100},
    ]:[]),
  ];
  return <QueryPage className="finance-reference-query" title="库存查询" subtitle="按商品、仓库和库存状态查询实时库存。数据来自本地标准单据过账，采购分批入库可追溯。">
    <QueryPanel title="查询条件" icon={<Search size={18}/>}><div className="reference-query-filters">
      <label className="reference-query-keyword"><span>商品</span><ReferenceSearch label="商品" value={filters.keyword} onChange={keyword=>setFilters(current=>({...current,keyword}))} placeholder="商品编码、商品名称或规格"/></label>
      <label><span>仓库</span><input aria-label="仓库" maxLength={160} value={filters.warehouse} placeholder="全部仓库" onChange={event=>setFilters(current=>({...current,warehouse:event.target.value}))}/></label>
      <label><span>库存状态</span><select aria-label="库存状态" value={filters.stockStatus} onChange={event=>setFilters(current=>({...current,stockStatus:event.target.value}))}><option value="">全部状态</option><option value="normal">库存正常</option><option value="out">缺货</option></select></label>
      <div className="reference-query-actions"><button type="button" className="primary-button" disabled={busy} onClick={()=>void query()}>查询</button><button type="button" className="secondary-button" onClick={reset}>重置</button></div>
    </div></QueryPanel>
    {error&&<div className="notice error" role="alert">{error}</div>}
    <QueryPanel title="已过账库存" icon={<Database size={18}/>}>
      {busy?<p role="status">正在读取已过账库存…</p>:rows.length?<QueryTable cols={cols} rows={rows} rowKey={row=>`${row.warehouseId}-${row.productId}-${row.unit}`} caption="已过账库存" empty="暂无数据" foot={false} controls={{storageKey:'oa.finance.inventory.reference-columns.v1'}}/>:<section className="reference-query-empty"><Database size={34}/><h2>{queried?'暂无库存快照':'请先输入查询条件'}</h2><p>{queried?'当前条件下没有本地已过账库存记录。':'支持按商品、仓库和库存状态查询本地已过账库存。'}</p></section>}
    </QueryPanel>
  </QueryPage>;
}
