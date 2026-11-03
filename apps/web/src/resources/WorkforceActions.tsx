import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { createChecker } from '@kudesi/shared';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { StaffEditorDialog } from '../pages/org/StaffEditorDialog';
import { StaffRecordsDialog } from '../pages/org/StaffRecordsDialog';
import { orgApi, type StaffDetail, type StaffDto } from '../pages/org/orgApi';
import { resourceApi, type ResourceDto } from './api';
import { ReasonDialog } from './TreeManage';
import './workforceActions.css';

function WorkforceRecords({ userId, canSalary, canHandover, onClose }: { userId: number; canSalary: boolean; canHandover: boolean; onClose: () => void }) {
  const [data, setData] = useState<{ staff: StaffDetail; all: StaffDto[] } | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    setData(null); setError('');
    Promise.all([orgApi.staffOne(userId), canHandover ? orgApi.staff() : Promise.resolve([])])
      .then(([staff, all]) => { if (current) setData({ staff, all }); })
      .catch(e => { if (current) setError(e instanceof ApiError ? e.message : '人员记录加载失败'); });
    return () => { current = false; };
  }, [userId, canHandover, retry]);
  if (data) return <StaffRecordsDialog staff={data.staff} all={data.all} canSalary={canSalary} canHandover={canHandover} onClose={onClose} />;
  return <div className="modal-backdrop"><section className="modal card small" role="dialog" aria-label="人员记录">
    <div className="modal-head"><strong>人员记录</strong></div>
    <div className="modal-body">{error ? <p role="alert">{error}</p> : <p role="status">正在读取人员记录…</p>}</div>
    <div className="modal-foot"><button type="button" onClick={onClose}>关闭</button>{error && <button type="button" onClick={() => setRetry(n => n + 1)}>重试</button>}</div>
  </section></div>;
}

/** 列表、手机卡片和详情共用；档案状态仍由统一资料接口处理，不单独修改员工账号。 */
export function WorkforceActions({ record, onEdit, onLogs, onChanged, employeeAction = false }: {
  record: ResourceDto; onEdit?: (record: ResourceDto) => void; onLogs: () => void; onChanged: () => void; employeeAction?: boolean;
}) {
  const { user } = useAuth();
  const can = createChecker(user?.permissions ?? { isCompanyAdmin: false, allow: [], deny: [] });
  const userId = Number(record.data.userId);
  const hasPerson = Number.isSafeInteger(userId) && userId > 0;
  const [dialog, setDialog] = useState<'records' | 'employee' | 'disable' | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const live = !record.archived;
  const incomplete = record.id <= 0 || record.data.profileIncomplete === true;
  const canEdit = incomplete ? hasPerson && can('org.staff.view') && can('org.staff.edit') : can('resource.workforce.edit');
  async function changeStatus(status: string, reason?: string) {
    setBusy(true); setError('');
    try {
      if (incomplete) await orgApi.setStatus(userId, status === 'inactive' ? 'disabled' : 'active', reason);
      else await resourceApi.changeStatus('workforce', record.id, status, reason);
      setDialog(null); onChanged();
    }
    catch (e) { const message = e instanceof ApiError ? e.message : '状态修改失败'; setError(message); throw e; }
    finally { setBusy(false); }
  }
  return <span className="workforce-actions" onClick={e => e.stopPropagation()}>
    {live && onEdit && canEdit && <button type="button" className="row-act" onClick={() => incomplete ? setDialog('employee') : onEdit(record)}>{incomplete ? '补资料' : '编辑'}</button>}
    {hasPerson && can('org.staff.view') && <button type="button" className="row-act" onClick={() => setDialog('records')}>记录</button>}
    {employeeAction && hasPerson && can('org.staff.view') && can('org.staff.edit') && <button type="button" className="row-act" onClick={() => setDialog('employee')}>员工资料</button>}
    {!incomplete && (!hasPerson || !can('org.staff.view') || employeeAction) && <button type="button" className="row-act" onClick={onLogs}>操作记录</button>}
    {live && can(incomplete ? 'org.staff.disable' : 'resource.workforce.disable') && (record.status === 'inactive'
      ? <button type="button" className="row-act" disabled={busy} title="恢复账号，登录仍按合作期限校验" onClick={() => void changeStatus('active').catch(() => undefined)}>{busy ? '处理中…' : '启用'}</button>
      : <button type="button" className="row-act danger" disabled={busy} onClick={() => { setError(''); setDialog('disable'); }}>停用</button>)}
    {error && !dialog && <small role="alert" className="row-act-err">{error}</small>}
    {dialog && createPortal(<div className="workforce-modal">
      {dialog === 'records' && <WorkforceRecords userId={userId} canSalary={can('org.staff.salary')} canHandover={live && can('org.staff.disable')} onClose={() => setDialog(null)} />}
      {dialog === 'employee' && <StaffEditorDialog id={userId} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); onChanged(); }} />}
      {dialog === 'disable' && <ReasonDialog title={`停用：${record.title}`} hint="停用后该员工账号也会停用，未完成工作按现有交接规则处理。原因将记录在人事与档案操作记录中。" confirmLabel="确认停用" onClose={() => { setDialog(null); setError(''); }} onSubmit={reason => changeStatus('inactive', reason)} />}
    </div>, document.body)}
  </span>;
}
