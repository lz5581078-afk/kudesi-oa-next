import {useEffect,useRef,useState,type ReactNode} from 'react';
import {Download,FileSpreadsheet,RefreshCw,Upload} from 'lucide-react';
import type {ResourceImportProfile} from '@kudesi/shared';
import {resourceApi,type ProfileImportResult,type ProfileWorkbookSheet} from './api';
import {downloadWorkbook,readXlsxWorkbook} from './xlsx';

/** 工作簿结构由共享profile提供，预检与执行始终交同一个通用资料导入事务。 */
export function ProfileImportPanel({profile,headerControl,onDone,blocked=false,onBusyChange,onFeedback}:{profile:ResourceImportProfile;headerControl:ReactNode;onDone:(message:string)=>void;blocked?:boolean;onBusyChange?:(busy:boolean)=>void;onFeedback?:(message:{type:'error';text:string}|null)=>void}){
  const fileInput=useRef<HTMLInputElement>(null),alive=useRef(false),serial=useRef(0),working=useRef(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[filename,setFilename]=useState(''),[sheets,setSheets]=useState<ProfileWorkbookSheet[]>([]),[preview,setPreview]=useState<ProfileImportResult|null>(null);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;serial.current++;};},[]);
  useEffect(()=>{onBusyChange?.(busy);return()=>onBusyChange?.(false);},[busy,onBusyChange]);
  async function operation(run:(current:()=>boolean)=>Promise<void>){
    if(working.current||blocked)return;working.current=true;const request=++serial.current,current=()=>alive.current&&serial.current===request;
    setBusy(true);setError('');onFeedback?.(null);
    try{await run(current);}catch(e){if(current()){const text=e instanceof Error?e.message:'处理失败';setError(text);onFeedback?.({type:'error',text});}}finally{if(current()){working.current=false;setBusy(false);}}
  }
  async function choose(file:File|undefined){
    if(!file||working.current||blocked)return;
    setPreview(null);setSheets([]);setFilename('');
    if(!/\.xlsx$/i.test(file.name)){setError('请选择 Excel（.xlsx）工作簿');onFeedback?.({type:'error',text:'请选择 Excel（.xlsx）工作簿'});return;}
    if(file.size>10*1024*1024){setError('文件超过10 MB上限，请拆成多个文件分别导入');onFeedback?.({type:'error',text:'文件超过10 MB上限，请拆成多个文件分别导入'});return;}
    await operation(async current=>{
      const book=await readXlsxWorkbook(file);if(!current())return;
      setFilename(file.name);setSheets(book);
      const result=await resourceApi.importProfile(profile.id,book,true);if(current())setPreview(result);
    });
  }
  async function template(example:boolean){
    await operation(async()=>downloadWorkbook(`${profile.label}-${example?'示例':'模板'}.xlsx`,profile.sheets.map(sheet=>({name:sheet.name,rows:[[...sheet.headers],...(example?sheet.examples.map(row=>sheet.headers.map(header=>row[header]??'')):[])]}))));
  }
  async function commit(){
    if(!preview?.signature||preview.failed||preview.issues.length||!sheets.length)return;
    await operation(async current=>{
      const result=await resourceApi.importProfile(profile.id,sheets,false,preview.signature);if(!current())return;
      if(!result.committed){setPreview(result);return;}
      setPreview(null);setSheets([]);setFilename('');onDone(`导入完成：新增 ${result.mainCreated??result.created}，更新 ${result.mainUpdated??result.updated}${result.detailRows!==undefined?`，明细 ${result.detailRows}`:''}。`);
    });
  }
  const messages=preview?[...preview.issues.map(issue=>({sheet:issue.sheet,line:issue.row,field:issue.field,message:issue.message})),...preview.results.flatMap(row=>row.errors.map(message=>({sheet:row.sheet,line:row.line,field:'',message})))]:[];
  const count=(sheets.find(sheet=>sheet.name===profile.sheets[0]?.name)?.rows??[]).filter(row=>Object.values(row).some(value=>value.trim())).length;
  return <section className="mdi-card" aria-label="分模块 Excel 导入">
    <div className="mdi-card-title"><FileSpreadsheet aria-hidden="true"/><div><h3>分模块 Excel 导入</h3><p>建议严格按分类、字典/单位/平台、档案、基础编码、组合编码的顺序执行。</p></div></div>
    <div className="mdi-toolbar">{headerControl}<button type="button" disabled={busy||blocked} onClick={()=>void template(false)}><Download aria-hidden="true"/>下载模板</button><button type="button" disabled={busy||blocked} onClick={()=>void template(true)}><Download aria-hidden="true"/>下载示例</button><button type="button" className="primary" disabled={busy||blocked} onClick={()=>fileInput.current?.click()}><Upload aria-hidden="true"/>选择 Excel 并预检</button><input ref={fileInput} hidden type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label="选择 Excel 并预检" onChange={event=>{void choose(event.target.files?.[0]);event.target.value='';}}/></div>
    {busy&&<div className="mdi-progress" role="status"><RefreshCw className="spin" aria-hidden="true"/>正在处理，请稍候…</div>}
    {error&&!onFeedback&&<div role="alert" className="mdi-message error">{error}</div>}
    {preview&&<div className={`mdi-preview ${messages.length||preview.failed?'failed':'ready'}`}><div><strong>{filename}</strong><span>数据 {count} 条</span><span>错误 {messages.length} 条</span></div>{messages.length>0&&<div className="mdi-errors">{messages.map((item,index)=><p key={index}><b>{item.sheet||'工作簿'} 第 {item.line||'-'} 行{item.field?` · ${item.field}`:''}</b>：{item.message}</p>)}</div>}<button type="button" className="primary" disabled={busy||blocked||!preview.signature||preview.failed>0||messages.length>0} onClick={()=>void commit()}>确认导入本地系统</button></div>}
  </section>;
}
