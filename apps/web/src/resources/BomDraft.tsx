import {withSourceQualityKey} from './sourceQualityRows';
import { useEffect, useState } from 'react';
import {Plus,Trash2} from 'lucide-react';
import { COMPOSITION_GROUP_LABEL, getResourceDef, sumUnitCents, multiplyUnitCents, sumUnitCentsProducts, LOGISTICS_CENT_SCALE, type ResourceFormCollection, type CompositionGroup } from '@kudesi/shared';
import { resourceApi, type ResourceDto } from './api';
import {loadResourceDirectory} from './resourceDirectory';
import { RefSelect } from './RecordForm';
import { FieldHint } from './FieldHint';
import { FinanceCompositionPicker, formatCompositionCost, loadFinanceCompositionCatalog } from './FinanceCompositionPicker';
import {useAuth} from '../auth/AuthContext';
import {referenceIdentity} from './referenceOptionsCache';
import {unitOptionLabel,useUnitOptions} from './unitOptions';
import {productionProductLabel} from './productionProductLabel';
import './referenceProductionBom.css';

/**
 * 商品档案表单里的“生产组成”：自产成品（原料 / 产品包装 / OEM 包装 / 人工）和供应商 OEM 成品（OEM 包装）。
 * 新增和编辑是同一个组件：编辑时读出已有的构成行，与主档在同一事务内对改过的行做增、改、删；也能在详情“构成（BOM）”页签里单独改。
 */
export interface BomDraftRow { qualityKey?:string; kind: 'component' | 'labor'; group: CompositionGroup; id: number | null; qty: number | ''; loss: number | ''; rowId?: number; version?: string;importedLabor?:{name:string;unitCost:number|null;sourceRowId:number;version:string} }

const LABOR = { key: 'laborId', label: '人工项目', type: 'ref', group: '基础', ref: 'finance-labor-costs' } as const;

export const blankBomRow = (group: CompositionGroup): BomDraftRow => withSourceQualityKey({ kind: group === 'labor' ? 'labor' as const : 'component' as const, group, id: null, qty: '' as const, loss: '' as const });
export function validBomRows(rows: BomDraftRow[]) { return rows.filter((r) => (r.id||r.importedLabor&&Number.isSafeInteger(r.importedLabor.sourceRowId)&&r.importedLabor.version) && Number(r.qty) > 0); }

/** 读出一个商品已有的构成行；组件所属的组按组件的档案类型归类 */
export async function loadBomRows(productId: number,current:()=>boolean=()=>true): Promise<BomDraftRow[]> {
  const items=await loadResourceDirectory('finance-product-boms',current,undefined,{includeInactive:true,preserveOrder:true,scopedQuery:{fieldKey:'productId',fieldValue:productId}});
  if(!items||!current())return [];
  const types=new Map<number,string>();
  await Promise.all([...new Set(items.map(row=>row.data.componentId).filter((id):id is number=>typeof id==='number'))].map(async id=>{
    if(!current())return;const item=await resourceApi.get('finance-products',id);if(!current())return;
    if(!['raw','package','oem_package'].includes(String(item.data.archiveType)))throw new Error('组成档案类型不可识别，请核对后再保存');types.set(id,String(item.data.archiveType));
  }));
  if(!current())return [];
  return items.map(row=>bomDraftRowFromRecord(row,types.get(Number(row.data.componentId))));
}

/** 已读真实明细→同一编辑/只读模型；不查目录、不为原文件人工造ID。 */
export function bomDraftRowFromRecord(row:ResourceDto,componentArchiveType?:unknown):BomDraftRow{
if(row.data.importLineKind==='labor'){if(row.data.componentId!=null||row.data.laborId!=null||!String(row.data.importLaborName||'').trim()||!row.version)throw new Error('原文件人工来源不完整，请重新读取');return withSourceQualityKey({kind:'labor' as const,group:'labor' as const,id:null,qty:Number(row.data.qty??1),loss:'' as const,rowId:row.id,version:row.version,importedLabor:{name:String(row.data.importLaborName),unitCost:typeof row.data.importLaborCost==='number'&&Number.isFinite(row.data.importLaborCost)?row.data.importLaborCost:null,sourceRowId:row.id,version:row.version}});}const laborId=typeof row.data.laborId==='number'?row.data.laborId:null,componentId=typeof row.data.componentId==='number'?row.data.componentId:null;
    if((laborId===null)===(componentId===null))throw new Error('组成引用不完整，请核对原明细后再保存');
    const group:CompositionGroup=laborId?'labor':componentArchiveType as CompositionGroup;
    if(!laborId&&!['raw','package','oem_package'].includes(String(componentArchiveType)))throw new Error('组成档案未读取完整，请重新读取');
    return withSourceQualityKey({kind:laborId?'labor' as const:'component' as const,group,id:laborId??componentId,qty:Number(row.data.qty??1),loss:row.data.lossPercent==null||row.data.lossPercent===''?'':Number(row.data.lossPercent),rowId:row.id,version:row.version});
}

