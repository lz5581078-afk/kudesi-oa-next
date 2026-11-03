import { StaffFeishuBadge, StaffTestNoticeDialog } from './StaffFeishu';
import { StaffFeishuResetDialog } from './StaffFeishuReset';
import { StaffFeishuUnbindDialog } from './StaffFeishuUnbind';
import { StaffDialog } from './StaffDialog';
import { StaffEditorDialog } from './StaffEditorDialog';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { createChecker, type CatalogGroup } from '@kudesi/shared';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../api/client';
import { ConfirmDialog } from './StructurePage';
import { PermissionPicker } from './PermissionPicker';
import { orgApi, flattenDepartments, type DepartmentNode, type PositionDto, type StaffDetail, type StaffDto, type StaffFeishuStatus, type HandoverPreview, EMPLOYMENT_LABELS } from './orgApi';
import { StaffRecordsDialog } from './StaffRecordsDialog';
import { StaffImportDialog } from './StaffImportDialog';
import { CopyButton } from '../../resources/CopyValue';
import { resourceApi } from '../../resources/api';

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
  const [feishu,setFeishu]=useState<Map<number,StaffFeishuStatus>>(new Map());
  const [feishuError,setFeishuError]=useState('');
  const [bindingFilter,setBindingFilter]=useState('');
  const [testStaff,setTestStaff]=useState<StaffDto|null>(null);
  const [resetFeishu,setResetFeishu]=useState(false);
  const [unbindStaff,setUnbindStaff]=useState<StaffDto|null>(null);
  const [keyword, setKeyword] = useState('');
  const [showDisabled, setShowDisabled] = useState(false);
  const [onlyNoPosition, setOnlyNoPosition] = useState(false);
  // 从组织架构页“新增成员”跳来时带 ?dept=部门&new=1：按该部门筛选并直接打开新增表单
  const [entry] = useState(() => { try { const q = new URLSearchParams(window.location.search); return { dept: q.get('dept') ?? '', add: q.get('new') === '1' }; } catch { return { dept: '', add: false }; } });
  const [deptFilter, setDeptFilter] = useState(entry.dept);
  const [posFilter, setPosFilter] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const [groups, setGroups] = useState<Array<{ id: number; name: string }>>([]);
  const [memberOf, setMemberOf] = useState<Map<number, Set<number>>>(new Map());
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<
    { kind: 'edit'; staff: StaffDto | null } | { kind: 'perm'; staff: StaffDto } | { kind: 'reset'; staff: StaffDto }
    | { kind: 'disable'; staff: StaffDto } | { kind: 'records'; staff: StaffDto } | { kind: 'import' } | { kind: 'password'; title: string; account: string; password: string } | null
  >(null);

  const reloadFeishu=useCallback(async()=>{
    try{const data=await orgApi.staffFeishu();setFeishu(new Map(data.rows.map(r=>[r.userId,r])));setFeishuError('');}
    catch{setFeishu(new Map());setFeishuError('飞书绑定状态读取失败，请刷新状态后重试');}
  },[]);
  const reload = useCallback(async () => {
    void reloadFeishu();
    try {
      const [s, t, p, c] = await Promise.all([orgApi.staff(), orgApi.departments(), orgApi.positions(), orgApi.catalog()]);
      setStaff(s); setTree(t); setPositions(p); setCatalog(c); setError('');
    } catch (e) { setError(errText(e)); }
  }, [reloadFeishu]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => { if (entry.add && can('org.staff.create')) setDialog({ kind: 'edit', staff: null }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // 职责组筛选（旧员工页有）：没有职责组查看权限时静默不显示
  useEffect(() => {
    Promise.all([resourceApi.list('duty-groups', { pageSize: 200 }), resourceApi.list('duty-group-members', { pageSize: 200, showHidden: true })]).then(([g, m]) => {
      setGroups(g.items.map((x) => ({ id: x.id, name: x.title })));
      const map = new Map<number, Set<number>>();
      for (const r of m.items) { if (r.status !== 'active' && r.status !== 'normal') continue; const gid = Number(r.data.groupId); const uid = Number(r.data.userId); if (!map.has(gid)) map.set(gid, new Set()); map.get(gid)!.add(uid); }
      setMemberOf(map);
    }).catch(() => undefined);
  }, []);

  const deptName = useMemo(() => new Map(flattenDepartments(tree).map((d) => [d.id, d.name])), [tree]);
  // 选了上级部门，也包含它的下级部门里的人
  const deptScope = useMemo(() => {
    if (!deptFilter) return null;
    const ids = new Set<number>();
    const walk = (nodes: DepartmentNode[], inside: boolean) => { for (const n of nodes) { const hit = inside || String(n.id) === deptFilter; if (hit) ids.add(n.id); walk(n.children, hit); } };
    walk(tree, false);
    return ids;
  }, [deptFilter, tree]);
  const shown = staff.filter((s) => (s.employmentType??'regular')==='regular' && (showDisabled || s.status === 'active') && (!bindingFilter||(bindingFilter==='bound'?feishu.get(s.id)?.bound===true:feishu.get(s.id)?.bound===false)) && (!onlyNoPosition || !s.positionId) && (!deptScope || (s.departmentId != null && deptScope.has(s.departmentId))) && (!groupFilter || memberOf.get(Number(groupFilter))?.has(s.id)) && (!posFilter || String(s.positionId) === posFilter || s.extraPositionIds.includes(Number(posFilter))) && (!keyword.trim() || `${s.name}${s.account}`.toLowerCase().includes(keyword.trim().toLowerCase())));
  const done = async () => { setDialog(null); await reload(); };

  async function exportCsv() {
    try {
      const { csv } = await orgApi.exportStaff();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      a.download = `员工档案-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { setError(errText(e)); }
  }

  async function toggle(s: StaffDto) {
    try { await orgApi.setStatus(s.id, 'active'); await reload(); } catch (e) { setError(errText(e)); }
  }

  return (
    <div>
      <div className="page-head">
        <h1>员工与权限</h1>
        <span className="row-actions">
          {user?.permissions.isCompanyAdmin&&<button type="button" className="secondary-button" onClick={()=>setResetFeishu(true)}>取消全员飞书关联</button>}
          {can('org.staff.view') && <button type="button" className="secondary-button" onClick={() => void exportCsv()}>导出</button>}
          {can('org.staff.create') && <button type="button" className="secondary-button" onClick={() => setDialog({ kind: 'import' })}>导入</button>}
          {can('org.staff.create') && <button type="button" className="primary-button" onClick={() => setDialog({ kind: 'edit', staff: null })}>＋ 新增员工</button>}
        </span>
      </div>
      <p className="muted">这里只显示正式员工；兼职与临时工请在“兼职与临时工”页面管理。</p>
      {feishuError&&<div role="alert" className="notice error">{feishuError}</div>}
      {testStaff&&<StaffTestNoticeDialog key={testStaff.id} staff={testStaff} status={feishu.get(testStaff.id)} onClose={()=>setTestStaff(null)}/>}
      {resetFeishu&&<StaffFeishuResetDialog onClose={()=>setResetFeishu(false)}/>}
      {unbindStaff&&<StaffFeishuUnbindDialog key={unbindStaff.id} staff={unbindStaff} onClose={()=>setUnbindStaff(null)} onDone={async()=>{await reloadFeishu();setUnbindStaff(null);}}/>}
      {error && <div role="alert" className="notice error">{error}</div>}
      <div className="card">
        <div className="toolbar">
          <input type="search" aria-label="搜索员工" placeholder="按姓名或账号搜索" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
          <select aria-label="部门" value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)}>
            <option value="">部门：全部</option>
            {flattenDepartments(tree).map((d) => <option key={d.id} value={d.id}>{'　'.repeat(d.depth)}{d.name}</option>)}
          </select>
          {groups.length > 0 && (
            <select aria-label="职责组" value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}>
              <option value="">职责组：全部</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          )}
          <select aria-label="岗位" value={posFilter} onChange={(e) => setPosFilter(e.target.value)}>
            <option value="">岗位：全部</option>
            {positions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select aria-label="飞书绑定状态" value={bindingFilter} onChange={e=>setBindingFilter(e.target.value)}><option value="">飞书：全部</option><option value="bound">已绑定</option><option value="unbound">未绑定</option></select>
          <button type="button" className="secondary-button" onClick={()=>void reloadFeishu()}>刷新绑定状态</button>
          <label className="check-line"><input type="checkbox" checked={showDisabled} onChange={(e) => setShowDisabled(e.target.checked)} />显示已停用</label>
          <label className="check-line"><input type="checkbox" checked={onlyNoPosition} onChange={(e) => setOnlyNoPosition(e.target.checked)} />只看没有岗位的</label>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>姓名</th><th>账号</th><th>部门</th><th>岗位</th><th>职称</th><th>用工/计薪</th><th>职责组</th><th>直属上级</th><th>状态</th><th>飞书绑定</th><th>最近登录</th><th>操作</th></tr></thead>
            <tbody>
              {shown.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}{s.isCompanyAdmin && <span className="pill ok"> 管理员</span>}</td>
                  <td>{s.account} <CopyButton value={s.account} label={`${s.name}的登录账号`} /></td>
                  <td>{s.departmentId ? deptName.get(s.departmentId) ?? '—' : '—'}</td>
                  <td>{s.positionName ?? '—'}{s.extraPositionIds.length > 0 && <small className="muted"> 兼 {s.extraPositionIds.map((id) => positions.find((p) => p.id === id)?.name).filter(Boolean).join('、')}</small>}</td>
                  <td>{s.title ?? '—'}</td>
                  <td>{EMPLOYMENT_LABELS[s.employmentType ?? 'regular']}{s.payType === 'hourly' ? ' · 时薪' : ''}</td>
                  <td>{groups.filter((g) => memberOf.get(g.id)?.has(s.id)).map((g) => g.name).join('、') || '—'}</td>
                  <td>{staff.find((x) => x.id === s.managerId)?.name ?? '—'}</td>
                  <td><span className={s.status === 'active' ? 'pill ok' : 'pill warn'}>{s.status === 'active' ? '在职' : '已停用'}</span></td>
                  <td><StaffFeishuBadge status={feishu.get(s.id)}/></td>
                  <td>{s.lastLoginAt ? new Date(s.lastLoginAt).toLocaleString('zh-CN') : '从未登录'}</td>
                  <td>
                    <span className="row-actions">
                      {can('org.staff.edit') && <button type="button" className="link-button" onClick={() => setDialog({ kind: 'edit', staff: s })}>编辑</button>}
                      {can('org.staff.edit')&&<button type="button" className="link-button" onClick={()=>setTestStaff(s)}>发送飞书通知</button>}
                      {user?.permissions.isCompanyAdmin&&<button type="button" className="link-button danger-text" onClick={()=>setUnbindStaff(s)}>解绑飞书</button>}
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
        <div className="card-foot"><span>共 {shown.length} 人{showDisabled ? '' : `（在职 ${staff.filter((x) => (x.employmentType??'regular')==='regular'&&x.status === 'active').length}，停用 ${staff.filter((x) => (x.employmentType??'regular')==='regular'&&x.status !== 'active').length} 人已隐藏）`}</span></div>
      </div>

      {dialog?.kind === 'edit' && dialog.staff && <StaffEditorDialog id={dialog.staff.id} onClose={() => setDialog(null)} onSaved={() => void done()} />}
      {dialog?.kind === 'edit' && !dialog.staff && (
        <StaffDialog regularOnly staff={dialog.staff} defaultDepartmentId={entry.dept ? Number(entry.dept) : null} all={staff} canSalary={can('org.staff.salary')} departments={tree} positions={positions} onClose={() => setDialog(null)}
          onSaved={async (created) => { await reload(); setDialog(created ? { kind: 'password', title: '员工已创建', account: created.account, password: created.password } : null); }} />
      )}
      {dialog?.kind === 'perm' && (
        <OverridesDialog staff={dialog.staff} position={positions.find((p) => p.id === dialog.staff.positionId) ?? null} catalog={catalog} onClose={() => setDialog(null)} onSaved={() => void done()} />
      )}
      {dialog?.kind === 'reset' && (
        <ConfirmDialog title={`重置「${dialog.staff.name}」的密码`} text="会生成新的临时密码，原密码立即失效，对方下次登录必须改密码。" confirmLabel="重置" onClose={() => setDialog(null)}
          onConfirm={async () => { const r = await orgApi.resetPassword(dialog.staff.id); setDialog({ kind: 'password', title: '密码已重置', account: dialog.staff.account, password: r.password }); }} />
      )}
      {dialog?.kind === 'import' && <StaffImportDialog onClose={() => setDialog(null)} onDone={() => void reload()} />}
      {dialog?.kind === 'records' && <StaffRecordsDialog staff={dialog.staff} all={staff} canHandover={can('org.staff.disable')} canSalary={can('org.staff.salary')} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'disable' && <DisableDialog staff={dialog.staff} onClose={() => setDialog(null)} onDone={() => void done()} />}
      {dialog?.kind === 'password' && <PasswordNotice title={dialog.title} account={dialog.account} password={dialog.password} onClose={() => setDialog(null)} />}
    </div>
  );
}
