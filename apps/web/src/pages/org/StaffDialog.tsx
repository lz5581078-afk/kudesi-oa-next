import { type FormEvent, useState } from 'react';
import { createPortal } from 'react-dom';
import { todayShanghai, validateWorkforceTerms } from '@kudesi/shared';
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
import { errText } from './OrgDialogs';
import './staffDialog.css';

export function StaffDialog({
  staff,
  regularOnly=false,
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
  defaultDepartmentId?: number | null;
  all: StaffDto[];
  canSalary: boolean;
  departments: DepartmentNode[];
  positions: PositionDto[];
  onClose: () => void;
  onSaved: (created?: { account: string; password: string }) => void;
}) {
  const [account, setAccount] = useState(staff?.account ?? '');
  const [name, setName] = useState(staff?.name ?? '');
  const [departmentId, setDepartmentId] = useState<number | null>(
    staff ? (staff.departmentId ?? null) : (defaultDepartmentId ?? null),
  );
  const [positionId, setPositionId] = useState<number | null>(staff?.positionId ?? null);
  const [extra, setExtra] = useState<number[]>(staff?.extraPositionIds ?? []);
  const [managerId, setManagerId] = useState<number | null>(staff?.managerId ?? null);
  const [title, setTitle] = useState(staff?.title ?? '');
  const [salary, setSalary] = useState(staff?.baseSalary != null ? String(staff.baseSalary / 100) : '');
  const [payType, setPayType] = useState<PayType>(staff?.payType ?? 'monthly');
  const [hourly, setHourly] = useState(staff?.hourlyRate != null ? String(staff.hourlyRate / 100) : '');
  const [employmentType, setEmploymentType] = useState<EmploymentType>(staff?.employmentType ?? 'regular');
  const [contractStartDate, setContractStartDate] = useState(staff?.contractStartDate ?? todayShanghai());
  const [contractEndDate, setContractEndDate] = useState(staff?.contractEndDate ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError('请填写姓名');
    if (staff && employmentType !== 'regular') {
      const problem = validateWorkforceTerms({ employmentType, contractStartDate, contractEndDate });
      if (problem) return setError(problem);
    }
    if (canSalary && salary.trim() && !/^\d+(\.\d{1,2})?$/.test(salary.trim()))
      return setError('底薪请填写金额，最多两位小数');
    if (canSalary && hourly.trim() && !/^\d+(\.\d{1,2})?$/.test(hourly.trim()))
      return setError('时薪请填写金额，最多两位小数');
    if (canSalary && payType === 'hourly' && !hourly.trim()) return setError('计薪方式是时薪，请填写时薪');
    const hourlyCents = canSalary ? (hourly.trim() ? Math.round(Number(hourly) * 100) : null) : undefined;
    const payFields = {
      employmentType,
      ...(staff && employmentType !== 'regular' ? { contractStartDate, contractEndDate: contractEndDate || null } : {}),
      ...(canSalary ? { payType } : {}),
      ...(hourlyCents !== undefined ? { hourlyRate: hourlyCents } : {}),
    };
    const salaryCents = canSalary ? (salary.trim() ? Math.round(Number(salary) * 100) : null) : undefined;
    if (!staff && !/^[A-Za-z0-9_.-]{2,64}$/.test(account.trim()))
      return setError('账号只能用字母、数字、下划线、点和横线，2 到 64 位');
    setBusy(true);
    try {
      if (staff) {
        await orgApi.updateStaff(staff.id, {
          name: name.trim(),
          departmentId,
          positionId,
          extraPositionIds: positionId ? extra.filter((x) => x !== positionId) : [],
          managerId,
          title: title.trim() || null,
          ...payFields,
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
        aria-label={staff ? '编辑员工' : '新增员工'}
        onSubmit={submit}
      >
        <div className="modal-head">
          <strong>{staff ? `编辑员工：${staff.name}` : '新增员工'}</strong>
        </div>
        <div className="modal-body">
          <label>
            登录账号
            <input value={account} disabled={!!staff} maxLength={64} onChange={(e) => setAccount(e.target.value)} />
          </label>
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
              {(Object.keys(EMPLOYMENT_LABELS) as EmploymentType[]).filter(k=>!regularOnly||k==='regular').map((k) => (
                <option key={k} value={k}>
                  {EMPLOYMENT_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          {staff && employmentType !== 'regular' && <>
            <label>合作开始日期<input type="date" value={contractStartDate} onChange={e => setContractStartDate(e.target.value)} /></label>
            <label>{employmentType === 'temp' ? '合作结束日期（必填）' : '合作结束日期（可不填）'}<input aria-label="合作结束日期" type="date" min={contractStartDate} value={contractEndDate} onChange={e => setContractEndDate(e.target.value)} /></label>
            <p className="muted">保存后自动补齐或更新兼职与临时工档案，无需另行建档。</p>
          </>}
          {staff && employmentType === 'regular' && staff.employmentType !== 'regular' && <p className="muted">转为正式员工后，原用工档案保留在历史归档中，不再按兼职合作期限限制登录。</p>}
          {canSalary && (
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
          {!staff && <p className="muted">初始密码由系统随机生成，保存后显示一次。</p>}
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
