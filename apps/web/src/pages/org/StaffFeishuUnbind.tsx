import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { orgApi, type StaffDto, type StaffFeishuUnbindPlan, type StaffFeishuUnbindResult } from './orgApi';

export function StaffFeishuUnbindDialog({staff,onClose,onDone}:{staff:StaffDto;onClose:()=>void;onDone:()=>Promise<void>}) {
  const {refresh}=useAuth();
  const [plan,setPlan]=useState<StaffFeishuUnbindPlan|null>(null),[result,setResult]=useState<StaffFeishuUnbindResult|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  async function preview() {
    setPlan(null);setError('');setBusy(true);
    try {setPlan(await orgApi.staffFeishuUnbindPreview(staff.id));}
    catch(e){setError(e instanceof ApiError?e.message:'读取失败，请稍后重试');}
    finally{setBusy(false);}
  }
  useEffect(()=>{void preview();},[staff.id]);
  async function unbind() {
    if(!plan||!plan.bindingCount||busy)return;
    setBusy(true);setError('');
    try {setResult(await orgApi.staffFeishuUnbind(staff.id,plan.fingerprint));}
    catch(e){setPlan(null);setError(e instanceof ApiError?e.message:'请求结果暂未确认，请刷新绑定状态核对');}
    finally{setBusy(false);}
  }
  async function done() {
    setBusy(true);setError('');
    try {if(result?.includesSelf)await refresh();await onDone();}
    catch {setError('刷新失败，请重新进入人员管理核对绑定状态');setBusy(false);}
  }
  return <div className="modal-backdrop" role="presentation"><section className="modal card small" role="dialog" aria-modal="true" aria-label="解绑员工飞书">
    <div className="modal-head"><strong>解绑飞书 · {staff.name}</strong></div>
    <div className="modal-body">
      {result?<div role="status"><p>已解绑 {staff.name} 的飞书账号。</p><p>员工可使用 OA 账号密码登录，在飞书绑定页面重新授权本人企业飞书。</p></div>:plan?<>
        <p>员工：<strong>{plan.name}</strong>（OA 账号：{plan.account}）</p>
        {plan.bindingCount?<><p>将移除该员工的 {plan.bindingCount} 条飞书关联，并使其尚未完成的绑定授权失效。</p>
          <p>解绑后，该员工无法通过原飞书账号登录或接收 OA 飞书通知，重新绑定后恢复。员工档案、岗位、工资和业务记录全部保留。</p>
          {plan.includesSelf&&<p className="notice">这是你当前使用的账号，解绑后你也需要重新绑定本人飞书。</p>}
        </>:<p role="status">该员工没有已绑定的飞书账号，无需解绑。</p>}
      </>:<p>{busy?'正在读取绑定状态…':'请刷新绑定状态后再操作。'}</p>}
      {error&&<p className="notice error" role="alert">{error}</p>}
    </div>
    <div className="modal-foot">
      {result?<button type="button" className="primary-button" disabled={busy} onClick={()=>void done()}>完成并刷新</button>:<>
        <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
        {!plan?<button type="button" className="secondary-button" disabled={busy} onClick={()=>void preview()}>刷新绑定状态</button>:!!plan.bindingCount&&<button type="button" className="primary-button danger-fill" disabled={busy} onClick={()=>void unbind()}>{busy?'正在解绑…':'确认解绑此员工'}</button>}
      </>}
    </div>
  </section></div>;
}
