import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { createChecker, type CatalogGroup } from '@kudesi/shared';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../api/client';
import { ConfirmDialog } from './StructurePage';
import { PermissionPicker } from './PermissionPicker';
import { orgApi, flattenDepartments, type DepartmentNode, type PositionDto, type StaffDetail, type StaffDto, type HandoverPreview, type PayType, type EmploymentType, PAY_TYPE_LABELS, EMPLOYMENT_LABELS } from './orgApi';
import { StaffRecordsDialog } from './StaffRecordsDialog';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : '操作失败');

function PasswordNotice({ title, account, password, onClose }: { title: string; account: string; password: string; onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal card small" role="dialog" aria-label={title}>
        <div className="modal-head"><strong>{title}</strong></div>
        <div className="modal-body">
          <p>账号 <strong>{account}</strong> 的临时密码如下，<strong>只显示这一次</strong>，请当面或通过安全渠道告诉本人。首次登录会要求改密码。</p>
          <code className="secret-box" aria-label="临时密码">{password}</code>
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={() => void navigator.clipboard?.writeText(password)}>复制</button>
          <button type="button" className="primary-button" onClick={onClose}>我已记下</button>
        </div>
      </div>
    </div>
  );
}

function StaffDialog({ staff, all, canSalary, departments, positions, onClose, onSaved }: {
  staff: StaffDto | null; all: StaffDto[]; canSalary: boolean; departments: DepartmentNode[]; positions: PositionDto[];
  onClose: () => void; onSaved: (created?: { account: string; password: string }) => void;
}) {
  const [account, setAccount] = useState(staff?.account ?? '');
  const [name, setName] = useState(staff?.name ?? '');
  const [departmentId, setDepartmentId] = useState<number | null>(staff?.departmentId ?? null);
  const [positionId, setPositionId] = useState<number | null>(staff?.positionId ?? null);
  const [extra, setExtra] = useState<number[]>(staff?.extraPositionIds ?? []);
  const [managerId, setManagerId] = useState<number | null>(staff?.managerId ?? null);
  const [title, setTitle] = useState(staff?.title ?? '');
  const [salary, setSalary] = useState(staff?.baseSalary != null ? String(staff.baseSalary / 100) : '');
  const [payType, setPayType] = useState<PayType>(staff?.payType ?? 'monthly');
  const [hourly, setHourly] = useState(staff?.hourlyRate != null ? String(staff.hourlyRate / 100) : '');
  const [employmentType, setEmploymentType] = useState<EmploymentType>(staff?.employmentType ?? 'regular');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError('请填写姓名');
    if (canSalary && salary.trim() && !/^\d+(\.\d{1,2})?$/.test(salary.trim())) return setError('底薪请填写金额，最多两位小数');
    if (canSalary && hourly.trim() && !/^\d+(\.\d{1,2})?$/.test(hourly.trim())) return setError('时薪请填写金额，最多两位小数');
    if (canSalary && payType === 'hourly' && !hourly.trim()) return setError('计薪方式是时薪，请填写时薪');
    const hourlyCents = canSalary ? (hourly.trim() ? Math.round(Number(hourly) * 100) : null) : undefined;
    const payFields = { employmentType, ...(canSalary ? { payType } : {}), ...(hourlyCents !== undefined ? { hourlyRate: hourlyCents } : {}) };
    const salaryCents = canSalary ? (salary.trim() ? Math.round(Number(salary) * 100) : null) : undefined;
    if (!staff && !/^[A-Za-z0-9_.-]{2,64}$/.test(account.trim())) return setError('账号只能用字母、数字、下划线、点和横线，2 到 64 位');
    setBusy(true);
    try {
      if (staff) {
        await orgApi.updateStaff(staff.id, { name: name.trim(), departmentId, positionId, extraPositionIds: positionId ? extra.filter((x) => x !== positionId) : [], managerId, title: title.trim() || null, ...payFields, ...(salaryCents !== undefined ? { baseSalary: salaryCents } : {}) });
        onSaved();
      } else {
        const r = await orgApi.addStaff({ account: account.trim(), name: name.trim(), departmentId, positionId, extraPositionIds: positionId ? extra.filter((x) => x !== positionId) : [], managerId, title: title.trim() || undefined, ...payFields, ...(salaryCents ? { baseSalary: salaryCents } : {}) });
        onSaved({ account: r.staff.account, password: r.initialPassword });
      }
    } catch (err) { setError(errText(err)); setBusy(false); }
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal card small" role="dialog" aria-label={staff ? '编辑员工' : '新增员工'} onSubmit={submit}>
        <div className="modal-head"><strong>{staff ? `编辑员工：${staff.name}` : '新增员工'}</strong></div>
        <div className="modal-body">
          <label>登录账号<input value={account} disabled={!!staff} maxLength={64} onChange={(e) => setAccount(e.target.value)} /></label>
          <label>姓名<input value={name} maxLength={50} onChange={(e) => setName(e.target.value)} /></label>
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
          {positionId && positions.length > 1 && (
            <fieldset className="check-group">
              <legend>兼任岗位（权限取主岗位和兼任岗位的并集）</legend>
              {positions.filter((p) => p.id !== positionId).map((p) => (
                <label key={p.id} className="check-line">
                  <input type="checkbox" checked={extra.includes(p.id)} onChange={(e) => setExtra(e.target.checked ? [...extra, p.id] : extra.filter((x) => x !== p.id))} />{p.name}
                </label>
              ))}
            </fieldset>
          )}
          <label>直属上级
            <select value={managerId ?? ''} onChange={(e) => setManagerId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">（无）</option>
              {all.filter((x) => x.status === 'active' && x.id !== staff?.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
          <label>职称<input value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} /></label>
          <label>用工类型
            <select value={employmentType} onChange={(e) => setEmploymentType(e.target.value as EmploymentType)}>
              {(Object.keys(EMPLOYMENT_LABELS) as EmploymentType[]).map((k) => <option key={k} value={k}>{EMPLOYMENT_LABELS[k]}</option>)}
            </select>
          </label>
          {canSalary && (
            <>
              <label>计薪方式
                <select value={payType} onChange={(e) => setPayType(e.target.value as PayType)}>
                  {(Object.keys(PAY_TYPE_LABELS) as PayType[]).map((k) => <option key={k} value={k}>{PAY_TYPE_LABELS[k]}</option>)}
                </select>
              </label>
              {payType === 'monthly'
                ? <label>底薪（元/月）<input inputMode="decimal" value={salary} onChange={(e) => setSalary(e.target.value)} /></label>
                : <label>时薪（元/小时）<input inputMode="decimal" value={hourly} onChange={(e) => setHourly(e.target.value)} /></label>}
            </>
          )}
          {!staff && <p className="muted">初始密码由系统随机生成，保存后显示一次。</p>}
          {error && <div role="alert" className="notice error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="submit" className="primary-button" disabled={busy}>保存</button>
        </div>
      </form>
    </div>
  );
}

function OverridesDialog({ staff, position, catalog, onClose, onSaved }: { staff: StaffDto; position: PositionDto | null; catalog: CatalogGroup[]; onClose: () => void; onSaved: () => void }) {
  const [detail, setDetail] = useState<StaffDetail | null>(null);
  const [allow, setAllow] = useState<string[]>([]);
  const [deny, setDeny] = useState<string[]>([]);
  const [mode, setMode] = useState<'allow' | 'deny'>('allow');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    orgApi.staffOne(staff.id).then((d) => { setDetail(d); setAllow(d.allow); setDeny(d.deny); }).catch((e) => setError(errText(e)));
  }, [staff.id]);
  async function save() {
    setBusy(true);
    try { await orgApi.setOverrides(staff.id, allow, deny); onSaved(); } catch (err) { setError(errText(err)); setBusy(false); }
  }
  // 选了“允许”的同时从“拒绝”里去掉，反之亦然，避免同一项两边都勾
  const onAllow = (next: string[]) => { setAllow(next); setDeny((d) => d.filter((k) => !next.includes(k))); };
  const onDeny = (next: string[]) => { setDeny(next); setAllow((a) => a.filter((k) => !next.includes(k))); };
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal card" role="dialog" aria-label="个人权限">
        <div className="modal-head"><strong>个人权限：{staff.name}</strong></div>
        <div className="modal-body">
          {staff.isCompanyAdmin ? (
            <p className="muted">公司管理员拥有全部权限，不受个人权限限制。</p>
          ) : (
            <>
              <p className="muted">岗位「{position?.name ?? '无'}」已有 {position?.permissions.length ?? 0} 项权限。这里只设置这个人的例外：“额外允许”在岗位之外加权限，“明确拒绝”优先于一切（包括岗位）。</p>
              <div role="tablist" className="tabs">
                <button type="button" role="tab" aria-selected={mode === 'allow'} className={mode === 'allow' ? 'tab active' : 'tab'} onClick={() => setMode('allow')}>额外允许（{allow.length}）</button>
                <button type="button" role="tab" aria-selected={mode === 'deny'} className={mode === 'deny' ? 'tab active' : 'tab'} onClick={() => setMode('deny')}>明确拒绝（{deny.length}）</button>
              </div>
              {detail ? (
                mode === 'allow'
                  ? <PermissionPicker catalog={catalog} values={allow} onChange={onAllow} hintKeys={position?.permissions} hintLabel="岗位已有" />
                  : <PermissionPicker catalog={catalog} values={deny} onChange={onDeny} hintKeys={[...(position?.permissions ?? []), ...allow]} hintLabel="当前有" />
              ) : <p className="muted">加载中…</p>}
            </>
          )}
          {error && <div role="alert" className="notice error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          {!staff.isCompanyAdmin && <button type="button" className="primary-button" disabled={busy || !detail} onClick={() => void save()}>保存</button>}
        </div>
      </div>
    </div>
  );
}

