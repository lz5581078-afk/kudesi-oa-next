import {useEffect,useRef,useState} from 'react';
import {useAuth} from '../../auth/AuthContext';
import {ApiError} from '../../api/client';
import {Link} from 'react-router-dom';
import {Plus,RefreshCw,ClipboardList,Package,ShieldCheck,CheckCircle2,ChevronRight,Settings2,X} from 'lucide-react';
import {SkuDraftCreateDialog} from './SkuDraftCreateDialog';
import {RunsPage} from './RunsPage';
import {SkuBatchPanel} from './SkuBatchPanel';
import {SKU_TEMPLATE} from './SkuApply';
import {flowApi,type ApplicationDraftTemplate} from './flowApi';
import './skuApplicationCenter.css';

/** 商品组合编码的申请入口，先显示自己的真实申请，再显式发起。 */
export function SkuApplicationCenter({onClose,initialQuery}:{onClose:()=>void;initialQuery?:string}){
 const {user}=useAuth();
 const identity=JSON.stringify([user?.companyId,user?.id,user?.permissions.isCompanyAdmin,[...(user?.permissions.allow??[])].sort(),[...(user?.permissions.deny??[])].sort()]);
 return <SkuApplicationWorkspace key={identity} onClose={onClose} initialQuery={initialQuery}/>;
}
function SkuApplicationWorkspace({onClose,initialQuery}:{onClose:()=>void;initialQuery?:string}){
 const {can}=useAuth();
 const host=useRef<HTMLElement>(null);
 const [templates,setTemplates]=useState<ApplicationDraftTemplate[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[creating,setCreating]=useState(!!initialQuery),[revision,setRevision]=useState(0),[batch,setBatch]=useState<string|null>(null);
 useEffect(()=>{let alive=true;flowApi.applicationDraftTemplates(SKU_TEMPLATE).then(out=>{if(alive){setTemplates(out.templates.filter(template=>template.status==='active'||template.status==='draft'));setError('');}}).catch(e=>{if(alive)setError(e instanceof ApiError?e.message:'申请模板加载失败');}).finally(()=>{if(alive)setLoading(false);});return()=>{alive=false;};},[revision]);
 const showCreate = creating && templates.length > 0;
 useEffect(()=>{const close=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!event.defaultPrevented&&!showCreate&&!batch&&!host.current?.querySelector('[role="dialog"]')){event.preventDefault();onClose();}};window.addEventListener('keydown',close);return()=>window.removeEventListener('keydown',close);},[showCreate,batch,onClose]);
 if(showCreate)return <SkuDraftCreateDialog templates={templates} initialQuery={initialQuery} onClose={initialQuery ? onClose : ()=>setCreating(false)} onHistory={()=>{setCreating(false);setLoading(true);setRevision(value=>value+1);}} onCreated={ref=>{setCreating(false);setRevision(value=>value+1);setBatch(ref);}}/>;
 if(batch)return <SkuBatchPanel sourceLayout key={batch} batchKey={batch} onClose={onClose} onBack={()=>{setBatch(null);setRevision(value=>value+1);}} onChanged={()=>setRevision(value=>value+1)}/>;
 return <div className="modal-backdrop sku-application-backdrop" role="presentation"><section ref={host} className="modal card sku-application-center" role="dialog" aria-modal="true" aria-label="SKU批量申请">
  <header className="modal-head between"><h2>SKU批量申请</h2><button type="button" className="icon-button" aria-label="关闭SKU批量申请" autoFocus onClick={onClose}><X size={19}/></button></header>
  <div className="modal-body">
   <div className="sku-application-toolbar"><button type="button" className="primary-button" disabled={loading||!can('flow.apply.view')||!templates.length} onClick={()=>setCreating(true)}><Plus size={16}/>新建申请</button><button type="button" aria-label="刷新" disabled={loading} onClick={()=>{setLoading(true);setRevision(value=>value+1);}}><RefreshCw size={16}/></button></div>
   {error&&<div role="alert" className="notice error">{error}</div>}
   {!loading&&!templates.length&&<p className="notice">尚未建立SKU申请模板。{can('flow.templates.view')&&<Link to={`/flow/templates?flow=${SKU_TEMPLATE}`} onClick={onClose}>配置申请流程</Link>}</p>}
   {templates.length>0&&!templates.some(template=>template.status==='active')&&<p className="sku-application-warning">模板未启用，可先保存申请草稿；正式提交前需配置下一节点处理人并启用模板。</p>}
   {templates.map(template=><section className="sku-application-template" key={template.id}><header><strong>{template.label} <span className={`pill ${template.status==='active'?'success':'warn'}`}>{template.status==='active'?'已启用':'未启用'}</span></strong>{can('flow.templates.view')&&<Link className="secondary-button small" to={`/flow/templates?flow=${SKU_TEMPLATE}`} onClick={onClose}><Settings2 size={15}/>配置流程</Link>}</header><ol aria-label="申请办理步骤">{template.steps.map((step,index)=>{const Icon=step.type==='submit'?ClipboardList:step.type==='execute'?Package:step.type==='finance'?ShieldCheck:CheckCircle2;return <li key={step.key}><span>{index+1}</span><div><strong><Icon size={16}/>{step.name}</strong><small>{step.type==='end'?'完成归档':`处理人：${step.handlerName}`}</small></div><ChevronRight size={16} className="sku-application-template-arrow"/></li>;})}</ol>{template.issues.map((issue,index)=><small className="sku-application-warning" key={index}>{issue}</small>)}</section>)}
   <RunsPage view="started" skuApplications hideRefresh reloadToken={revision} onOpenSkuApplication={setBatch}/>
  </div>

 </section></div>;
}
