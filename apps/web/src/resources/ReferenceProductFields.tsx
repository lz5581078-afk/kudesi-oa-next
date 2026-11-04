import {formatOaDateTime} from '../lib/oaDateTime';
import {ReasonDialog as MessageConfirm} from './ResourceConfirmDialog';
import type {SourceFinishedNameRow} from './sourceProductFinishedNames';
import {useAuth} from '../auth/AuthContext';
import {productReferenceCostText} from './productReferenceList';
import { ManageLink } from './ManageLink';
import {FilesInput} from './FilesField';
import './productArchivePhotos.css';
import { Fragment, useEffect, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { productCapacity, productCapacityText, unitYuanText, sumUnitCents, LOGISTICS_CENT_SCALE, specificationWeightG, getResourceDef,type FieldDef } from '@kudesi/shared';
import { type ResourceDto,type FileInfo } from './api';
import {loadResourceDirectory} from './resourceDirectory';
import { useUnitOptions, fieldOptions } from './unitOptions';

/** 多行编辑只改变呈现方式，仍保存原有的一行一项格式，兼容既有马甲和容量资料。 */
export function ReferenceLines({ kind, value, onChange, defaultUnit,finishedRows,onFinishedRowsChange,parentValues }: { finishedRows?:SourceFinishedNameRow[];onFinishedRowsChange?:(rows:SourceFinishedNameRow[])=>void;parentValues?:Record<string,unknown>;kind: 'finishedNames' | 'capacities'; value: unknown; onChange: (value: string) => void; defaultUnit?: string }) {
  const [lines, setLines] = useState(() => { const initial = String(value ?? '').split(/\r?\n/).filter(Boolean); return initial.length || kind !== 'capacities' ? initial : [defaultUnit || '']; });
  const units = useUnitOptions();
  const capacity = kind === 'capacities';
  const [deleting,setDeleting]=useState<string|null>(null);
  const unitField = { ...getResourceDef('finance-products')!.fields.find(f => f.key === 'specUnit')!, label: '单位' };
  const options = fieldOptions(unitField, parentValues??{}, units);
  const lastWritten = useRef(String(value ?? '')), touched = useRef(false);
  const write = (next: string[]) => { touched.current = true; lastWritten.current = next.map(line => capacity && !line ? ' ' : line).join('\n'); setLines(next); onChange(lastWritten.current); };
  useEffect(() => {
    if (String(value ?? '') === lastWritten.current) return;
    lastWritten.current = String(value ?? ''); touched.current = false;
    const next = String(value ?? '').split(/\r?\n/).filter(Boolean);
    setLines(next.length || !capacity ? next : [defaultUnit || '']);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (capacity && defaultUnit && !touched.current && !String(value ?? '')) setLines(current => current.length === 1 ? [defaultUnit] : current);
  }, [capacity, defaultUnit]); // eslint-disable-line react-hooks/exhaustive-deps
  if(!capacity&&finishedRows&&onFinishedRowsChange){
    const unitField=getResourceDef('finance-products')!.fields.find(field=>field.key==='specUnit')!,unit=fieldOptions(unitField,parentValues??{},units).find(option=>option.value===parentValues?.specUnit)?.label||String(parentValues?.specUnit||''),fullName=(name:string)=>[name,parentValues?.specQty,unit,parentValues?.materialCode].filter(value=>value!==undefined&&value!==null&&String(value).trim()).join('-');
    return <div className="reference-lines reference-finished-names" data-field="rawFinishedNames"><div className="reference-lines-actions"><button type="button" className="secondary-button" onClick={()=>onFinishedRowsChange([...finishedRows,{name:'',rowToken:crypto.randomUUID()}])}><Plus size={15}/>增加成品名</button></div>{finishedRows.map((row,index)=><div className="reference-finished-row" key={row.rowToken}><span>{String(index+1).padStart(2,'0')}</span><label><span>原料成品名</span><input aria-label={`第${index+1}条成品名`} value={row.name} maxLength={160} onChange={event=>onFinishedRowsChange(finishedRows.map((item,i)=>i===index?{...item,name:event.target.value}:item))}/></label><label><span>编号</span><output>{row.code||'保存后生成'}</output></label><button type="button" className="icon-button" aria-label={`删除成品名${index+1}`} onClick={()=>setDeleting(row.rowToken)}><Trash2 size={16}/></button><div className="raw-finished-full-name"><span>原料成品基础信息全名</span><output>{row.name.trim()?fullName(row.name.trim()):'等待填写成品名'}</output></div></div>)}{!finishedRows.length&&<p className="muted">未配置</p>}{deleting&&<MessageConfirm title="请确认操作" hint="确认删除这个原料成品名吗？" confirmLabel="确认" requireReason={false} danger onClose={()=>setDeleting(null)} onConfirm={async()=>{onFinishedRowsChange(finishedRows.filter(row=>row.rowToken!==deleting));setDeleting(null);}}/>}</div>;
  }
  return <div className="reference-lines" data-field={capacity ? 'capacities' : 'rawFinishedNames'}>
    <div className="reference-lines-actions"><button type="button" className="secondary-button" onClick={() => capacity ? write([...lines, '']) : setLines(v => [...v, ''])}><Plus size={15} />{capacity ? '增加容量' : '增加成品名'}</button></div>
    {lines.map((line, index) => {
      const parsed = productCapacity(line), qty = parsed.quantityText, unit = parsed.unit;
      return <div className="reference-line" key={index}><span>{String(index + 1).padStart(2, '0')}</span>{capacity ? <><label><span className="reference-line-label">容量 <b className="req">必填</b></span><input aria-label={`第${index + 1}条容量`} type="number" min="0" step="any" placeholder="请输入容量" value={qty} onChange={e => write(lines.map((v, i) => i === index ? productCapacityText(e.target.value, unit) : v))} /></label><label><span className="reference-line-label">单位 <b className="req">必填</b><ManageLink field={unitField} inPlace onChoose={chosen => write(lines.map((v, i) => i === index ? productCapacityText(qty, String(chosen ?? '')) : v))} /></span><select aria-label={`第${index + 1}条容量单位`} value={unit} onChange={e => write(lines.map((v, i) => i === index ? productCapacityText(qty, e.target.value) : v))}><option value="">请选择单位</option>{unit && !options.some(o => o.value === unit) && <option value={unit}>{unit}</option>}{options.map(o => <option key={o.value} value={o.value}>{o.label}（{o.value}）</option>)}</select></label></> : <label>成品名<input aria-label={`第${index + 1}条成品名`} maxLength={160} value={line} onChange={e => write(lines.map((v, i) => i === index ? e.target.value : v))} placeholder="请输入原料对应的成品名" /></label>}<button type="button" className="link-button danger" aria-label={`删除第${index + 1}条${capacity ? '容量' : '成品名'}`} disabled={capacity && lines.length <= 1} onClick={() => write(lines.filter((_, i) => i !== index))}><Trash2 size={16} /></button></div>;
    })}
    {!lines.length && <div className="reference-lines-empty">{capacity ? '点击“增加容量”维护适用容量。' : '暂无成品名，可按需增加。'}</div>}
  </div>;
}

type FreightHistoryProps={productId?:number;values:Record<string,unknown>;newRecord?:boolean};
export function FreightHistory(props:FreightHistoryProps){const{user}=useAuth();return <FreightHistoryContent key={JSON.stringify([user?.id,user?.companyId,user?.permissions,props.productId])} {...props}/>;}
function FreightHistoryContent({ productId, values,newRecord=false }: FreightHistoryProps) {
  const [open, setOpen] = useState(false), [history, setHistory] = useState<ResourceDto[] | null>(null), [error, setError] = useState('');
  useEffect(() => { if(!open)return;if(!productId){setHistory([]);setError('');return;}setHistory(null);setError(''); let alive = true;
    (async () => { const rows=await loadResourceDirectory('finance-product-freight-history',()=>alive,undefined,{includeInactive:true,scopedQuery:{fieldKey:'productId',fieldValue:productId}});if(alive&&rows)setHistory(rows.sort((a,b)=>String(b.data.recordedAtKey||b.createdAt).localeCompare(String(a.data.recordedAtKey||a.createdAt))||b.id-a.id)); })().catch(e => alive && setError(e instanceof Error ? e.message : '历史读取失败'));
    return () => { alive = false; };
  }, [open, productId]);
  const number = (k: string) => values[k] === '' || values[k] == null || !Number.isFinite(Number(values[k])) ? null : Number(values[k]);
  const f = number('freight'), h = number('handlingFee'), p = number('purchasePrice');
  const money=(value:number|null)=>{if(value===null&&!newRecord)return '待补齐';return productReferenceCostText(value??0,LOGISTICS_CENT_SCALE);};
  return <div className="reference-logistics s12"><div><small>运费装卸费汇总</small><strong>{money(f===null||h===null?null:sumUnitCents([f,h],LOGISTICS_CENT_SCALE))}</strong></div><div><small>关联系统规格</small><strong>{String(values.purchaseSpec || '—')}</strong></div><div><small>关联采购价</small><strong>{money(p)}</strong></div><button type="button" className="secondary-button" aria-expanded={open} onClick={() => setOpen(v => !v)}>历史运费装卸费</button><p>手工修改运费、装卸费、系统规格或采购价时，保存后都会生成新的历史记录。</p>{open && <div className="reference-history">{error ? <p role="alert">{error}</p> : history === null ? '读取中…' : !history.length ? '暂无历史记录' : history.map(row=>{const d=row.data,read=(key:string)=>d[key]==null||d[key]===''||!Number.isFinite(Number(d[key]))?null:Number(d[key]),f=read('freight'),h=read('handlingFee'),price=read('purchasePrice'),text=(value:number|null)=>value===null?'未维护':productReferenceCostText(value,LOGISTICS_CENT_SCALE),sourceLabels:Record<string,string>={manual:'人工录入',purchase_order:'采购单计算',finance_document:'财务单据计算',system_calculation:'系统自动计算',import:'数据导入'};return <div className="reference-freight-history-row" key={row.id}><strong>{text(f===null||h===null?null:sumUnitCents([f,h],LOGISTICS_CENT_SCALE))}</strong>{[['运费',text(f)],['装卸费',text(h)],['系统规格',String(d.systemSpec||'未维护')],['采购价',text(price)],['来源',sourceLabels[String(d.sourceType)]||String(d.sourceType||'人工录入')],['记录人与时间',`${String(d.operatorName||'未记录操作人')} · ${formatOaDateTime(d.recordedAtKey||row.createdAt,{empty:'未记录时间'})}`]].map(([label,value])=><span key={label}><small>{label}</small>{value}</span>)}</div>;})}</div>}</div>;
}

/** 草稿核算结果只读；缺少报价时明确显示待补齐，不把缺失成本算成0。 */
/** 表单只暂存附件ID，归属仍随当前主档版本一起保存。 */
export function ProductFormPhotos({field,ids,known,name,onChange,onKnown}:{field:FieldDef;ids:number[];known:Record<number,FileInfo>;name:string;onChange:(ids:number[])=>void;onKnown:(file:FileInfo)=>void}){
 const zone=useRef<HTMLDivElement>(null);
 const choose=()=>zone.current?.querySelector<HTMLInputElement>('input[type=file]')?.click();
 const phone=()=>[...zone.current?.querySelectorAll<HTMLButtonElement>('.files-input>button')??[]].find(button=>button.textContent==='手机上传')?.click();
 return <div className="product-archive-photos s12" ref={zone} onDragOver={event=>event.preventDefault()} onDrop={event=>{event.preventDefault();const input=zone.current?.querySelector<HTMLInputElement>('input[type=file]');if(input&&event.dataTransfer.files.length){input.files=event.dataTransfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));}}}><div className="product-photo-scope"><span>图片归属当前商品档案：{name||'未命名商品'}</span><b>{ids.length} / {field.maxFiles??20} 张</b></div><p className="product-photo-drop-copy"><strong>拖入图片，或选择上传</strong><span>支持多张图片 · 最多 {field.maxFiles??20} 张</span></p><div className="product-photo-actions"><button type="button" disabled={ids.length>=(field.maxFiles??20)} onClick={choose}>选择图片</button><button type="button" disabled={ids.length>=(field.maxFiles??20)} onClick={phone}>手机扫码</button></div><FilesInput field={field} type="finance-products" value={ids} known={known} onChange={onChange} onKnown={onKnown}/>{!ids.length&&<p className="product-photo-empty">还没有图片</p>}</div>;
}
export interface ProductCompositionFacts {cost:number|null;weightG:number|null;groups:Record<string,{cost:number|null;weightG:number;purchaseCost?:number|null}>;componentFreight?:number|null;componentHandling?:number|null;complete?:boolean}
export function ProductCompositionFormula({facts,kind,preview=false,values}:{facts:ProductCompositionFacts;kind:'weight'|'price';preview?:boolean;values?:Record<string,unknown>}){
 const group=(key:string)=>facts.groups[key]??{cost:0,weightG:0,purchaseCost:0},raw=group('raw'),pack=[group('package'),group('oem_package')];
 const sum=(values:Array<number|null|undefined>)=>values.some(value=>value==null)?null:sumUnitCents(values as number[],LOGISTICS_CENT_SCALE);
 const oem=values?.supplyMode==='supplier_oem',net=oem?specificationWeightG(values?.specQty,values?.specUnit):null,rawPrice=values?.purchasePrice==null||values?.purchasePrice===''?preview?0:null:Number.isFinite(Number(values?.purchasePrice))?Number(values?.purchasePrice):null;
 const packageWeight=facts.weightG===null&&Object.keys(facts.groups).length?null:pack.reduce((total,row)=>total+row.weightG,0)+Number(values?.oemPackageWeightG||0),packageCost=facts.cost??(preview&&!Object.keys(facts.groups).length?0:null);
 const parts:Array<[string,number|null]>=oem?kind==='weight'?[['商品净重',net],['包装重量',packageWeight],['称重重量',net===null||packageWeight===null?null:net+packageWeight]]:[['原料采购价',rawPrice],['包装费用',packageCost],['总采购价',sum([rawPrice,packageCost])]]:kind==='weight'?[['原料重量',raw.weightG],['包装重量',pack.reduce((sum,row)=>sum+row.weightG,0)],['总重量',facts.weightG??(preview?0:null)]]:[['原料成本',raw.purchaseCost??null],['包装成本',sum(pack.map(row=>row.purchaseCost))],['运费装卸费',sum([facts.componentFreight,facts.componentHandling])],['人工成本',group('labor').purchaseCost??group('labor').cost],['总采购价',facts.cost??(preview?0:null)]];
 return <div className={`reference-source-formula is-${kind}${oem?' is-oem':''}`} aria-label={kind==='weight'?oem?'称重重量组成':'自产成品重量组成':oem?'总采购价计算公式':'自产成品总采购价计算公式'}>{parts.map(([label,value],index)=><Fragment key={label}>{index>0&&<i>{index===parts.length-1?'=':'+'}</i>}<span className={index===parts.length-1?'is-total':''}><small>{label}</small><b>{value===null?'待补齐':kind==='weight'?`${Number((value/1000).toFixed(6))} kg`:productReferenceCostText(value,LOGISTICS_CENT_SCALE)}</b></span></Fragment>)}</div>;
}
export function CompositionResult({facts,values,canCost,source=false,preview=false}:{facts:ProductCompositionFacts;values:Record<string,unknown>;canCost:boolean;source?:boolean;preview?:boolean}) {
  const g=(key:string)=>facts.groups[key]??{cost:0,weightG:0,purchaseCost:0};
  const packaging=[g('package'),g('oem_package')];
  const packagingCost=packaging.some(p=>p.cost===null)?null:sumUnitCents(packaging.map(p=>p.cost!),LOGISTICS_CENT_SCALE);
  const read=(key:string)=>values[key]==null||values[key]===''||!Number.isFinite(Number(values[key]))?null:Number(values[key]);
  const oem=values.supplyMode==='supplier_oem';
  const rawPrice=read('purchasePrice');
  const componentCost=oem&&Object.keys(facts.groups).length===0&&facts.complete!==false?0:facts.cost??(preview?0:null);
  const rawWeight=oem?specificationWeightG(values.specQty,values.specUnit):g('raw').weightG;
  const combinedWeight=oem?(rawWeight??0)+packaging.reduce((s,p)=>s+p.weightG,0)+Number(values.oemPackageWeightG||0):facts.weightG??(preview?0:null);
  const totalWeight=values.weightManual===true&&values.weightG!=null?Number(values.weightG):combinedWeight;
  const componentLogistics=facts.componentFreight==null||facts.componentHandling==null?null:sumUnitCents([facts.componentFreight,facts.componentHandling],LOGISTICS_CENT_SCALE);
  const packagePurchase=packaging.some(part=>part.purchaseCost==null)?null:sumUnitCents(packaging.map(part=>part.purchaseCost!),LOGISTICS_CENT_SCALE);
  const parts=oem?[{name:'原料采购价',cost:rawPrice,weight:rawWeight},{name:'包装费用',cost:packagingCost,weight:packaging.reduce((s,p)=>s+p.weightG,0)},{name:'总采购价',cost:componentCost===null||rawPrice===null?null:sumUnitCents([componentCost,rawPrice],LOGISTICS_CENT_SCALE),weight:totalWeight}]:[{name:'原料',cost:g('raw').purchaseCost??null,weight:rawWeight},{name:'包装',cost:packagePurchase,weight:packaging.reduce((s,p)=>s+p.weightG,0)},{name:'运费装卸费',cost:componentLogistics,weight:null},{name:'人工',cost:g('labor').purchaseCost??g('labor').cost,weight:null},{name:'成品汇总',cost:componentCost,weight:totalWeight}];
  return <div aria-label={source?'自产成品成本与重量实时汇总':undefined} className={`reference-result-strip${source?' is-source-settlement':''}`}>{parts.map((part,i)=><Fragment key={part.name}>{source&&i>0&&<i>{i===parts.length-1?'=':'+'}</i>}<div className={i===parts.length-1?'is-total':''}><small>{part.name}</small>{canCost&&<strong>{part.cost===null?'待补齐':productReferenceCostText(part.cost,LOGISTICS_CENT_SCALE)}</strong>}<span>{source&&part.name==='运费装卸费'?`运费 ${facts.componentFreight==null?'待补齐':productReferenceCostText(facts.componentFreight,LOGISTICS_CENT_SCALE)} · 装卸 ${facts.componentHandling==null?'待补齐':productReferenceCostText(facts.componentHandling,LOGISTICS_CENT_SCALE)}`:part.weight===null?part.name==='人工'?'不计重量':'—':`${Math.round(part.weight/1000*1e9)/1e9} kg`}</span></div></Fragment>)}</div>;
}
