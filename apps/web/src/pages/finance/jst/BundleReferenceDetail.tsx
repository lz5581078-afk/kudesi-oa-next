import {useEffect,useState} from 'react';
import {X} from 'lucide-react';
import {LOGISTICS_CENT_SCALE,unitYuanText} from '@kudesi/shared';
import {jstApi,type BundleReferenceDetail as Detail} from './jstApi';
import './bundleReferenceDetail.css';

const money=(value:number|null|undefined)=>{
 if(value===null||value===undefined)return '未维护';
 const [whole,fraction='']=unitYuanText(value,LOGISTICS_CENT_SCALE).split('.');
 return `¥${whole}.${fraction.padEnd(3,'0')}`;
};
const saleMoney=(value:number|null|undefined)=>value===null||value===undefined?'未维护':`¥${(value/100).toFixed(3)}`;
export function BundleReferenceDetail({id,onClose,onEdit,onComposition}:{id:number;onClose():void;onEdit?:()=>void;onComposition?:()=>void}){
 const [data,setData]=useState<Detail|null>(null),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
 useEffect(()=>{let alive=true;setData(null);setError('');jstApi.bundleComposition(id).then(result=>{if(!alive)return;if(!result.referenceDetail)throw new Error('组成详情暂不可读');setData(result.referenceDetail);}).catch(err=>{if(alive)setError(err instanceof Error?err.message:'组成详情读取失败');});return()=>{alive=false;};},[id,attempt]);
 const groups=[['主商品','main'],['包装','package'],['赠品','gift'],['其他组成','other']] as const;
 const labor=data?.lines.filter(line=>line.role==='labor')??[];
 return <div className="modal-overlay bundle-reference-detail-overlay"><section role="dialog" aria-modal="true" aria-labelledby="bundle-reference-detail-title" className="bundle-reference-detail-dialog"><header><div><h2 id="bundle-reference-detail-title">商品组合编码详情</h2><p>{data?.code||'正在加载…'}</p></div><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X/></button></header>
 {error?<div role="alert" className="bundle-reference-detail-loading">{error}<button type="button" onClick={()=>setAttempt(v=>v+1)}>重试</button></div>:!data?<div className="bundle-reference-detail-loading" role="status">正在加载组成明细…</div>:<div className="bundle-reference-detail-body"><div className="bundle-reference-detail-summary">{[['商品名称',data.name,data.shortName],['主款式编码',data.mainStyleCode,'不包含赠品'],['款式编码',data.styleCode],['平台',data.platform],['规格',data.spec,data.costVersionName?`成本：${data.costVersionName}`:'']].map(([label,value,note])=><div key={label}><span>{label}</span><strong>{value||'-'}</strong>{note&&<small>{note}</small>}</div>)}</div>
 {groups.map(([label,role])=>{
  const lines=data.lines.filter(line=>line.role!=='labor'&&(role==='other'?!['main','package','gift'].includes(line.role):line.role===role)),hasCost=lines.some(line=>'costSubtotal'in line),hasSale=lines.some(line=>'saleSubtotal'in line);
  const columns={gridTemplateColumns:`minmax(280px,2fr) 120px 80px ${hasCost?'120px ':''}${hasSale?'120px ':''}140px`};
  return <section className={`bundle-reference-detail-group role-${role}`} key={role}><div className="bundle-reference-detail-title"><h3>{label}</h3><span>{lines.length} 项</span></div>{lines.length?<div className="bundle-reference-detail-lines" role="table" aria-label={label}>
   <div className="bundle-reference-detail-line head" role="row" style={columns}><span role="columnheader">商品</span><span role="columnheader">规格</span><span role="columnheader">数量</span>{hasCost&&<span role="columnheader">成本小计</span>}{hasSale&&<span role="columnheader">销售小计</span>}<span role="columnheader">重量小计</span></div>
   {lines.map(line=><div role="row" style={columns} key={line.id} className={`bundle-reference-detail-line ${line.role==='gift'?'gift-line':''} ${line.isRawFinishedName?'raw-finished-name-display':''}`}><div role="cell"><strong>{line.name}<em>{label}</em></strong><small>{line.code||'无编码'}</small></div><span role="cell">{line.spec||'-'}</span><span role="cell">{line.qty??'—'}</span>{hasCost&&<span role="cell">{money(line.costSubtotal)}<small>{line.costSource}</small></span>}{hasSale&&<span role="cell">{saleMoney(line.saleSubtotal)}</span>}<span role="cell">{line.weightG===null?'未维护':`${(line.weightG/1000).toFixed(6)} kg`}</span></div>)}
  </div>:<p className="bundle-reference-package-empty">{role==='package'?'当前BOM未维护包装组成。':'无'}</p>}</section>;
 })}
 {!!labor.length&&<section className="bundle-reference-detail-group"><div className="bundle-reference-detail-title"><h3>人工</h3><span>{labor.length} 项</span></div>{labor.map(line=><div className="bundle-reference-labor-row" key={line.id}><strong>{line.name}</strong><span>{line.qty??'—'} {line.unit}</span>{'costSubtotal'in line&&<span>{money(line.costSubtotal)}</span>}</div>)}</section>}</div>}
 <footer>{data&&<>{onEdit&&<button type="button" className="primary" onClick={onEdit}>修改</button>}{onComposition&&<button type="button" className="secondary" onClick={onComposition}>修改组成</button>}</>}<button type="button" className="secondary" onClick={onClose}>关闭</button></footer></section></div>;
}
