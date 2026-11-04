import {Fragment,useEffect,useState} from 'react';
import {LOGISTICS_CENT_SCALE,sumUnitCents,unitYuanText,validUnitCents,specificationWeightG,getResourceDef} from '@kudesi/shared';
import type {ResourceDto} from './api';
import {resourceApi} from './api';
import {FinanceSection} from './FinanceDetailFields';
import {useProductPurchaseHistory,purchasePriceStats,purchaseRecordedAt} from './ProductPurchaseHistory';
import {currentProductPurchasePrice} from './productPurchasePrice';
import {useProductProcurementFacts} from './productProcurementFacts';
import {unitOptionLabel} from './unitOptions';
import {formatOaDateTime} from '../lib/oaDateTime';
import {useCostIdentityKey} from '../pages/finance/CostIdentityBoundary';
import './productArchiveViewCosts.css';
const value=(v:unknown)=>validUnitCents(v,LOGISTICS_CENT_SCALE)?v:null;
const money=(v:number|null)=>v===null?'待补齐':`¥${(()=>{const [a,b='']=unitYuanText(v,LOGISTICS_CENT_SCALE).split('.');return `${a}.${b.padEnd(3,'0')}`;})()}`;
const date=(v:unknown)=>formatOaDateTime(v,{empty:'未记录时间'});
export function ProductViewTotal({record}:{record:ResourceDto}){
 const f=value(record.data.freight),h=value(record.data.handlingFee),price=currentProductPurchasePrice(record),logistics=f===null||h===null?null:sumUnitCents([f,h],LOGISTICS_CENT_SCALE);
 const total=price===null||logistics===null?null:value(record.data.totalCost),composed=record.data.archiveType==='self_made'||record.data.supplyMode==='supplier_oem';
 return <div className="product-view-cost-grid">{[[composed?'总采购价':'采购价',price],['运费＋装卸费',logistics],[`总成本价${record.data.purchaseSpec?`（元/${String(record.data.purchaseSpec)}）`:''}`,total]].map(([label,amount],i)=><div className={i===2?'is-total':''} key={String(label)}><small>{label}</small><strong>{money(amount as number|null)}</strong></div>)}</div>;
}
export function ProductViewProcurement({record,canCost}:{record:ResourceDto;canCost:boolean}){
 const self=record.data.archiveType==='self_made',oem=record.data.supplyMode==='supplier_oem',composed=self||oem;
 const {rows,error,retry}=useProductPurchaseHistory(record,canCost),[open,setOpen]=useState(false),stats=purchasePriceStats(rows??[]),price=currentProductPurchasePrice(record);
 const {facts,error:factsError}=useProductProcurementFacts(record,canCost);
 const formatted=(amount:number|null)=>amount===null?'暂无':`¥${(amount/100).toFixed(composed?3:2)}`;
 const weight=(grams:number|null)=>grams===null?'待补齐':`${Number((grams/1000).toFixed(6))} kg`;
 const amount=(v:number|null|undefined)=>money(v??null);
 const raw=facts?.rawCost,pack=facts?.packageCost,labor=facts?.laborCost,logistics=facts?.logistics;
 const net=specificationWeightG(record.data.specQty,record.data.specUnit),packageWeight=facts?.packageWeightG??null;
 const unitField=getResourceDef('finance-products')!.fields.find(field=>field.key==='specUnit')!,unitCode=String(record.data.specUnit||''),unitName=unitOptionLabel(unitField,record.data,unitCode)||unitField.options?.find(option=>option.value===unitCode)?.label||unitCode;
 const weighing=typeof record.data.weightG==='number'&&Number.isFinite(record.data.weightG)&&record.data.weightG>=0?record.data.weightG:null,weightTotal=self?facts?.weightG??null:weighing;
 const formula=(label:string,parts:Array<[string,number|null|undefined]>)=><div className={`product-view-price-formula${self?' is-self':''}`} aria-label={label}>{parts.map(([title,value],index)=><Fragment key={title}>{index>0&&<i>{index===parts.length-1?'=':'+'}</i>}<span className={index===parts.length-1?'is-total':''}><small>{title}</small><b>{amount(value)}</b></span></Fragment>)}</div>;
 const hint=self?'集中确认系统规格、组成重量和最终采购成本。':oem?'填写原料采购价，系统自动加上 OEM 包装费用，得出总采购价。':'称重重量按名称规格和名称单位自动换算；系统规格用于采购价和后续业务单据。';
 return <FinanceSection className={`product-view-procurement${self?' is-self':oem?' is-oem':''}`} title={self?'计量与成本结果':'采购计价'} hint={hint} step={oem?'03':undefined}>
 {self&&canCost&&<div className="product-view-settlement-overview" aria-label="自产成品成本与重量实时汇总">{[['原料',raw,weight(facts?.rawWeightG??null)],['包装',pack,weight(packageWeight)],['运费装卸费',logistics,`运费 ${amount(facts?.freight)} · 装卸 ${amount(facts?.handling)}`],['人工',labor,'不计重量'],['成品汇总',price,weight(facts?.weightG??null)]].map(([title,value,note],index)=><Fragment key={String(title)}>{index>0&&<i>{index===4?'=':'+'}</i>}<div className={index===4?'is-total':''}><small>{title}</small><strong>{amount(value as number|null|undefined)}</strong><span>{note}</span></div></Fragment>)}</div>}
 <div className="product-view-procurement-grid">
 {self&&<label className="product-view-system-spec"><span>系统规格 <em>必填</em><button type="button" disabled>管理系统规格</button></span><input readOnly value={String(record.data.purchaseSpec||'')}/><small>从统一维护的系统规格中选择；用于采购价计量，并供后续采购单、销售单选择。</small></label>}
 <label className="product-view-weighing"><span>称重重量 <em>必填</em></span><div className="product-view-weight-control"><input type="number" readOnly value={weightTotal===null?'':Number((weightTotal/1000).toFixed(6))}/><b>kg</b></div>{composed&&<div className="product-view-weight-breakdown" aria-label={self?'自产成品重量组成':'称重重量组成'}>{[[self?'原料重量':'商品净重',self?facts?.rawWeightG??null:net],['包装重量',packageWeight],[self?'总重量':'称重重量',self?facts?.weightG??null:net===null||packageWeight===null?null:Math.round((net+packageWeight)*1e6)/1e6]].map(([title,value],index)=><Fragment key={String(title)}>{index>0&&<i>{index===2?'=':'+'}</i>}<span className={index===2?'is-total':''}><small>{title}</small><b>{weight(value as number|null)}</b></span></Fragment>)}</div>}<small>{self?'自动换算为 kg：各原料和包装档案单重 × 对应倍数，人工不计重量。':record.data.weightManual===true?'当前使用人工纠错重量。':oem?'自动换算为 kg：商品净重 + 各 OEM 包装单件重量 × 数量。':weighing!==null?`已按“${[record.data.specQty,unitName].filter(Boolean).join(' ')}”自动换算。`:'请填写可换算的名称规格和名称单位，例如“500克/袋”或“25kg”。'}</small></label>
 </div>
 {canCost&&<div className="product-view-purchase-panel"><label><span>{self?'总采购价':oem?'原料采购价':'采购价'}{record.data.purchaseSpec?`（元/${String(record.data.purchaseSpec)}）`:''} <em>必填</em></span><div className="product-view-price-input"><b>¥</b><input data-field="purchasePrice" type="number" readOnly step="0.000001" value={value(self?price:record.data.purchasePrice)===null?'':unitYuanText(Number(self?price:record.data.purchasePrice),self?LOGISTICS_CENT_SCALE:4)}/></div></label>
 {self&&formula('自产成品总采购价计算公式',[['原料成本',raw],['包装成本',pack],['运费装卸费',logistics],['人工成本',labor],['总采购价',price]])}
 {oem&&formula('总采购价计算公式',[['原料采购价',value(record.data.purchasePrice)],['包装费用',pack],['总采购价',price]])}
 <div className="product-view-purchase-stat"><span>上次{composed?'总':''}采购价</span><strong>{error?'读取失败':rows===null?'读取中…':formatted(stats.last)}</strong></div><div className="product-view-purchase-stat"><span>3个月平均{composed?'总':''}采购价</span><strong>{error?'读取失败':rows===null?'读取中…':formatted(stats.average)}</strong></div><button type="button" className="secondary-button" aria-expanded={open} onClick={()=>setOpen(v=>!v)}>历史采购价{rows&&stats.rows.length?`（${stats.rows.length}）`:''}</button></div>}
 {factsError&&<p role="alert">组成事实读取失败：{factsError}</p>}
 {canCost&&error&&<p role="alert">历史采购价读取失败。<button type="button" onClick={retry}>重试</button></p>}
 {canCost&&open&&<div className="product-view-purchase-history">{rows===null&&!error?<p>读取中…</p>:!error&&!stats.rows.length?<p>暂无历史采购价。</p>:stats.rows.map(row=><div key={row.id}><strong>¥{(Number(row.data.purchasePrice)/100).toFixed(2)}</strong><span>{date(purchaseRecordedAt(row))}</span></div>)}</div>}
 </FinanceSection>;
}

