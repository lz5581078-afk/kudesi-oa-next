import { useEffect, useState } from 'react';
import { orgApi, type StaffFeishuResetPlan, type StaffFeishuResetResult } from './orgApi';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';

export function StaffFeishuResetDialog({onClose}:{onClose:()=>void}) {
  const { refresh }=useAuth();
  const [plan,setPlan]=useState<StaffFeishuResetPlan|null>(null),[result,setResult]=useState<StaffFeishuResetResult|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[confirmed,setConfirmed]=useState(false),[uncertain,setUncertain]=useState(false);
  async function preview(){setError('');setPlan(null);setConfirmed(false);try{setPlan(await orgApi.staffFeishuResetPreview());}catch(e){setError(e instanceof ApiError?e.message:'读取失败，请稍后重试');}}
  useEffect(()=>{void preview();},[]);
  async function reset(){
    if(!plan||!confirmed||busy||uncertain)return;
    setBusy(true);setError('');
    try {setResult(await orgApi.staffFeishuReset(plan.fingerprint));}
    catch(e){
      setError(e instanceof ApiError?e.message:'请求结果暂未确认，请刷新登录状态核对，请勿重复操作');
      if(e instanceof ApiError&&e.status===409){setPlan(null);setConfirmed(false);}
      else if(!(e instanceof ApiError&&[400,403].includes(e.status)))setUncertain(true);
    } finally{setBusy(false);}
  }
  return <div className="modal-backdrop" role="presentation"><section className="modal card small" role="dialog" aria-label="取消全员飞书关联">
    <div className="modal-head"><strong>取消全员飞书关联</strong></div>
    <div className="modal-body">
      {result?<div role="status"><p>已取消 {result.employeeCount} 人的 {result.bindingCount} 条飞书关联，当前公司剩余关联 {result.remainingBindings} 条。</p><p>原有登录状态也必须重新绑定才能继续使用 OA。重新绑定完成后，会开启本人的 OA 飞书通知；实际推送仍受公司通知总开关控制。</p>{result.includesSelf&&<p>你的关联也已取消，请重新完成本人飞书绑定。</p>}</div>:<>
        {plan?<><p><strong>{plan.companyName}</strong>目前有 {plan.employeeCount} 人、{plan.bindingCount} 条飞书关联。</p>
          <p>本次会取消当前公司全部已有的关联，包含管理员、正式、兼职、临时和已停用人员。其他公司不受影响。</p>
          <p>取消后，员工需先用 OA 账号密码登录，再重新授权本人企业飞书。已登录的人也会被要求重新绑定。</p>
          {plan.includesSelf&&<p className="notice">包含你当前使用的账号，执行后你也需要重新绑定。</p>}
          <details><summary>查看本次涉及的 {plan.employeeCount} 人</summary><p>{plan.employees.map(e=>e.name).join('、')||'无'}</p></details>
          <label><input type="checkbox" checked={confirmed} disabled={busy||uncertain} onChange={e=>setConfirmed(e.target.checked)}/>确认取消以上全部关联，让员工重新绑定</label>
        </>:<p>请读取最新绑定范围后再操作。</p>}
      </>}
      {error&&<p role="alert" className="notice error">{error}</p>}
    </div>
    <div className="modal-foot">
      {result||uncertain?<button type="button" className="primary-button" onClick={()=>void refresh().catch(()=>setError('刷新失败，请重新登录后完成飞书绑定'))}>刷新登录状态并重新绑定</button>:<>
        <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
        {!plan?<button type="button" className="secondary-button" onClick={()=>void preview()}>刷新预览</button>:<button type="button" className="primary-button danger-fill" disabled={busy||!confirmed||!plan.bindingCount} onClick={()=>void reset()}>{busy?'正在取消关联…':'确认取消全员关联'}</button>}
      </>}
    </div>
  </section></div>;
}
