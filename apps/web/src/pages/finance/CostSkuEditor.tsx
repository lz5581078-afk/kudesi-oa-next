import { useEffect, useRef, useState } from 'react';
import { scaledDecimal, sumUnitCents, unitYuanText } from '@kudesi/shared';
import { resourceApi, type ResourceDto } from '../../resources/api';
import { FinanceModal } from './FinanceModal';
import { Pager, money } from './common';
import { costVersionsApi, type CostSkuOption, type CostSkuOptions } from './costVersionsApi';

const fields = {purchaseCost:'采购成本',transferCost:'调运成本',preShipPackageCost:'发货前包装成本',productionCost:'生产成本',shippingPackageCost:'发货包装成本',estimatedExpressCost:'预计快递成本'};

/** 选择SKU并维护独立计算设置；六科目快照由确认重算生成，普通保存仍走统一资料接口。 */
export function CostSkuEditor({version,record,onClose,onSaved}:{version:ResourceDto;record:ResourceDto | null;onClose:()=>void;onSaved:()=>void}) {
  const [skuType,setSkuType]=useState(String(record?.data.skuType || 'base_code'));
  const [selected,setSelected]=useState<CostSkuOption | null>(record ? {skuType:String(record.data.skuType),skuId:Number(record.data.baseCodeId || record.data.bundleId),code:String(record.data.skuCode || ''),name:String(record.data.skuName || record.title),weightG:null,buckets:{},warnings:[]} : null);
  const [keyword,setKeyword]=useState(''),[query,setQuery]=useState(''),[page,setPage]=useState(1),[options,setOptions]=useState<CostSkuOptions | null>(null);
  const [weight,setWeight]=useState(record?.data.weightManual===true?String(Number(record.data.estimatedWeightG)/1000):'');
  const [markup,setMarkup]=useState(record?.data.markupPercent==null?'':String(record.data.markupPercent));
  const [warehouse,setWarehouse]=useState(String(record?.data.warehouseName || '')),[note,setNote]=useState(String(record?.data.note || ''));
  const [busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const serial=useRef(0);
  useEffect(()=>{
    const token=++serial.current;setLoading(true);setOptions(null);
    void costVersionsApi.skuOptions(version.id,{skuType,keyword:record?String(record.data.skuCode || ''):query,page:record?1:page}).then(data=>{if(token===serial.current){setOptions(data);if(record){const found=data.rows.find(r=>r.skuId===Number(record.data.baseCodeId || record.data.bundleId));if(found)setSelected(found);}}}).catch(e=>{if(token===serial.current)setError((e as Error).message);}).finally(()=>{if(token===serial.current)setLoading(false);});
    return()=>{serial.current++;};
  },[version.id,record,skuType,query,page]);
  async function save(){
    if(!selected || busy)return;
    setError('');
    let grams:number | null=null,rate:number | null=null;
    try {
      if(weight.trim()){
        if(!/^\d+(?:\.\d{1,6})?$/.test(weight.trim()))throw new Error('预计重量最多保留六位小数，且不能为负数');
        grams=Number(scaledDecimal(weight.trim(),6))/1000;
        if(!Number.isSafeInteger(Math.round(grams*1000)))throw new Error('预计重量超出允许范围');
      }
      if(markup.trim()){
        if(!/^\d+(?:\.\d{1,6})?$/.test(markup.trim()) || Number(markup)>10000)throw new Error('加价率应为 0 到 10000%，最多六位小数');
        rate=Number(markup);
      }
      setBusy(true);
      const data={versionId:version.id,skuType:selected.skuType,[selected.skuType==='base_code'?'baseCodeId':'bundleId']:selected.skuId,estimatedWeightG:grams,markupPercent:rate,warehouseName:warehouse,note};
      if(record)await resourceApi.update('finance-cost-skus',record.id,data);
      else await resourceApi.create('finance-cost-skus',data);
      onSaved();
    } catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <FinanceModal title={record?'SKU计算设置':'选择SKU设置'} busy={busy} onClose={onClose}>
    {error && <div role="alert" className="notice error">{error}</div>}
    {!record && <section className="card"><form className="toolbar" onSubmit={e=>{e.preventDefault();setPage(1);setQuery(keyword.trim());}}>
      <label>编码类型<select value={skuType} onChange={e=>{setSkuType(e.target.value);setSelected(null);setPage(1);}}><option value="base_code">商品基础编码</option><option value="bundle">商品组合编码</option></select></label>
      <input aria-label="搜索成本SKU" type="search" placeholder="编码或商品名称" value={keyword} onChange={e=>setKeyword(e.target.value)}/><button type="submit" className="secondary-button">查询SKU</button>
    </form><div className="table-scroll"><table className="data-table"><thead><tr><th>编码 / 商品</th><th>参考重量（kg）</th><th>操作</th></tr></thead><tbody>{options?.rows.map(row=><tr key={row.skuId}><td><strong>{row.code}</strong><div>{row.name}</div></td><td>{row.weightG==null?'—':row.weightG/1000}</td><td><button type="button" className={selected?.skuId===row.skuId?'primary-button':'secondary-button'} onClick={()=>{setSelected(row);setWeight('');}}>{selected?.skuId===row.skuId?'已选择':'选择'}</button></td></tr>)}{!options?.rows.length && <tr><td colSpan={3}>{loading?'正在查询…':'没有匹配的已验证SKU'}</td></tr>}</tbody></table></div><Pager page={page} total={options?.total ?? 0} pageSize={30} onPage={setPage}/></section>}
    {selected && <section className="card"><h3>{selected.code} · {selected.name}</h3>{selected.warnings?.length>0 && <p className="muted">{selected.warnings.join('；')}</p>}
      <h4>自动计算成本快照</h4><p className="muted">六科目金额只读。修改档案、BOM、生产标准、辅助成本或计算设置后，先预检自动重算，再确认更新成本快照。</p>
      <div className="form-grid">{Object.entries(fields).map(([key,label])=><label key={key}>{label}<input readOnly value={record?.data[key]==null?'待重算':unitYuanText(Number(record.data[key]))}/></label>)}</div>
      {record && <p>当前已保存成本：{money(sumUnitCents(Object.keys(fields).map(key=>Number(record.data[key] || 0))))}</p>}
    </section>}
    <form className="form-grid" onSubmit={e=>{e.preventDefault();void save();}}>
      <label>预计重量覆盖（kg）<input inputMode="decimal" aria-label="预计重量覆盖（kg）" placeholder="留空使用商品资料重量" value={weight} onChange={e=>setWeight(e.target.value)}/>{selected?.weightG!=null && <button type="button" className="link-button" onClick={()=>setWeight(String(selected.weightG!/1000))}>采用参考重量 {selected.weightG/1000} kg</button>}</label>
      <label>SKU加价率覆盖（%）<input inputMode="decimal" placeholder={`留空使用版本默认 ${String(version.data.defaultMarkupPercent)}%`} value={markup} onChange={e=>setMarkup(e.target.value)}/></label>
      <label>生产仓库<input value={warehouse} onChange={e=>setWarehouse(e.target.value)}/></label><label>设置备注<textarea value={note} onChange={e=>setNote(e.target.value)}/></label>
      <div className="row-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy || !selected}>保存SKU计算设置</button></div>
    </form>
  </FinanceModal>;
}