export function bomCollection(rows: BomDraftRow[], original: BomDraftRow[]): ResourceFormCollection {
  if (rows.some(row => !row.id&&!(row.kind==='labor'&&row.group==='labor'&&row.importedLabor&&Number.isSafeInteger(row.importedLabor.sourceRowId)&&row.importedLabor.sourceRowId>0&&row.importedLabor.version) || !Number.isFinite(Number(row.qty)) || !(Number(row.qty) > 0))) throw new Error('原料、包装和人工明细必须选择档案，并填写大于 0 的倍数');
  return { type: 'finance-product-boms', expected: original.filter(r => r.rowId).map(r => ({ id: r.rowId!, version: r.version ?? '' })), rows: validBomRows(rows).map(r => ({ ...(r.rowId ? { id: r.rowId } : {}), values: r.importedLabor?{qty:Number(r.qty),...(!r.rowId?{__sourceImportedLaborCopy:{rowId:r.importedLabor.sourceRowId,version:r.importedLabor.version}}:{})}:{ ...(r.kind === 'labor' ? { laborId: r.id, componentId: null } : { componentId: r.id, laborId: null }), qty: Number(r.qty), lossPercent: r.loss === '' ? 0 : Number(r.loss) } })) };
}

/** 按档案类型挑组件：原料、产品包装、OEM 包装各自只列自己那一类（先取前 200 条，可输入关键字缩小） */
function ComponentSelect({ archiveType, value, onChange }: { archiveType: string; value: number | null; onChange: (v: number | null) => void }) {
  const [keyword, setKeyword] = useState('');
  const [items, setItems] = useState<Array<{ id: number; title: string }>>([]);
  const [labelNow, setLabelNow] = useState('');
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => { resourceApi.list('finance-products', { tab: archiveType, pageSize: 200, keyword: keyword.trim() || undefined }).then((r) => alive && setItems(r.items.map((i) => ({ id: i.id, title: i.title })))).catch(() => alive && setItems([])); }, keyword ? 250 : 0);
    return () => { alive = false; clearTimeout(t); };
  }, [archiveType, keyword]);
  useEffect(() => { if (value && !items.some((i) => i.id === value)) resourceApi.get('finance-products', value).then((r) => setLabelNow(r.title)).catch(() => setLabelNow(`#${value}`)); }, [value, items]);
  return (
    <>
      <input type="search" className="ref-search" aria-label="搜索组件" placeholder="输入名称或编码搜索…" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
      <select aria-label="组件" value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
        <option value="">（请选择）</option>
        {value && !items.some((i) => i.id === value) && <option value={value}>{labelNow || `#${value}`}</option>}
        {items.map((i) => <option key={i.id} value={i.id}>{i.title}</option>)}
      </select>
    </>
  );
}

