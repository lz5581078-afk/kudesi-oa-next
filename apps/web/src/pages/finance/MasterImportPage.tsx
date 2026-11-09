import {useCallback,useEffect,useState} from 'react';
import {permissionOwner,type ResourceImportProfile} from '@kudesi/shared';
import {useAuth} from '../../auth/AuthContext';
import {ProfileImportPanel} from '../../resources/ProfileImportPanel';
import {resourceApi} from '../../resources/api';
import {MasterResetPage} from './DataToolPages';
import './master-import-reference.css';

export function MasterImportPage(){
  const {user}=useAuth();
  return <MasterImportWorkspace key={JSON.stringify([user?.companyId,user?.id,user?.permissions])}/>;
}
function MasterImportWorkspace(){
  const {can}=useAuth();
  const [importBusy,setImportBusy]=useState(false),[resetBusy,setResetBusy]=useState(false);
  const [profiles,setProfiles]=useState<ResourceImportProfile[]|null>(null),[selected,setSelected]=useState(''),[error,setError]=useState(''),[retry,setRetry]=useState(0),[tick,setTick]=useState(0),[notice,setNotice]=useState('');
  const [actionError,setActionError]=useState('');
  const feedback=useCallback((message:{type:'error'|'success';text:string}|null)=>{setActionError(message?.type==='error'?message.text:'');setNotice(message?.type==='success'?message.text:'');},[]);
  useEffect(()=>{
    let alive=true;setProfiles(null);setError('');
    resourceApi.importProfiles().then(result=>{if(alive)setProfiles(result.profiles);}).catch(e=>{if(alive)setError(e instanceof Error?e.message:'导入类型读取失败');});
    return()=>{alive=false;};
  },[retry]);
  const visible=profiles?.filter(profile=>profile.steps.some(step=>can(`resource.${permissionOwner(step.resource)}.import`)))??[];
  const profile=visible.find(item=>item.id===selected)??visible[0];
  return <div className="master-data-import-page">
    <header className="mdi-page-title"><h1>商品基础数据导入</h1></header>
    {actionError&&<div role="alert" className="mdi-message error">{actionError}</div>}
    {notice&&<div role="status" className="mdi-message success">{notice}</div>}
    {error?<div role="alert" className="mdi-message error">{error}<button type="button" onClick={()=>setRetry(value=>value+1)}>重试</button></div>:profile?<ProfileImportPanel key={`${profile.id}:${tick}`} profile={profile} blocked={resetBusy} onBusyChange={setImportBusy} onFeedback={feedback} headerControl={<label><span>导入类型</span><select aria-label="导入类型" value={profile.id} onChange={event=>{setSelected(event.target.value);feedback(null);}}>{visible.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></label>} onDone={message=>{setActionError('');setNotice(message);setTick(value=>value+1);}}/>:<p className="muted">{profiles===null?'正在读取导入类型…':'当前账号没有资料导入权限。'}</p>}
    {can('finance.master-reset.view')&&<MasterResetPage embedded presentation="master" blocked={importBusy} onBusyChange={setResetBusy} onFeedback={feedback}/>}
  </div>;
}