const sourceLabels:Record<string,string>={manual:'人工录入',purchase_order:'采购单计算',finance_document:'财务单据计算',system_calculation:'系统自动计算',import:'数据导入'};
export function ProductViewFreightHistory({record}:{record:ResourceDto}){
 const [open,setOpen]=useState(false),[retry,setRetry]=useState(0),[state,setState]=useState<{key:string;rows:ResourceDto[]|null;error:string}>({key:'',rows:null,error:''});
 const identity=useCostIdentityKey(),key=JSON.stringify([identity,record.id,record.updatedAt]);
 useEffect(()=>{if(!open)return;let alive=true;(async()=>{const rows:ResourceDto[]=[],seen=new Set<number>();let total:number|null=null;for(let page=1;alive;page++){const result=await resourceApi.list('finance-product-freight-history',{fieldKey:'productId',fieldValue:record.id,page,pageSize:200,showHidden:true});if(!alive)return;if(!Number.isSafeInteger(result.total)||result.total<0||total!==null&&total!==result.total)throw new Error('历史资料已变化，请重试');total=result.total;for(const row of result.items){if(seen.has(row.id))throw new Error('历史读取不完整，请重试');seen.add(row.id);rows.push(row);}if(rows.length===total)break;if(rows.length>total||!result.items.length)throw new Error('历史读取不完整，请重试');}rows.sort((a,b)=>String(b.data.recordedAtKey||b.createdAt).localeCompare(String(a.data.recordedAtKey||a.createdAt))||b.id-a.id);if(alive)setState({key,rows,error:''});})().catch(e=>{if(alive)setState({key,rows:null,error:e instanceof Error?e.message:'历史读取失败'});});return()=>{alive=false;};},[key,open,retry,record.id]);
 const rows=state.key===key?state.rows:null,error=state.key===key?state.error:'';
 const f=value(record.data.freight),h=value(record.data.handlingFee);
 return <><div className="product-view-cost-grid">{[['运费装卸费汇总',money(f===null||h===null?null:sumUnitCents([f,h],LOGISTICS_CENT_SCALE))],['关联系统规格',String(record.data.purchaseSpec||'未维护')],['关联采购价',money(currentProductPurchasePrice(record))]].map(([title,text])=><div key={title}><small>{title}</small><strong>{text}</strong></div>)}</div><button type="button" className="secondary-button" aria-expanded={open} onClick={()=>setOpen(v=>!v)}>历史运费装卸费</button><p className="product-view-freight-help">手工修改运费、装卸费、系统规格或采购价时，保存后都会生成新的历史记录。</p>
 {open&&<div className="product-view-freight-history">{error?<p role="alert">{error}<button type="button" onClick={()=>setRetry(n=>n+1)}>重试</button></p>:rows===null?<p>读取中…</p>:!rows.length?<p>暂无历史运费装卸费，首次填写并保存后自动记录。</p>:rows.map(row=>{const d=row.data,f=value(d.freight),h=value(d.handlingFee);return <div key={row.id}><strong>{money(f===null||h===null?null:sumUnitCents([f,h],LOGISTICS_CENT_SCALE))}</strong>{[['运费',money(f)],['装卸费',money(h)],['系统规格',String(d.systemSpec||'未维护')],['采购价',value(d.purchasePrice)===null?'未维护':money(value(d.purchasePrice))],['来源',sourceLabels[String(d.sourceType)]||String(d.sourceType||'人工录入')],['记录人与时间',`${String(d.operatorName||'未记录操作人')} · ${date(d.recordedAtKey||row.createdAt)}`]].map(([label,text])=><span key={label}><small>{label}</small>{text}</span>)}</div>;})}</div>}</>;
}