export function BomDraft({ rows, onChange, groups = ['raw', 'package', 'oem_package', 'labor'], required, error, reference = false, records, canCost = true, readOnly=false }: { rows: BomDraftRow[]; onChange: (r: BomDraftRow[]) => void; groups?: readonly CompositionGroup[]; required?: boolean; error?: string; reference?: boolean; records?: Map<string,ResourceDto>; canCost?: boolean;readOnly?:boolean }) {
  const set = (i: number, patch: Partial<BomDraftRow>) => onChange(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const choose = (i: number, id: number | null) => set(i, { id, qty: id && !(Number(rows[i].qty) > 0) ? 1 : rows[i].qty });
  if (reference) return <ReferenceBomDraft rows={rows} onChange={onChange} groups={groups} error={error} records={records} canCost={canCost} readOnly={readOnly}/>;
  return (
    <div className="rf-rows" data-field="composition">
      {groups.map((g) => {
        const meta = COMPOSITION_GROUP_LABEL[g];
        const mine = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.group === g);
        return (
          <fieldset key={g} className="form-group rf-rowgroup" aria-label={meta.title}>
            <div className="rf-rg-head"><strong>{meta.title}</strong><FieldHint text={meta.hint} /><button type="button" className="secondary-button small" onClick={() => onChange([...rows, blankBomRow(g)])}>＋ 添加{meta.title}</button></div>
            {mine.length > 0 && (
              <table className="data-table cards-narrow">
                <thead><tr><th>{meta.pick}</th><th>数量</th><th>损耗率(%)</th><th /></tr></thead>
                <tbody>
                  {mine.map(({ r, i }) => (
                    <tr key={i}>
                      <td data-label={meta.pick}>{g === 'labor' ? <RefSelect field={{ ...LABOR }} value={r.id} onChange={(v) => choose(i, v)} /> : <ComponentSelect archiveType={meta.archiveType!} value={r.id} onChange={(v) => choose(i, v)} />}</td>
                      <td data-label="数量"><input aria-label="组成数量" type="number" min={0} step="any" value={r.qty} onChange={(e) => set(i, { qty: e.target.value === '' ? '' : Number(e.target.value) })} /></td>
                      <td data-label="损耗率"><input aria-label="组成损耗率" type="number" min={0} step="any" value={r.loss} onChange={(e) => set(i, { loss: e.target.value === '' ? '' : Number(e.target.value) })} /></td>
                      <td><button type="button" className="link-button" onClick={() => onChange(rows.filter((_, k) => k !== i))}>去掉</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </fieldset>
        );
      })}
            {error && <small className="field-error" role="alert">{error}</small>}
    </div>
  );
}

interface ReferenceBomProps {rows:BomDraftRow[];onChange:(rows:BomDraftRow[])=>void;groups:readonly CompositionGroup[];error?:string;records?:Map<string,ResourceDto>;canCost:boolean;readOnly:boolean}
function ReferenceBomDraft({rows,onChange,groups,error,records,canCost,readOnly}:ReferenceBomProps){
 const {user}=useAuth(),identity=referenceIdentity(user);useUnitOptions();
 const [labor,setLabor]=useState<{identity:string;items:ResourceDto[];version?:ResourceDto;loading:boolean;error:string}>({identity:'',items:[],loading:true,error:''});
 const hasLabor=groups.includes('labor');
 useEffect(()=>{if(!hasLabor)return;let alive=true;setLabor({identity,items:[],loading:true,error:''});void loadFinanceCompositionCatalog('labor',()=>alive).then(data=>{if(alive)setLabor({identity,items:data.items,version:data.version,loading:false,error:data.version?'':'当前没有已启用且在有效期内的人力成本版本'});}).catch(error=>{if(alive)setLabor({identity,items:[],loading:false,error:error instanceof Error?error.message:'人工成本资料读取失败'});});return()=>{alive=false;};},[hasLabor,identity]);
 const current=labor.identity===identity?labor:{items:[],version:undefined,loading:true,error:''};
 const set=(i:number,patch:Partial<BomDraftRow>)=>onChange(rows.map((row,index)=>index===i?{...row,...patch}:row));
 const choose=(i:number,id:number)=>set(i,{id,qty:!(Number(rows[i].qty)>0)?1:rows[i].qty,...(rows[i].importedLabor?{kind:'labor',group:'labor',importedLabor:undefined,rowId:undefined,version:undefined,loss:''}:{})});
 const remove=(i:number)=>onChange(rows.filter((_,index)=>index!==i));
 const num=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?v:null;
 const money=(value:number|null)=>value===null?'待补齐':formatCompositionCost(value,LOGISTICS_CENT_SCALE);
 const weight=(value:number|null)=>value===null?'待补齐':String(Number(value.toFixed(6)));
 const weightText=(value:number|null)=>value===null?'待补齐':`${weight(value)} kg`;
 const unit=(record:ResourceDto|undefined)=>{if(!record)return '单位';const field=getResourceDef('finance-products')!.fields.find(f=>f.key==='specUnit')!,code=String(record.data.specUnit||'');return unitOptionLabel(field,record.data,code)||field.options?.find(option=>option.value===code)?.label||code||'单位';};
 const add=(group:CompositionGroup)=>onChange([...rows,blankBomRow(group)]);
 const addButton=(group:CompositionGroup,text:string,disabled=false)=><button type="button" className="reference-production-add" disabled={disabled} onClick={()=>add(group)}><Plus/>{text}</button>;
 const empty=(text:string,isError=false)=><div className={`reference-production-empty${isError?' is-error':''}`}>{text}</div>;
 const isOem=groups.length===1&&groups[0]==='oem_package';
 const renderRows=(group:CompositionGroup)=>{const mine=rows.map((r,i)=>({r,i})).filter(({r})=>r.group===group);return mine.length?mine.map(({r,i})=>{
  const record=records?.get(`${r.kind}:${r.id}`)||(r.kind==='labor'?current.items.find(item=>item.id===r.id):undefined),data=record?.data;
  const qty=Number(r.qty||0),purchase=r.id?num(data?.purchasePrice)??num(data?.latestUnitCost):0,freight=r.id?num(data?.freight):0,handling=r.id?num(data?.handlingFee):0,laborPrice=r.importedLabor?r.importedLabor.unitCost:r.id?num(data?.unitPrice):0;
  const price=r.kind==='labor'?laborPrice:purchase,weightKg=r.id&&num(data?.weightG)===null?null:(num(data?.weightG)??0)/1000,unitName=r.kind==='labor'?record?.refLabels.unitId||String(data?.unitName||'单位'):group==='raw'||group==='oem_package'?String(data?.purchaseSpec||data?.latestCostUnit||unit(record)):unit(record);
  const logistics=freight===null||handling===null?null:sumUnitCents([freight,handling],LOGISTICS_CENT_SCALE),base=price===null?null:isOem||r.kind==='labor'?price:logistics===null?null:sumUnitCents([price,logistics],LOGISTICS_CENT_SCALE);
  const cost=base===null?null:multiplyUnitCents(base,qty,r.kind==='labor'?0:Number(r.loss||0),6,LOGISTICS_CENT_SCALE);
  const label=r.importedLabor?r.importedLabor.name:record?String(r.kind==='labor'?`${data?.workName||record.title} · ${data?.workCode||'无编号'}`:productionProductLabel(record)):r.id?`档案资料未读取 #${r.id}`:'未选择';
  const picker=readOnly?<input className="reference-production-readonly-choice" aria-label={group==='labor'?'人工成本项目':'组成档案'} readOnly value={label}/>:<FinanceCompositionPicker group={group} value={r.id} onChange={id=>choose(i,id)} labelNow={r.importedLabor?r.importedLabor.name:record?String(r.kind==='labor'?`${data?.workName||record.title} · ${data?.workCode||'无编号'}`:productionProductLabel(record)):undefined} categoriesEnabled={!isOem} canCost={canCost}/>;
  const quantity=<label className="reference-production-quantity"><span>{isOem?'个数/用量':'使用倍数'}</span><input aria-label="组成数量" type="number" min="0" step="any" placeholder="1" readOnly={readOnly} value={r.qty} onChange={readOnly?undefined:event=>set(i,{qty:event.target.value===''?'':Number(event.target.value)})}/></label>;
  const del=readOnly?null:<button type="button" className="reference-production-delete" aria-label={isOem?'删除该OEM包装':group==='labor'?'删除该人工成本':'删除该组成'} onClick={()=>remove(i)}><Trash2/><span>删除</span></button>;
  if(isOem)return <div className="reference-oem-composition-row" key={r.rowId??i}><label className="reference-production-picker"><span>包装档案</span>{picker}<small>{record?weightKg===null?'单件包装重量：待补齐':`单件包装重量：${weight(weightKg*(data?.weightUnit==='g'?1000:data?.weightUnit==='jin'?2:1))}${data?.weightUnit==='g'?'克':data?.weightUnit==='jin'?'斤':'千克'}（${weightText(weightKg)}）`:readOnly?'档案资料未读取':'搜索并选择 OEM 包装档案'}</small></label>{quantity}<div className="reference-oem-unit"><span>系统规格</span><output>{unitName==='单位'?'未维护系统规格':unitName}</output></div>{canCost&&<div className="reference-oem-unit is-cost"><span>包装费用</span><output>{money(cost)}</output><small>{money(price)} × {qty}</small></div>}{del}</div>;
  return <div key={r.rowId??i} className={`reference-production-row${group==='labor'?' is-labor':''}`}><div className="reference-production-main"><label className="reference-production-picker"><span>{group==='raw'?'原料档案':group==='package'?'产品包装档案':group==='oem_package'?'OEM包装档案':'人工成本项目'}</span>{picker}<small>{r.importedLabor?'从已启用的人力成本版本中搜索或按分类选择':record?`${record.refLabels[group==='labor'?'archiveCategoryId':'categoryId']||'未分类'} · ${group==='labor'?`当前版本 ${String(current.version?.data.versionCode||'-')}`:String(data?.purchaseSpec||`${data?.specQty||''} ${unit(record)}`)}`:group==='raw'?'直接搜索，或按分类逐级找到原料':group==='labor'?'从已启用的人力成本版本中搜索或按分类选择':'支持直接搜索或按分类选择档案'}</small></label>{del}</div><div className="reference-production-details">{quantity}{canCost&&<div className="reference-production-metric"><span>{group==='labor'?'单位人工成本':'采购价'}</span><strong>{money(price)}</strong><small>/ {unitName}</small></div>}{group==='labor'?<div className="reference-production-metric is-version"><span>成本版本</span><strong>{String(current.version?.data.versionCode||'-')}</strong></div>:<>{canCost&&<div className="reference-production-metric"><span>运费 / 装卸费</span><strong>{money(freight)} / {money(handling)}</strong><small>本项合计 {money(logistics===null?null:multiplyUnitCents(logistics,qty,0,6,LOGISTICS_CENT_SCALE))}</small></div>}<div className="reference-production-metric"><span>{group==='raw'?'每倍重量':'单件重量'}</span><strong>{weightText(weightKg)}</strong><small>{group==='raw'?`/ ${unitName}`:''}</small></div></>}{canCost&&<div className="reference-production-metric is-total"><span>{group==='labor'?'人工小计':'本项成本'}</span><strong>{money(cost)}</strong><small>{group==='labor'?`${qty} 倍`:`重量 ${weightText(weightKg===null?null:weightKg*qty)}`}</small></div>}</div></div>;
 }):group==='raw'?empty('还没有添加原料；请先在原料档案里维护商品，再在这里选择。'):group==='package'?empty('还没有添加包装；请先在产品包装档案里维护商品，再在这里选择。'):group==='oem_package'?empty('还没有添加OEM包装；请先在OEM包装档案里维护商品，再在这里选择。'):empty(current.loading?'正在加载已启用的人力成本版本…':current.error||(current.items.length?'还没有人工成本，请搜索或按分类逐级选择。':'当前版本没有可选择的人工成本项目。'),!!current.error);};
 const visible=groups.filter(group=>group!=='oem_package'||!groups.includes('package'));
 const oemTotal=()=>{let complete=true;const amounts=rows.filter(row=>row.group==='oem_package').map(row=>{const record=records?.get(`component:${row.id}`);const price=num(record?.data.purchasePrice)??num(record?.data.latestUnitCost);if(row.id&&price===null){complete=false;return 0;}return {value:price??0,quantity:Number(row.qty||0)};});return complete?sumUnitCentsProducts(amounts.filter((term):term is {value:number;quantity:number}=>typeof term!=='number'),6,LOGISTICS_CENT_SCALE,4):null;};
 return <div className={`reference-bom reference-production-bom${isOem?' is-oem':''}${readOnly?' is-readonly':''}`} data-field="composition">{visible.map((group,index)=>{
  const combined=group==='package'&&groups.includes('oem_package'),title=isOem?'OEM包装档案':group==='raw'?'原料组成':combined?'包装组成':group==='labor'?'人工组成':'OEM包装组成';
  return <section key={group} id={`rf-bom-${group}`} className="reference-bom-group reference-production-block" aria-label={title}><header><div className="reference-production-heading">{!isOem&&<i>{String(index+1).padStart(2,'0')}</i>}<div><strong>{title}</strong>{!isOem&&<small>{group==='raw'?'支持直接搜索，也可按分类逐级选择原料':combined?'产品包装和 OEM 包装统一计入包装成本与包装重量':group==='labor'?current.version?`当前版本：${String(current.version.data.versionName||current.version.data.versionCode)}`:'需要先启用有效的人力成本版本':''}</small>}</div></div>{!readOnly&&<div className="reference-production-actions">{group==='raw'?addButton('raw','增加原料'):combined?<>{addButton('package','增加产品包装')}{addButton('oem_package','增加OEM包装')}</>:group==='labor'?addButton('labor',current.loading?'加载中':'增加人工',current.loading||!current.items.length):addButton('oem_package','增加OEM包装')}</div>}</header>{combined?<><div className="reference-production-subtitle">产品包装</div>{renderRows('package')}<div className="reference-production-subtitle">OEM包装</div>{renderRows('oem_package')}</>:renderRows(group)}{isOem&&canCost&&<div className="reference-oem-cost-summary"><span>包装费用合计</span><strong>{money(oemTotal())}</strong><small>按各 OEM 包装档案采购价 × 用量自动汇总</small></div>}</section>;
 })}{error&&<small className="field-error" role="alert">{error}</small>}</div>;
}