function DisableDialog({ staff, onClose, onDone }: { staff: StaffDto; onClose: () => void; onDone: () => void }) {
  const [pv, setPv] = useState<HandoverPreview | null>(null);
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    orgApi.handoverPreview(staff.id).then((d) => { setPv(d); setTo(d.suggested ? String(d.suggested.id) : ''); }).catch((e) => setError(errText(e)));
  }, [staff.id]);
  const need = (pv?.counts.total ?? 0) > 0;
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (reason.trim().length < 2) return setError('请填写停用原因');
    if (need && !to) return setError('他手上还有待办或周期任务，请选择交接人');
    setBusy(true);
    try { await orgApi.setStatus(staff.id, 'disabled', reason.trim(), to ? Number(to) : undefined); onDone(); } catch (err) { setError(errText(err)); setBusy(false); }
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal card small" role="dialog" aria-label="停用员工" onSubmit={submit}>
        <div className="modal-head"><strong>停用「{staff.name}」</strong></div>
        <div className="modal-body">
          <p>停用后他立刻不能登录，已有记录和操作日志都保留，可随时重新启用。</p>
          {pv && (
            <p className={need ? 'notice' : 'muted'}>
              {need ? `他手上有 ${pv.counts.workItems} 条待办、${pv.counts.routines} 个周期任务、${pv.counts.flowSteps} 个流程步骤的处理人，停用时会一并交给接收人。` : '他手上没有待办、周期任务或流程步骤，无需交接。'}
            </p>
          )}
          {pv && (
            <label>交接给{need ? '' : '（可不选）'}
              <select value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="">（不交接）</option>
                {pv.candidates.map((c) => <option key={c.id} value={c.id}>{c.name}{pv.suggested?.id === c.id ? '（建议：同岗位/上级）' : ''}</option>)}
              </select>
            </label>
          )}
          <label>停用原因<input autoFocus value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} /></label>
          {error && <div role="alert" className="notice error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="submit" className="primary-button danger-fill" disabled={busy || !pv}>确认停用</button>
        </div>
      </form>
    </div>
  );
}

