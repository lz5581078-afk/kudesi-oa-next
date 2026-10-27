import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { createChecker } from '@kudesi/shared';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../api/client';
import { orgApi, flattenDepartments, LEVEL_LABELS, WORKSPACE_LABELS, DUTY_CATEGORIES, type DepartmentNode, type DutyDto, type PositionDto, type PositionProfile } from './orgApi';
import { ConfirmDialog } from './StructurePage';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : '操作失败');

function DutyDialog({ positionId, duty, category, onClose, onSaved }: { positionId: number; duty: DutyDto | null; category: string; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    category: duty?.category ?? category, title: duty?.title ?? '', description: duty?.description ?? '', frequency: duty?.frequency ?? '',
    relatedModule: duty?.relatedModule ?? '', completionStandard: duty?.completionStandard ?? '', isKey: duty?.isKey ?? false,
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!f.title.trim()) return setError('请填写标题');
    setBusy(true);
    try {
      if (duty) await orgApi.updateDuty(duty.id, f); else await orgApi.addDuty(positionId, f);
      onSaved();
    } catch (err) { setError(errText(err)); setBusy(false); }
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal card" role="dialog" aria-label={duty ? '编辑条目' : '新增条目'} onSubmit={submit}>
        <div className="modal-head"><strong>{duty ? '编辑条目' : '新增条目'}</strong></div>
        <div className="modal-body">
          <div className="form-grid">
            <label>分类<select value={f.category} onChange={(e) => set('category', e.target.value)}>{DUTY_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></label>
            <label>标题<input autoFocus value={f.title} maxLength={150} onChange={(e) => set('title', e.target.value)} /></label>
            <label>频率<input value={f.frequency} maxLength={60} placeholder="如：每日 / 每周一" onChange={(e) => set('frequency', e.target.value)} /></label>
            <label>关联模块<input value={f.relatedModule} maxLength={60} onChange={(e) => set('relatedModule', e.target.value)} /></label>
          </div>
          <label>说明<textarea rows={3} maxLength={1000} value={f.description} onChange={(e) => set('description', e.target.value)} /></label>
          <label>完成标准<textarea rows={2} maxLength={1000} value={f.completionStandard} onChange={(e) => set('completionStandard', e.target.value)} /></label>
          <label className="check-line"><input type="checkbox" checked={f.isKey} onChange={(e) => set('isKey', e.target.checked)} />重点条目</label>
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

function Detail({ id, canEdit, onChanged }: { id: number; canEdit: boolean; onChanged: () => void }) {
  const [p, setP] = useState<PositionProfile | null>(null);
  const [error, setError] = useState('');
  const [dlg, setDlg] = useState<{ kind: 'duty'; duty: DutyDto | null; category: string } | { kind: 'off'; duty: DutyDto } | { kind: 'del'; duty: DutyDto } | { kind: 'status' } | null>(null);
  const [showOff, setShowOff] = useState(false);
  const load = useCallback(() => { orgApi.positionProfile(id).then((d) => { setP(d); setError(''); }).catch((e) => setError(errText(e))); }, [id]);
  useEffect(() => { setP(null); load(); }, [load]);
  const done = () => { setDlg(null); load(); onChanged(); };
  if (error) return <div role="alert" className="notice error">{error}</div>;
  if (!p) return <p className="muted pad">加载中…</p>;
  const pos = p.position;
  return (
    <div>
      <section className="card pad">
        <div className="between">
          <h2 className="section-title">{pos.name}{pos.status === 'inactive' && <span className="pill warn"> 已停用</span>}</h2>
          {canEdit && <button type="button" className="secondary-button small" onClick={() => setDlg({ kind: 'status' })}>{pos.status === 'inactive' ? '启用岗位' : '停用岗位'}</button>}
        </div>
        <dl className="kv">
          <dt>所属部门</dt><dd>{pos.departmentName ?? '—'}</dd>
          <dt>岗位层级</dt><dd>{LEVEL_LABELS[pos.level]}</dd>
          <dt>上级岗位</dt><dd>{pos.supervisorPositionName ?? '—'}</dd>
          <dt>默认工作台</dt><dd>{WORKSPACE_LABELS[pos.workspaceType] ?? pos.workspaceType}</dd>
          <dt>岗位说明</dt><dd>{pos.description || '—'}</dd>
        </dl>
      </section>
      <div className="two-col">
        <div>
          <label className="check-line"><input type="checkbox" checked={showOff} onChange={(e) => setShowOff(e.target.checked)} />显示已停用条目</label>
          {DUTY_CATEGORIES.map((cat) => {
            const rows = p.duties.filter((d) => d.category === cat && (showOff || d.status === 'active'));
            return (
              <section key={cat} className="card pad">
                <div className="between">
                  <h3 className="section-title">{cat}</h3>
                  {canEdit && <button type="button" className="link-button" onClick={() => setDlg({ kind: 'duty', duty: null, category: cat })}>＋ 添加</button>}
                </div>
                {rows.length === 0 && <p className="muted">暂无条目</p>}
                {rows.map((d) => (
                  <div key={d.id} className="line-item col">
                    <div className="between">
                      <strong>{d.isKey && <span className="pill ok">重点 </span>}{d.title}{d.status === 'inactive' && <span className="pill warn"> 已停用</span>}</strong>
                      {canEdit && (
                        <span className="row-actions">
                          <button type="button" className="link-button" onClick={() => setDlg({ kind: 'duty', duty: d, category: d.category })}>编辑</button>
                          {d.status === 'active'
                            ? <button type="button" className="link-button danger-text" onClick={() => setDlg({ kind: 'off', duty: d })}>停用</button>
                            : <button type="button" className="link-button" onClick={() => void orgApi.updateDuty(d.id, { status: 'active' }).then(done).catch((e) => setError(errText(e)))}>启用</button>}
                          <button type="button" className="link-button danger-text" onClick={() => setDlg({ kind: 'del', duty: d })}>删除</button>
                        </span>
                      )}
                    </div>
                    {d.description && <span>{d.description}</span>}
                    <small className="muted">{[d.frequency && `频率：${d.frequency}`, d.relatedModule && `关联：${d.relatedModule}`, d.completionStandard && `完成标准：${d.completionStandard}`].filter(Boolean).join(' · ')}</small>
                  </div>
                ))}
              </section>
            );
          })}
        </div>
        <div>
          <section className="card pad">
            <h3 className="section-title">在岗人员（{p.staff.filter((s) => s.status === 'active').length}）</h3>
            {p.staff.length === 0 && <p className="muted">暂无</p>}
            {p.staff.map((s) => <div key={s.id} className="line-item">{s.name}{s.concurrent && <span className="pill"> 兼任</span>}{s.status !== 'active' && <span className="pill warn"> 已停用</span>}</div>)}
          </section>
          <section className="card pad">
            <h3 className="section-title">岗位权限摘要</h3>
            <p className="muted">共 {p.permissions.length} 项权限，在「部门与岗位」里编辑与授权。</p>
            <small>{p.permissions.slice(0, 12).join('、')}{p.permissions.length > 12 ? ' …' : ''}</small>
          </section>
          <section className="card pad">
            <h3 className="section-title">变更记录</h3>
            {p.logs.length === 0 && <p className="muted">暂无</p>}
            {p.logs.map((l) => (
              <div key={l.id} className="line-item col">
                <span>{l.action}</span>
                <small className="muted">{l.actorName ?? '系统'} · {new Date(l.createdAt).toLocaleString('zh-CN')}</small>
              </div>
            ))}
          </section>
        </div>
      </div>
      {dlg?.kind === 'duty' && <DutyDialog positionId={id} duty={dlg.duty} category={dlg.category} onClose={() => setDlg(null)} onSaved={done} />}
      {dlg?.kind === 'off' && (
        <ConfirmDialog title={`停用条目「${dlg.duty.title}」`} text="停用后不再显示，变更记录保留，可随时启用。" confirmLabel="确认停用" reasonLabel="停用原因" onClose={() => setDlg(null)}
          onConfirm={async (reason) => { await orgApi.updateDuty(dlg.duty.id, { status: 'inactive', reason }); done(); }} />
      )}
      {dlg?.kind === 'del' && (
        <ConfirmDialog title={`删除条目「${dlg.duty.title}」`} text="删除后不能恢复，操作记录会保留。只是暂时不用时请选择停用。" confirmLabel="删除条目" onClose={() => setDlg(null)}
          onConfirm={async () => { await orgApi.deleteDuty(dlg.duty.id); done(); }} />
      )}
      {dlg?.kind === 'status' && (
        <ConfirmDialog title={`${pos.status === 'inactive' ? '启用' : '停用'}岗位「${pos.name}」`} text={pos.status === 'inactive' ? '启用后可重新分配给员工。' : '停用后不能再分配给新员工；已在岗的人员不受影响。'} confirmLabel="确认" reasonLabel="原因" onClose={() => setDlg(null)}
          onConfirm={async (reason) => { await orgApi.updatePosition(id, { status: pos.status === 'inactive' ? 'active' : 'inactive', reason }); done(); }} />
      )}
    </div>
  );
}

export function PositionProfilesPage() {
  const { user } = useAuth();
  const can = user ? createChecker(user.permissions) : () => false;
  const [positions, setPositions] = useState<PositionDto[]>([]);
  const [tree, setTree] = useState<DepartmentNode[]>([]);
  const [keyword, setKeyword] = useState('');
  const [dept, setDept] = useState('');
  const [level, setLevel] = useState('');
  const [status, setStatus] = useState('active');
  const [vacantOnly, setVacantOnly] = useState(false);
  const [sel, setSel] = useState<number | null>(null);
  const [error, setError] = useState('');
  const reload = useCallback(() => {
    Promise.all([orgApi.positions(), orgApi.departments()]).then(([p, t]) => { setPositions(p); setTree(t); setError(''); }).catch((e) => setError(errText(e)));
  }, []);
  useEffect(reload, [reload]);
  const deptName = useMemo(() => new Map(flattenDepartments(tree).map((d) => [d.id, d.name])), [tree]);
  const shown = positions.filter((p) =>
    (!keyword.trim() || p.name.includes(keyword.trim())) && (!dept || String(p.departmentId) === dept) && (!level || p.level === level) && (!status || p.status === status) && (!vacantOnly || (p.status === 'active' && p.userCount === 0)));
  const posName = new Map(positions.map((p) => [p.id, p.name]));
  return (
    <div>
      <div className="page-head"><h1>岗位档案</h1></div>
      {error && <div role="alert" className="notice error">{error}</div>}
      <div className="card">
        <div className="toolbar">
          <input type="search" aria-label="搜索岗位" placeholder="按岗位名称搜索" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
          <select aria-label="部门" value={dept} onChange={(e) => setDept(e.target.value)}>
            <option value="">全部部门</option>
            {flattenDepartments(tree).map((d) => <option key={d.id} value={d.id}>{'　'.repeat(d.depth)}{d.name}</option>)}
          </select>
          <select aria-label="层级" value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="">全部层级</option>
            {Object.entries(LEVEL_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select aria-label="状态" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">全部状态</option><option value="active">启用</option><option value="inactive">已停用</option>
          </select>
          <button type="button" className={vacantOnly ? 'chip active' : 'chip'} aria-pressed={vacantOnly} onClick={() => setVacantOnly((v) => !v)}>无人在岗 {positions.filter((p) => p.status === 'active' && p.userCount === 0).length}</button>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>岗位</th><th>部门</th><th>层级</th><th>上级岗位</th><th>在岗人数</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.id} className={sel === p.id ? 'selected' : undefined}>
                  <td>{p.name}</td><td>{p.departmentId ? deptName.get(p.departmentId) ?? '—' : '—'}</td><td>{LEVEL_LABELS[p.level]}</td><td>{p.supervisorPositionId ? posName.get(p.supervisorPositionId) ?? '—' : '—'}</td><td>{p.userCount}</td>
                  <td><span className={p.status === 'active' ? 'pill ok' : 'pill warn'}>{p.status === 'active' ? '启用' : '已停用'}</span></td>
                  <td><button type="button" className="link-button" onClick={() => setSel(p.id)}>查看档案</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {shown.length === 0 && <p className="muted pad">没有符合条件的岗位</p>}
      </div>
      {sel !== null && <Detail id={sel} canEdit={can('org.structure.edit')} onChanged={reload} />}
    </div>
  );
}
