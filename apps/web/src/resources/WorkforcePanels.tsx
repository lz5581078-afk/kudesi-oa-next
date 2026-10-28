import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { createChecker, resourcePagePath, WORKFORCE_EMPLOYMENT_LABELS } from '@kudesi/shared';
import { api, ApiError } from '../api/client';
import { orgApi, flattenDepartments, type DepartmentNode, type PositionDto } from '../pages/org/orgApi';
import { useAuth } from '../auth/AuthContext';

export interface UnfiledPerson { id: number; name: string; account: string | null; employmentType: string }
const errText = (e: unknown) => (e instanceof ApiError ? e.message : '操作失败');

/** 已在“人员档案”里标成兼职/临时工、还没有建档的人：不建档就没有合作期，也不会按合作期限制登录。 */
export function UnfiledBanner({ refreshKey, canCreate, onFile }: { refreshKey?: unknown; canCreate: boolean; onFile: (userId: number) => void }) {
  const [list, setList] = useState<UnfiledPerson[]>([]);
  useEffect(() => {
    let alive = true;
    api<UnfiledPerson[]>('/workforce/unfiled').then((r) => alive && setList(r)).catch(() => alive && setList([]));
    return () => { alive = false; };
  }, [refreshKey]);
  if (list.length === 0) return null;
  return (
    <div role="status" className="notice m" aria-label="未建档提醒">
      有 {list.length} 位兼职/临时工还没有建档（没有合作期限和计薪方式）：
      {list.map((p) => (
        <span key={p.id}>
          {' '}{p.name}（{(WORKFORCE_EMPLOYMENT_LABELS as Record<string, string>)[p.employmentType] ?? p.employmentType}）
          {canCreate && <> <button type="button" className="link-button" onClick={() => onFile(p.id)}>建档</button></>}
        </span>
      ))}
    </div>
  );
}

/** 新增登录账号并标成兼职/临时工；临时密码只显示一次，随后进入建档表单。 */
export function AddAccountDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (userId: number) => void }) {
  const [account, setAccount] = useState('');
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
    setBusy(true);
    setError('');
    try {
      const r = await orgApi.addStaff({ account: account.trim(), name: name.trim(), departmentId, positionId, employmentType });
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
            <p>账号 <strong>{done.account}</strong> 的临时密码如下，<strong>只显示这一次</strong>，请当面或通过安全渠道告诉本人。首次登录会要求改密码。</p>
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
        <div className="modal-body">
          <label>登录账号<input value={account} maxLength={64} onChange={(e) => setAccount(e.target.value)} /></label>
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
          <p className="muted">密码由系统生成，创建后只显示一次。</p>
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

/** 详情顶部：账号、部门、岗位是员工当前资料，这里只读；要改去人员档案。 */
export function WorkforceAccountNote() {
  const { user } = useAuth();
  const can = user ? createChecker(user.permissions) : () => false;
  const path = resourcePagePath('employees');
  return (
    <p className="muted" aria-label="账号与岗位说明">
      账号、部门、岗位、直属上级取自员工当前资料，这里不能改。
      {path && can('resource.employees.view') && <> <Link className="link-button" to={path}>到人员档案修改</Link></>}
    </p>
  );
}