export function StaffPage() {
  const { user } = useAuth();
  const can = user ? createChecker(user.permissions) : () => false;
  const [staff, setStaff] = useState<StaffDto[]>([]);
  const [tree, setTree] = useState<DepartmentNode[]>([]);
  const [positions, setPositions] = useState<PositionDto[]>([]);
  const [catalog, setCatalog] = useState<CatalogGroup[]>([]);
  const [keyword, setKeyword] = useState('');
  const [showDisabled, setShowDisabled] = useState(false);
  const [onlyNoPosition, setOnlyNoPosition] = useState(false);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<
    { kind: 'edit'; staff: StaffDto | null } | { kind: 'perm'; staff: StaffDto } | { kind: 'reset'; staff: StaffDto }
    | { kind: 'disable'; staff: StaffDto } | { kind: 'records'; staff: StaffDto } | { kind: 'password'; title: string; account: string; password: string } | null
  >(null);

  const reload = useCallback(async () => {
    try {
      const [s, t, p, c] = await Promise.all([orgApi.staff(), orgApi.departments(), orgApi.positions(), orgApi.catalog()]);
      setStaff(s); setTree(t); setPositions(p); setCatalog(c); setError('');
    } catch (e) { setError(errText(e)); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const deptName = useMemo(() => new Map(flattenDepartments(tree).map((d) => [d.id, d.name])), [tree]);
  const shown = staff.filter((s) => (showDisabled || s.status === 'active') && (!onlyNoPosition || !s.positionId) && (!keyword.trim() || `${s.name}${s.account}`.toLowerCase().includes(keyword.trim().toLowerCase())));
  const done = async () => { setDialog(null); await reload(); };

  async function toggle(s: StaffDto) {
    try { await orgApi.setStatus(s.id, 'active'); await reload(); } catch (e) { setError(errText(e)); }
  }

  return (
    <div>
      <div className="page-head">
        <h1>员工与权限</h1>
        {can('org.staff.create') && <button type="button" className="primary-button" onClick={() => setDialog({ kind: 'edit', staff: null })}>＋ 新增员工</button>}
      </div>
      {error && <div role="alert" className="notice error">{error}</div>}
      <div className="card">
        <div className="toolbar">
          <input type="search" aria-label="搜索员工" placeholder="按姓名或账号搜索" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
          <label className="check-line"><input type="checkbox" checked={showDisabled} onChange={(e) => setShowDisabled(e.target.checked)} />显示已停用</label>
          <label className="check-line"><input type="checkbox" checked={onlyNoPosition} onChange={(e) => setOnlyNoPosition(e.target.checked)} />只看没有岗位的</label>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>姓名</th><th>账号</th><th>部门</th><th>岗位</th><th>职称</th><th>用工/计薪</th><th>直属上级</th><th>状态</th><th>最近登录</th><th>操作</th></tr></thead>
            <tbody>
              {shown.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}{s.isCompanyAdmin && <span className="pill ok"> 管理员</span>}</td>
                  <td>{s.account}</td>
                  <td>{s.departmentId ? deptName.get(s.departmentId) ?? '—' : '—'}</td>
                  <td>{s.positionName ?? '—'}{s.extraPositionIds.length > 0 && <small className="muted"> 兼 {s.extraPositionIds.map((id) => positions.find((p) => p.id === id)?.name).filter(Boolean).join('、')}</small>}</td>
                  <td>{s.title ?? '—'}</td>
                  <td>{EMPLOYMENT_LABELS[s.employmentType ?? 'regular']}{s.payType === 'hourly' ? ' · 时薪' : ''}</td>
                  <td>{staff.find((x) => x.id === s.managerId)?.name ?? '—'}</td>
                  <td><span className={s.status === 'active' ? 'pill ok' : 'pill warn'}>{s.status === 'active' ? '在职' : '已停用'}</span></td>
                  <td>{s.lastLoginAt ? new Date(s.lastLoginAt).toLocaleString('zh-CN') : '从未登录'}</td>
                  <td>
                    <span className="row-actions">
                      {can('org.staff.edit') && <button type="button" className="link-button" onClick={() => setDialog({ kind: 'edit', staff: s })}>编辑</button>}
                      {can('org.staff.view') && <button type="button" className="link-button" onClick={() => setDialog({ kind: 'records', staff: s })}>人员记录</button>}
                      {can('org.staff.edit') && <button type="button" className="link-button" onClick={() => setDialog({ kind: 'perm', staff: s })}>个人权限</button>}
                      {can('org.staff.reset') && <button type="button" className="link-button" onClick={() => setDialog({ kind: 'reset', staff: s })}>重置密码</button>}
                      {can('org.staff.disable') && (s.status === 'active'
                        ? <button type="button" className="link-button danger-text" onClick={() => setDialog({ kind: 'disable', staff: s })}>停用</button>
                        : <button type="button" className="link-button" onClick={() => void toggle(s)}>启用</button>)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {shown.length === 0 && <p className="muted pad">没有符合条件的员工</p>}
      </div>

      {dialog?.kind === 'edit' && (
        <StaffDialog staff={dialog.staff} all={staff} canSalary={can('org.staff.salary')} departments={tree} positions={positions} onClose={() => setDialog(null)}
          onSaved={async (created) => { await reload(); setDialog(created ? { kind: 'password', title: '员工已创建', account: created.account, password: created.password } : null); }} />
      )}
      {dialog?.kind === 'perm' && (
        <OverridesDialog staff={dialog.staff} position={positions.find((p) => p.id === dialog.staff.positionId) ?? null} catalog={catalog} onClose={() => setDialog(null)} onSaved={() => void done()} />
      )}
      {dialog?.kind === 'reset' && (
        <ConfirmDialog title={`重置「${dialog.staff.name}」的密码`} text="会生成新的临时密码，原密码立即失效，对方下次登录必须改密码。" confirmLabel="重置" onClose={() => setDialog(null)}
          onConfirm={async () => { const r = await orgApi.resetPassword(dialog.staff.id); setDialog({ kind: 'password', title: '密码已重置', account: dialog.staff.account, password: r.password }); }} />
      )}
      {dialog?.kind === 'records' && <StaffRecordsDialog staff={dialog.staff} all={staff} canHandover={can('org.staff.disable')} canSalary={can('org.staff.salary')} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'disable' && <DisableDialog staff={dialog.staff} onClose={() => setDialog(null)} onDone={() => void done()} />}
      {dialog?.kind === 'password' && <PasswordNotice title={dialog.title} account={dialog.account} password={dialog.password} onClose={() => setDialog(null)} />}
    </div>
  );
}
