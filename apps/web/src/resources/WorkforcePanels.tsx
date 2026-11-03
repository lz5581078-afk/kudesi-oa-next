import './WorkforcePanels.css';
import { FormEvent, useEffect, useState } from 'react';
import { createChecker, WORKFORCE_EMPLOYMENT_LABELS } from '@kudesi/shared';
import { api, ApiError } from '../api/client';
import { orgApi, flattenDepartments, type DepartmentNode, type PositionDto } from '../pages/org/orgApi';
import { useAuth } from '../auth/AuthContext';

export interface UnfiledPerson { id: number; name: string; account: string | null; employmentType: string; status?: 'active' | 'disabled'; loginPassword?:string; feishuBound?:boolean }
const errText = (e: unknown) => (e instanceof ApiError ? e.message : '操作失败');

/** 新增登录账号并标成兼职/临时工；临时密码只显示一次，随后进入建档表单。 */
export function AddAccountDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (userId: number) => void }) {
  const [account, setAccount] = useState('');
  const [password,setPassword]=useState(''),[confirmPassword,setConfirmPassword]=useState('');
  const [name, setName] = useState('');
  const [employmentType, setEmploymentType] = useState<'part_time' | 'temp'>('part_time');
  const [departmentId, setDepartmentId] = useState<number | null>(null);
  const [positionId, setPositionId] = useState<number | null>(null);
  const [departments, setDepartments] = useState<DepartmentNode[]>([]);
  const [positions, setPositions] = useState<PositionDto[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ id: number; account: string; password: string } | null>(null);
  useEffect(() => {
    orgApi.departments().then(setDepartments).catch(() => undefined);
    orgApi.positions().then(setPositions).catch(() => undefined);
  }, []);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!account.trim() || !name.trim()) return setError('请填写登录账号和姓名');
    if(password&&(password.length<8||new TextEncoder().encode(password).length>72))return setError('密码至少8位，且不能超过72字节');
    if(password!==confirmPassword)return setError('两次密码不一致');
    setBusy(true);
    setError('');
    try {
      const r = await api<{staff:{id:number;account:string};initialPassword:string}>('/workforce/accounts',{method:'POST',body:{account:account.trim(),name:name.trim(),departmentId,positionId,employmentType,...(password?{password}:{})}});
      setDone({ id: r.staff.id, account: r.staff.account, password: r.initialPassword });
    } catch (err) { setError(errText(err)); }
    setBusy(false);
  }
  if (done) {
    return (
      <div className="modal-backdrop" role="presentation">
        <div className="modal card small" role="dialog" aria-label="临时密码">
          <div className="modal-head"><strong>账号已创建</strong></div>
          <div className="modal-body">
            <p>账号 <strong>{done.account}</strong> 的临时密码如下，<strong>也会向有密码管理权限的人显示在用工列表</strong>，请当面或通过安全渠道告诉本人。首次登录会要求改密码。</p>
            <code className="secret-box" aria-label="临时密码">{done.password}</code>
          </div>
          <div className="modal-foot">
            <button type="button" className="secondary-button" onClick={() => void navigator.clipboard?.writeText(done.password)}>复制</button>
            <button type="button" className="primary-button" onClick={() => onCreated(done.id)}>我已记下，继续建档</button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal card small" role="dialog" aria-label="新增账号并建档" onSubmit={submit}>
        <div className="modal-head"><strong>新增账号并建档</strong></div>
        <div className="modal-body workforce-login-fields">
          <label>登录账号<input value={account} maxLength={64} onChange={(e) => setAccount(e.target.value)} /></label>
          <label>登录密码<input type="password" autoComplete="new-password" value={password} maxLength={72} onChange={e=>setPassword(e.target.value)} placeholder="留空则由系统生成临时密码"/></label>
          <label>确认密码<input type="password" autoComplete="new-password" value={confirmPassword} maxLength={72} onChange={e=>setConfirmPassword(e.target.value)}/></label>
          <label>姓名<input value={name} maxLength={50} onChange={(e) => setName(e.target.value)} /></label>
          <label>用工类型
            <select value={employmentType} onChange={(e) => setEmploymentType(e.target.value as 'part_time' | 'temp')}>
              <option value="part_time">{WORKFORCE_EMPLOYMENT_LABELS.part_time}</option>
              <option value="temp">{WORKFORCE_EMPLOYMENT_LABELS.temp}</option>
            </select>
          </label>
          <label>部门
            <select value={departmentId ?? ''} onChange={(e) => setDepartmentId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">（不选）</option>
              {flattenDepartments(departments).map((d) => <option key={d.id} value={d.id}>{'　'.repeat(d.depth)}{d.name}</option>)}
            </select>
          </label>
          <label>岗位
            <select value={positionId ?? ''} onChange={(e) => setPositionId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">（不选，没有岗位权限）</option>
              {positions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <p className="muted">可自行设置密码，也可留空由系统生成；首次登录需修改密码。</p>
          {error && <div role="alert" className="notice error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="submit" className="primary-button" disabled={busy}>{busy ? '创建中…' : '创建并继续建档'}</button>
        </div>
      </form>
    </div>
  );
}

/** 登录维护直接在兼职与临时工档案中操作，底层用户ID和历史关联保持不变。 */
export function WorkforceAccountNote({recordId,account,onChanged,editable=true}:{recordId:number;account:string;onChanged:()=>void;editable?:boolean}) {
  const {user}=useAuth();
  const can=user?createChecker(user.permissions):()=>false;
  const [open,setOpen]=useState(false);
  return <div className="workforce-login-panel">
    <p className="muted" aria-label="账号与岗位说明">账号、部门、岗位与人员当前资料同步；登录账号和密码可在此设置。</p>
    {editable&&can('resource.workforce.edit')&&can('org.staff.edit')&&<button type="button" className="secondary-button" onClick={()=>setOpen(true)}>设置登录账号和密码</button>}
    {open&&<WorkforceLoginDialog recordId={recordId} currentAccount={account} canPassword={can('org.staff.reset')} onClose={()=>setOpen(false)} onSaved={()=>{setOpen(false);onChanged();}}/>}
  </div>;
}

export function WorkforceLoginDialog({recordId,currentAccount,canPassword,onClose,onSaved}:{recordId:number;currentAccount:string;canPassword:boolean;onClose:()=>void;onSaved:()=>void}) {
  const [account,setAccount]=useState(currentAccount),[password,setPassword]=useState(''),[confirm,setConfirm]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function save(e:FormEvent) {
    e.preventDefault();setError('');
    if(!/^[A-Za-z0-9_.-]{2,64}$/.test(account.trim()))return setError('账号只能用字母、数字、下划线、点和横线，2 到 64 位');
    if(canPassword&&password&&(password.length<8||new TextEncoder().encode(password).length>72))return setError('密码至少8位，且不能超过72字节');
    if(canPassword&&password!==confirm)return setError('两次密码不一致');
    setBusy(true);
    try{await api(recordId<0?`/workforce/users/${-recordId}/login`:`/workforce/${recordId}/login`,{method:'PUT',body:{account:account.trim(),...(canPassword&&password?{password}:{})}});onSaved();}
    catch(e){setError(errText(e));}finally{setBusy(false);}
  }
  return <div className="modal-backdrop" role="presentation"><form className="modal card small" role="dialog" aria-label="设置登录账号和密码" onSubmit={save}>
    <div className="modal-head"><strong>设置登录账号和密码</strong></div>
    <div className="modal-body workforce-login-fields">
      <label>登录账号<input autoComplete="off" value={account} maxLength={64} onChange={e=>setAccount(e.target.value)} required/></label>
      {canPassword?<><label>新密码<input type="password" autoComplete="new-password" value={password} maxLength={72} onChange={e=>setPassword(e.target.value)} placeholder="留空保留原密码"/></label><label>确认新密码<input type="password" autoComplete="new-password" value={confirm} maxLength={72} onChange={e=>setConfirm(e.target.value)}/></label><p className="muted">密码留空保留原密码。设置的新密码会在列表明文显示；本人修改密码后停止显示旧密码。下次登录需修改密码。</p></>:<p className="muted">你可以修改登录账号，设置密码需要重置员工密码权限。</p>}
      {error&&<p role="alert" className="notice error">{error}</p>}
    </div>
    <div className="modal-foot"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy}>{busy?'保存中…':'保存登录设置'}</button></div>
  </form></div>;
}
