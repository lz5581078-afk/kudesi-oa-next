import { type FormEvent, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { getResourceDef, todayShanghai, validateWorkforceTerms } from '@kudesi/shared';
import {
  orgApi,
  flattenDepartments,
  type DepartmentNode,
  type PositionDto,
  type StaffDto,
  type PayType,
  type EmploymentType,
  PAY_TYPE_LABELS,
  EMPLOYMENT_LABELS,
} from './orgApi';
import { FieldInput } from '../../resources/RecordForm';
import type { ResourceDto } from '../../resources/api';
import { errText } from './OrgDialogs';
import './staffDialog.css';

export function StaffDialog({
  staff,
  regularOnly=false,
  workforce,
  all,
  canSalary,
  departments,
  positions,
  defaultDepartmentId,
  onClose,
  onSaved,
}: {
  staff: StaffDto | null;
  regularOnly?: boolean;
  workforce?: { record: ResourceDto | null; canPassword: boolean; canAccount: boolean };
  defaultDepartmentId?: number | null;
  all: StaffDto[];
  canSalary: boolean;
  departments: DepartmentNode[];
  positions: PositionDto[];
  onClose: () => void;
  onSaved: (created?: { account: string; password: string }) => void;
}) {
  const [account, setAccount] = useState(staff?.account ?? '');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [workforceFields, setWorkforceFields] = useState<Record<string, unknown>>({});
  const [files, setFiles] = useState(workforce?.record?.files ?? {});
  const fieldsId = useId();
  const trial = !!staff?.trial;
  const filing = !!workforce;
  const anchorPositions = positions.filter(position => position.status === 'active' && position.workspaceType === 'live_anchor');
  const defaultAnchor = trial && anchorPositions.length === 1 ? anchorPositions[0] : undefined;
  const [name, setName] = useState(staff?.name ?? '');
  const [departmentId, setDepartmentId] = useState<number | null>(
    staff ? (staff.departmentId ?? defaultAnchor?.departmentId ?? null) : (defaultDepartmentId ?? null),
  );
  const [positionId, setPositionId] = useState<number | null>(staff?.positionId ?? defaultAnchor?.id ?? null);
  const [extra, setExtra] = useState<number[]>(staff?.extraPositionIds ?? []);
  const [managerId, setManagerId] = useState<number | null>(staff?.managerId ?? null);
  const [title, setTitle] = useState(staff?.title ?? '');
  const [salary, setSalary] = useState(staff?.baseSalary != null ? String(staff.baseSalary / 100) : '');
  const [payType, setPayType] = useState<PayType>(staff?.payType ?? 'monthly');
  const [hourly, setHourly] = useState(staff?.hourlyRate != null ? String(staff.hourlyRate / 100) : '');
  const [employmentType, setEmploymentType] = useState<EmploymentType>(staff?.employmentType ?? (filing ? 'part_time' : 'regular'));
  const [contractStartDate, setContractStartDate] = useState(staff?.contractStartDate ?? todayShanghai());
  const [contractEndDate, setContractEndDate] = useState(staff?.contractEndDate ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError('请填写姓名');
    if ((staff || filing) && employmentType !== 'regular') {
      const problem = validateWorkforceTerms({ employmentType, contractStartDate, contractEndDate });
      if (problem) return setError(problem);
    }
    if (filing && trial && !anchorPositions.some(position => position.id === positionId || extra.includes(position.id)))
      return setError('请设置主播岗位，保存后可按普通主播上播');
    const canSetAccount = filing && workforce.canAccount;
    if ((!staff || canSetAccount) && !/^[A-Za-z0-9_.-]{2,64}$/.test(account.trim()))
      return setError('账号只能用字母、数字、下划线、点和横线，2 到 64 位');
    if (filing && staff && !staff.account && !password) return setError('建立账号时请设置登录密码');
    if (password && (password.length < 8 || new TextEncoder().encode(password).length > 72))
      return setError('密码至少8位，且不能超过72字节');
    if (password !== confirmPassword) return setError('两次密码不一致');
    const editStaffPay = canSalary && (!filing || employmentType === 'regular');
    if (editStaffPay && salary.trim() && !/^\d+(\.\d{1,2})?$/.test(salary.trim()))
      return setError('底薪请填写金额，最多两位小数');
    if (editStaffPay && hourly.trim() && !/^\d+(\.\d{1,2})?$/.test(hourly.trim()))
      return setError('时薪请填写金额，最多两位小数');
    if (editStaffPay && payType === 'hourly' && !hourly.trim()) return setError('计薪方式是时薪，请填写时薪');
    const hourlyCents = editStaffPay ? (hourly.trim() ? Math.round(Number(hourly) * 100) : null) : undefined;
    const payFields = {
      employmentType,
      ...((staff || filing) && employmentType !== 'regular' ? { contractStartDate, contractEndDate: contractEndDate || null } : {}),
      ...(editStaffPay ? { payType } : {}),
      ...(hourlyCents !== undefined ? { hourlyRate: hourlyCents } : {}),
    };
    const salaryCents = editStaffPay ? (salary.trim() ? Math.round(Number(salary) * 100) : null) : undefined;
    const archiveFields = filing && employmentType !== 'regular' ? {
      workforceData: {
        ...(trial && canSalary && staff?.hourlyRate && !workforce.record ? { payMethod: 'hourly', payRate: staff.hourlyRate } : {}),
        ...workforceFields,
      },
    } : {};
    const credential = password ? { password } : {};
    setBusy(true);
    try {
      if (staff) {
        await orgApi.updateStaff(staff.id, {
          ...(canSetAccount && account.trim() !== staff.account ? { account: account.trim() } : {}),
          name: name.trim(),
          departmentId,
          positionId,
          extraPositionIds: positionId ? extra.filter((x) => x !== positionId) : [],
          managerId,
          title: title.trim() || null,
          ...payFields,
          ...archiveFields,
          ...credential,
          ...(salaryCents !== undefined ? { baseSalary: salaryCents } : {}),
        });
        onSaved();
      } else {
        const r = await orgApi.addStaff({
          account: account.trim(),
          name: name.trim(),
          departmentId,
          positionId,
          extraPositionIds: positionId ? extra.filter((x) => x !== positionId) : [],
          managerId,
          title: title.trim() || undefined,
          ...payFields,
          ...archiveFields,
          ...credential,
          ...(salaryCents ? { baseSalary: salaryCents } : {}),
        });
        onSaved({ account: r.staff.account, password: r.initialPassword });
      }
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }
  return createPortal(
    <div className="modal-backdrop org-staff-backdrop" role="presentation">
      <form
        className="modal card small org-staff-dialog"
        role="dialog"
        aria-label={staff ? '编辑员工' : filing ? '新增人员' : '新增员工'}
        onSubmit={submit}
      >
        <div className="modal-head">
          <strong>{staff ? `编辑员工：${staff.name}` : filing ? '新增人员' : '新增员工'}</strong>
        </div>
        <div className="modal-body">
          <label>
            登录账号
            <input value={account} disabled={!!staff && !workforce?.canAccount} maxLength={64} onChange={(e) => setAccount(e.target.value)} />
          </label>
          {filing && workforce.canPassword && <>
            <label>{staff?.account ? '新密码' : '登录密码'}<input type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} /></label>
            <label>确认密码<input type="password" autoComplete="new-password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} /></label>
            {staff?.account && <p className="muted">密码留空时保留原密码。</p>}
          </>}
          {trial && filing && <p className="muted">保存后完成建档，按普通主播打卡。试播期间的场次仍保留。</p>}
          <label>
            姓名
            <input value={name} maxLength={50} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            部门
            <select
              value={departmentId ?? ''}
              onChange={(e) => setDepartmentId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">（不选）</option>
              {flattenDepartments(departments).map((d) => (
                <option key={d.id} value={d.id}>
                  {'　'.repeat(d.depth)}
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            岗位
            <select
              value={positionId ?? ''}
              onChange={(e) => setPositionId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">（不选，没有岗位权限）</option>
              {positions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          {positionId && positions.length > 1 && (
            <fieldset className="check-group">
              <legend>兼任岗位（权限取主岗位和兼任岗位的并集）</legend>
              {positions
                .filter((p) => p.id !== positionId)
                .map((p) => (
                  <label key={p.id} className="check-line">
                    <input
                      type="checkbox"
                      checked={extra.includes(p.id)}
                      onChange={(e) => setExtra(e.target.checked ? [...extra, p.id] : extra.filter((x) => x !== p.id))}
                    />
                    {p.name}
                  </label>
                ))}
            </fieldset>
          )}
          <label>
            直属上级
            <select
              value={managerId ?? ''}
              onChange={(e) => setManagerId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">（无）</option>
              {all
                .filter((x) => x.status === 'active' && x.id !== staff?.id)
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            职称
            <input value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label>
            用工类型
            <select value={employmentType} onChange={(e) => setEmploymentType(e.target.value as EmploymentType)}>
              {(Object.keys(EMPLOYMENT_LABELS) as EmploymentType[]).filter(k => regularOnly ? k === 'regular' : (!filing || staff && !trial || k !== 'regular')).map((k) => (
                <option key={k} value={k}>
                  {EMPLOYMENT_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          {(staff || filing) && employmentType !== 'regular' && <>
            <label>合作开始日期<input type="date" value={contractStartDate} onChange={e => setContractStartDate(e.target.value)} /></label>
            <label>合作结束日期（可不填）<input aria-label="合作结束日期" type="date" min={contractStartDate} value={contractEndDate} onChange={e => setContractEndDate(e.target.value)} /></label>
            <p className="muted">保存后自动补齐或更新兼职与临时工档案，无需另行建档。</p>
          </>}
          {staff && employmentType === 'regular' && staff.employmentType !== 'regular' && <p className="muted">转为正式员工后，原用工档案保留在历史归档中，不再按兼职合作期限限制登录。</p>}
          {canSalary && (!filing || employmentType === 'regular') && (
            <>
              <label>
                计薪方式
                <select value={payType} onChange={(e) => setPayType(e.target.value as PayType)}>
                  {(Object.keys(PAY_TYPE_LABELS) as PayType[]).map((k) => (
                    <option key={k} value={k}>
                      {PAY_TYPE_LABELS[k]}
                    </option>
                  ))}
                </select>
              </label>
              {payType === 'monthly' ? (
                <label>
                  底薪（元/月）
                  <input inputMode="decimal" value={salary} onChange={(e) => setSalary(e.target.value)} />
                </label>
              ) : (
                <label>
                  时薪（元/小时）
                  <input inputMode="decimal" value={hourly} onChange={(e) => setHourly(e.target.value)} />
                </label>
              )}
            </>
          )}
          {filing && employmentType !== 'regular' && getResourceDef('workforce')!.fields.filter(field =>
            !field.readonly && !['userId', 'employmentType', 'contractStartDate', 'contractEndDate'].includes(field.key) &&
            (!field.permission || canSalary)
          ).map(field => {
            const inputId = `${fieldsId}-${field.key}`;
            const value = field.key in workforceFields ? workforceFields[field.key] :
              workforce.record?.data[field.key] ?? (trial && staff?.hourlyRate ? field.key === 'payRate' ? staff.hourlyRate : field.key === 'payMethod' ? 'hourly' : undefined : undefined);
            return <div key={field.key} className="org-workforce-field">
              <label htmlFor={inputId}>{field.label}</label>
              <FieldInput type="workforce" inputId={inputId} field={field} value={value} known={files}
                onKnown={file => setFiles(current => ({ ...current, [file.id]: file }))}
                onChange={next => setWorkforceFields(current => ({ ...current, [field.key]: next === '' ? null : next }))} />
            </div>;
          })}
          {!staff && !password && <p className="muted">初始密码由系统随机生成，保存后显示一次。</p>}
          {error && (
            <div role="alert" className="notice error">
              {error}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primary-button" disabled={busy}>
            保存
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
