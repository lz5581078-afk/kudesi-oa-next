import {useEffect,useRef,useState,type DragEvent} from 'react';
import {createChecker,getResourceDef} from '@kudesi/shared';
import {useAuth} from '../auth/AuthContext';
import {useCostIdentityKey} from '../pages/finance/CostIdentityBoundary';
import {resourceApi,type FileInfo,type ResourceDto} from './api';
import {FilesInput,FileList} from './FilesField';
import {ReasonDialog} from './ResourceConfirmDialog';
import './productArchivePhotos.css';
const field=getResourceDef('finance-products')!.fields.find(f=>f.key==='photos')!;
/** Photo maintenance keeps the existing field upload, phone session and version-checked resource save. */
export function ProductArchivePhotos({record,onChanged}:{record:ResourceDto;onChanged?:()=>void}){
 const identity=useCostIdentityKey(),scope=JSON.stringify([identity,record.id]);
 return <PhotoCollector key={scope} record={record} scope={scope} onChanged={onChanged}/>;
}
function PhotoCollector({record,scope,onChanged}:{record:ResourceDto;scope:string;onChanged?:()=>void}){
 const {user}=useAuth(),canEdit=!!user&&createChecker(user.permissions)('resource.finance-products.edit')&&!record.warehouseMode;
 const [ids,setIds]=useState<number[]>(Array.isArray(record.data.photos)?record.data.photos as number[]:[]),[known,setKnown]=useState(record.files),[saving,setSaving]=useState(false),[error,setError]=useState(''),[removal,setRemoval]=useState<number[]|null>(null);
 const current=useRef(record),desired=useRef(ids),working=useRef(false),alive=useRef(true),revision=useRef(0),zone=useRef<HTMLDivElement>(null),done=useRef(onChanged);done.current=onChanged;
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>{if(!working.current&&record.version!==current.current.version){current.current=record;const list=Array.isArray(record.data.photos)?record.data.photos as number[]:[];desired.current=list;setIds(list);setKnown(record.files);}},[record]);
 async function save(){
  if(working.current||!canEdit||!alive.current)return;working.current=true;setSaving(true);setError('');let completed=false;
  try{
   for(;;){const ticket=revision.current,next=[...desired.current],base=current.current;if(!base.version)throw new Error('资料版本缺失，请重新打开后维护照片');
    const result=await resourceApi.gridSave('finance-products',{updates:[{id:base.id,version:base.version,data:{photos:next}}],note:'商品照片'});if(!alive.current)return;
    const row=result.results.find(r=>r.kind==='update'&&r.id===base.id);if(!row?.ok||!row.row)throw new Error(row?.message||'照片保存失败，请重试');current.current=row.row;completed=true;
    if(ticket===revision.current)break;
   }
  }catch(e){if(alive.current)setError(e instanceof Error?e.message:'照片保存失败，请重试');}
  finally{working.current=false;if(alive.current){setSaving(false);if(completed)done.current?.();}}
 }
 function apply(next:number[]){if(!alive.current||!canEdit)return;desired.current=next.slice(0,20);revision.current++;setIds(desired.current);void save();}
 function change(next:number[]){const removed=desired.current.filter(id=>!next.includes(id));if(removed.length){setRemoval(removed);return;}apply(next);}
 function knownFile(file:FileInfo){if(alive.current)setKnown(previous=>({...previous,[file.id]:file}));}
 function choosePhotos(){zone.current?.querySelector<HTMLInputElement>('input[type=file]')?.click();}
 function phonePhotos(){const button=[...zone.current?.querySelectorAll<HTMLButtonElement>('.files-input > button')??[]].find(button=>button.textContent==='手机上传');button?.click();}
 function drop(event:DragEvent){event.preventDefault();if(!canEdit||saving)return;const input=zone.current?.querySelector<HTMLInputElement>('input[type=file]');if(input&&event.dataTransfer.files.length){input.files=event.dataTransfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));}}
 return <div className="product-archive-photos" ref={zone} onDragOver={event=>event.preventDefault()} onDrop={drop}>
  <div className="product-photo-scope"><span>图片归属当前商品档案：{String(record.data.name||record.title||'未命名商品')}</span><b>{ids.length} / 20 张</b></div>
  {canEdit?<><p className="product-photo-drop-copy"><strong>拖入图片，或选择上传</strong><span>支持多张图片 · 最多 20 张</span></p><div className="product-photo-actions"><button type="button" disabled={saving||ids.length>=20} onClick={choosePhotos}>选择图片</button><button type="button" disabled={saving||ids.length>=20} onClick={phonePhotos}>手机扫码</button></div><FilesInput type="finance-products" field={field} value={ids} known={known} onKnown={knownFile} onChange={change}/></>:<FileList ids={ids} files={known}/>}
  {removal&&<ReasonDialog title="删除图片" hint={`删除“${known[removal[0]]?.name||'图片'}”吗？`} requireReason={false} danger confirmLabel="删除" onClose={()=>setRemoval(null)} onConfirm={async()=>{const removing=new Set(removal);setRemoval(null);apply(desired.current.filter(id=>!removing.has(id)));}}/>}
  {!ids.length&&<p className="product-photo-empty">还没有图片</p>}
  {saving&&<p role="status">正在保存图片…</p>}{error&&<p role="alert">{error}<button type="button" disabled={saving} onClick={()=>void save()}>重试</button></p>}
 </div>;
}
