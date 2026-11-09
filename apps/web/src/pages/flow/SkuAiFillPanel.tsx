import {useRef,useState} from 'react';
import {Sparkles,X} from 'lucide-react';
import {fillSpecs,type SkuFillResult} from '@kudesi/shared';
import {ApiError,api} from '../../api/client';
import {skuApi} from './SkuApply';
import {SkuProductPicker,type SkuCatalogItem} from './SkuProductPicker';

export interface SkuAiFill{specs:SkuFillResult[];brandId?:number}
const aiParse=(names:string[])=>api<{items:Array<{name:string;mainGrams:number|null;giftGrams:number|null}>}>('/flow/sku-apply/ai-parse',{body:{names}});

/** 规格名称 → AI 读出重量；主商品/赠品按所选商品的重量用代码凑数量；品牌取自所选主商品。结果只预填到申请草稿，由人工在下一步审核。 */
export function SkuAiFillPanel({names,onApply,onClose}:{names:string[];onApply:(fill:SkuAiFill)=>void;onClose:()=>void}){
 const [mains,setMains]=useState<SkuCatalogItem[]>([]),[gifts,setGifts]=useState<SkuCatalogItem[]>([]),[picking,setPicking]=useState<'main'|'gift'|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[fill,setFill]=useState<SkuAiFill|null>(null),run=useRef(0);
 const merge=(list:SkuCatalogItem[],add:SkuCatalogItem[])=>[...new Map([...list,...add].map(item=>[item.id,item])).values()];
 const label=(id:number)=>{const item=[...mains,...gifts].find(row=>row.id===id);return item?`${item.name}${item.spec?`（${item.spec}）`:''}`:`#${id}`;};
 async function start(){
  if(busy||!mains.length)return;const current=++run.current;setBusy(true);setError('');setFill(null);
  try{
   const parsed=await aiParse(names),specs=fillSpecs(parsed.items,mains,gifts);
   let brandId:number|undefined;
   try{const brands=new Set((await skuApi.catalogNames(mains.map(item=>item.id))).items.map(item=>item.brandId??null));brandId=brands.size===1&&[...brands][0]?Number([...brands][0]):undefined;}catch{brandId=undefined;}
   if(current===run.current)setFill({specs,brandId});
  }catch(err){if(current===run.current)setError(err instanceof ApiError?err.message:'AI 填写失败');}
  finally{if(current===run.current)setBusy(false);}
 }
 return <div className="modal-backdrop sku-application-backdrop" role="presentation"><section className="modal card sku-ai-fill" role="dialog" aria-modal="true" aria-label="AI 一键填写">
  <header><h2><Sparkles size={18}/> AI 一键填写</h2><button type="button" aria-label="关闭AI填写" onClick={onClose}><X size={19}/></button></header>
  {error&&<div role="alert" className="notice error">{error}</div>}
  <p className="muted">先选出这次会用到的主商品和赠品。AI 只读规格名称里的重量，数量按所选商品的重量精确凑出；品牌取自所选主商品；凑不出来的留空，下一步由你审核。</p>
  <div className="sku-ai-fill-pick">
   {(['main','gift'] as const).map(role=>{const list=role==='main'?mains:gifts,set=role==='main'?setMains:setGifts;return <section key={role}><header><strong>{role==='main'?'主商品构成':'赠品构成'}</strong><button type="button" onClick={()=>setPicking(role)}>选择{role==='main'?'主商品':'赠品'}</button></header>
    {list.length?<ul>{list.map(item=><li key={item.id}><span>{item.name}<small> {item.spec}</small></span><button type="button" aria-label={`移除 ${item.name}`} onClick={()=>{set(list.filter(row=>row.id!==item.id));setFill(null);}}><X size={14}/></button></li>)}</ul>:<p className="muted">{role==='gift'?'没有赠品可以不选':'未选择'}</p>}</section>;})}
  </div>
  {fill&&<section className="sku-ai-fill-result" aria-label="AI 填写预览">
   <h3>预览（应用后到下一步人工审核）</h3>
   {fill.specs.map((spec,index)=><div key={index} className={spec.warnings.length?'warn':''}><strong>{spec.name}</strong>
    <small>主商品：{spec.main.length?spec.main.map(line=>`${label(line.baseCodeId)} × ${line.qty}`).join('；'):'—'}</small>
    {spec.gift.length>0&&<small>赠品：{spec.gift.map(line=>`${label(line.baseCodeId)} × ${line.qty}`).join('；')}</small>}
    {spec.warnings.map(text=><small key={text} className="sku-ai-fill-warning">需确认：{text}</small>)}</div>)}
   <small>默认品牌：{fill.brandId?'取自所选主商品':'所选主商品没有统一品牌，留空'}</small>
  </section>}
  <footer><button type="button" onClick={onClose}>取消</button><button type="button" disabled={busy||!mains.length} onClick={()=>void start()}>{busy?'AI 填写中…':fill?'重新填写':'开始填写'}</button><button type="button" className="primary-button" disabled={!fill||busy} onClick={()=>fill&&onApply(fill)}>应用到申请</button></footer>
  {picking&&<SkuProductPicker label={picking==='main'?'选择主商品构成':'选择赠品构成'} load={query=>skuApi.catalog(picking,query)} onClose={()=>setPicking(null)} onChoose={rows=>{(picking==='main'?setMains:setGifts)(list=>merge(list,rows));setFill(null);setPicking(null);}}/>}
 </section></div>;
}
