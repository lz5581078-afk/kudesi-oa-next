import { useEffect, useRef, useState } from 'react';
import { createChecker } from '@kudesi/shared';
import { Download, Upload } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { PackagingExcelDialog, downloadPackagingSchemeTemplate } from './PackagingExcelDialog';
import { loadResourceDirectory } from './resourceDirectory';
import './productPackagingSchemesSummary.css';

/** 包装档案入口中的方案摘要，导入沿用统一方案工作簿及同事务预检。 */
export function ProductPackagingSchemesSummary({ archiveType, onChanged }: { archiveType:'package'|'oem_package';onChanged?:()=>void }) {
 const {user}=useAuth();
 const can=user?createChecker(user.permissions):()=>false;
 const canView=can('resource.finance-packaging-schemes.view'),canCreate=can('resource.finance-packaging-schemes.create');
 const [revision,setRevision]=useState(0),[file,setFile]=useState<{scope:string;file:File}>(),[downloadError,setDownloadError]=useState('');
 const fileScope=JSON.stringify([user?.companyId,user?.id,user?.permissions,archiveType]);
 useEffect(()=>{setFile(undefined);setDownloadError('');},[fileScope]);
 const scope=JSON.stringify([user?.companyId,user?.id,user?.permissions,archiveType,revision,canView]);
 const [state,setState]=useState<{scope:string;count:number|null;error:string}>({scope:'',count:null,error:''});
 const input=useRef<HTMLInputElement>(null),current=state.scope===scope?state:{count:null,error:''};
 useEffect(()=>{
  if(!canView)return;
  let alive=true;setState({scope,count:null,error:''});
  (async()=>{
   const rows=await loadResourceDirectory('finance-packaging-schemes',()=>alive,undefined,{includeInactive:true});
   if(rows&&alive)setState({scope,count:rows.filter(row=>archiveType==='package'?row.data.usageScene==='dispatch':row.data.usageScene!=='dispatch').length,error:''});
  })().catch(()=>{if(alive)setState({scope,count:null,error:'包装方案读取失败'});});return()=>{alive=false;};
 },[scope,canView,archiveType]);
 return <section className="product-packaging-schemes" aria-label="包装方案维护"><header><h3>包装方案</h3><span>{!canView?'暂无查看权限':current.error?'读取失败':current.count===null?'加载中…':`当前相关方案 ${current.count} 个`}</span></header><div className="product-packaging-scheme-actions"><button type="button" className="secondary-button" onClick={()=>{setDownloadError('');void downloadPackagingSchemeTemplate().catch(()=>setDownloadError('方案模板下载失败，请重试'));}}><Download size={16}/>方案模板</button>{canCreate&&<button type="button" className="primary-button" onClick={()=>input.current?.click()}><Upload size={16}/>导入方案</button>}<input ref={input} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden aria-label="导入包装方案文件" onChange={event=>{const selected=event.target.files?.[0];event.target.value='';if(selected)setFile({scope:fileScope,file:selected});}}/></div><p>{archiveType==='oem_package'?'自产包装和供应商OEM方案引用OEM包装档案；品牌包装形成销售产品成本。':'发货包装方案引用产品包装档案；编织袋、泡沫箱等归发货包装成本。'}</p>{(current.error||downloadError)&&<div role="alert">{current.error||downloadError}{current.error&&<button type="button" onClick={()=>setRevision(value=>value+1)}>重试</button>}</div>}{file?.scope===fileScope&&canCreate&&<PackagingExcelDialog initialFile={file.file} canCreate onClose={()=>setFile(undefined)} onDone={()=>{setFile(undefined);setRevision(value=>value+1);onChanged?.();}}/>}</section>;
}
