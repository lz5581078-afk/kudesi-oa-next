import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import type { CatalogGroup } from '@kudesi/shared';
import { orgApi, flattenDepartments, LEVEL_LABELS, WORKSPACE_LABELS, DUTY_CATEGORIES, type DepartmentNode, type DutyDto, type PositionDto, type PositionLevel, type PositionProfile } from './orgApi';
import { ConfirmDialog, PositionDialog, errText } from './OrgDialogs';
import { DutyDialog } from './DutyDialog';

/** 旧版岗位档案详情前五个分区（其余分类收进“其他条目”） */
const MAIN_SECTIONS: Array<[string, string]> = [
  ['岗位职责', '岗位日常负责什么，完成到什么程度。'],
  ['入职培训', '新人入职后必须学习、交接和确认的内容。'],
  ['绩效考核', '岗位的考核口径、指标和评分说明。'],
  ['监督规则', '哪些事项超时、异常、无人处理时需要由该岗位兜底。'],
  ['流程节点说明', '该岗位在流程里常见的审批、执行、确认节点。'],
];
const OTHER_SECTIONS = DUTY_CATEGORIES.filter((c) => !MAIN_SECTIONS.some(([m]) => m === c));

type Dlg = { kind: 'duty'; duty: DutyDto | null; category: string } | { kind: 'off'; duty: DutyDto } | { kind: 'del'; duty: DutyDto } | { kind: 'status' } | { kind: 'perm' } | null;

/** 岗位档案详情（旧版整页）：头部（返回列表/编辑）→ 左：基础信息可就地编辑、五类条目分区、操作记录；右：在岗人员、岗位权限、快速摘要。 */
export function PositionDetail({ id, tree, positions, catalog, canEdit, onBack, onChanged }: {
  id: number; tree: DepartmentNode[]; positions: PositionDto[]; catalog: CatalogGroup[]; canEdit: boolean; onBack: () => void; onChanged: () => void;
}) {
  const [p, setP] = useState<PositionProfile | null>(null);
  const [error, setError] = useState('');
  const [dlg, setDlg] = useState<Dlg>(null);
  const [showOff, setShowOff] = useState(false);
  const [editing, setEditing] = useState(false);
  const load = useCallback(() => { orgApi.positionProfile(id).then((d) => { setP(d); setError(''); }).catch((e) => setError(errText(e))); }, [id]);
  useEffect(() => { setP(null); setEditing(false); load(); }, [load]);
  const done = () => { setDlg(null); load(); onChanged(); };
  const permName = useMemo(() => {
    const m = new Map<string, { label: string; group: string }>();
    for (const g of catalog) for (const i of g.items) m.set(i.key, { label: i.label, group: g.label });
    return m;
  }, [catalog]);
  if (error && !p) return <div role="alert" className="notice error">{error}</div>;
  if (!p) return <p className="muted pad">加载中…</p>;
  const pos = p.position;
  const listPos = positions.find((x) => x.id === id);

  const summary = (cat: string) => { const rows = p.duties.filter((d) => d.category === cat && d.status === 'active'); return rows.length ? rows.map((d) => d.title).join('、') : '未设置'; };
  const section = (cat: string, subtitle: string) => {
    const rows = p.duties.filter((d) => d.category === cat && (showOff || d.status === 'active'));
    return (
      <section key={cat} className="card pad pd-section" aria-label={cat}>
        <div className="between">
          <div><h3 className="section-title">{cat}</h3><small className="muted">{subtitle}</small></div>
          {canEdit && <button type="button" className="secondary-button small" onClick={() => setDlg({ kind: 'duty', duty: null, category: cat })}>＋ 新增</button>}
        </div>
        {rows.length === 0 && <p className="muted">暂无{cat}。这里的内容会成为流程、任务、培训和考核的岗位依据。</p>}
        {rows.map((d) => (
          <article key={d.id} className={`line-item col pd-duty${d.status === 'inactive' ? ' inactive' : ''}`}>
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
            <small className="muted">{[d.frequency && `频率：${d.frequency}`, d.relatedModule && `关联：${d.relatedModule}`, d.completionStandard && `完成标准：${d.completionStandard}`].filter(Boolean).join(' · ') || '无周期 · 未绑定模块'}</small>
          </article>
        ))}
      </section>
    );
  };

  return (
    <div className="pd-page">
      <header className="pd-hero">
        <div>
          <h2>{pos.name}{pos.status === 'inactive' && <span className="pill warn"> 已停用</span>}</h2>
          <small className="muted">{pos.departmentName ?? '未分配部门'} · {LEVEL_LABELS[pos.level]} · {WORKSPACE_LABELS[pos.workspaceType] ?? pos.workspaceType} · 岗位资料、职责和记录</small>
        </div>
        <div className="row-actions">
          <button type="button" className="secondary-button small" onClick={onBack}>返回列表</button>
          {canEdit && !editing && <button type="button" className="primary-button small" onClick={() => setEditing(true)}>编辑</button>}
          {canEdit && <button type="button" className="secondary-button small" onClick={() => setDlg({ kind: 'status' })}>{pos.status === 'inactive' ? '启用岗位' : '停用岗位'}</button>}
        </div>
      </header>
      {error && <div role="alert" className="notice error">{error}</div>}
      <div className="pd-layout">
        <div className="pd-main">
          <section className="card pad" aria-label="岗位基础信息">
            <div className="between"><div><h3 className="section-title">岗位基础信息</h3><small className="muted">岗位是流程审批、任务派发、权限继承和人员交接的核心依据。</small></div></div>
            {editing
              ? <BaseForm pos={pos} listPos={listPos} tree={tree} positions={positions} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); done(); }} />
              : (
                <dl className="kv pd-kv">
                  <dt>岗位名称</dt><dd>{pos.name}</dd>
                  <dt>岗位编码</dt><dd>{pos.positionKey || '—'}</dd>
                  <dt>所属部门</dt><dd>{pos.departmentName ?? '—'}</dd>
                  <dt>岗位层级</dt><dd>{LEVEL_LABELS[pos.level]}</dd>
                  <dt>岗位类型</dt><dd>{WORKSPACE_LABELS[pos.workspaceType] ?? pos.workspaceType}<small className="muted"> 决定默认工作台，不靠名称猜测</small></dd>
                  <dt>上级岗位</dt><dd>{pos.supervisorPositionName ?? '—'}</dd>
                  <dt>状态</dt><dd>{pos.status === 'active' ? '启用' : '已停用'}</dd>
                  <dt>岗位说明</dt><dd>{pos.description || '—'}</dd>
                </dl>
              )}
          </section>
          <label className="check-line"><input type="checkbox" checked={showOff} onChange={(e) => setShowOff(e.target.checked)} />显示已停用条目</label>
          {MAIN_SECTIONS.map(([c, sub]) => section(c, sub))}
          {(showOff || p.duties.some((d) => OTHER_SECTIONS.includes(d.category as never) && d.status === 'active')) && OTHER_SECTIONS.map((c) => section(c, '其他岗位条目'))}
          {!showOff && !p.duties.some((d) => OTHER_SECTIONS.includes(d.category as never) && d.status === 'active') && canEdit && <p className="muted">日常工作、周期工作、审批职责、资料维护等条目，在任一分区点“新增”后选择对应分类即可。</p>}
          <section className="card pad" aria-label="操作记录">
            <h3 className="section-title">操作记录</h3><small className="muted">岗位和岗位条目的创建、编辑、删除都会留痕。</small>
            {p.logs.length === 0 && <p className="muted">暂无</p>}
            {p.logs.map((l) => (
              <div key={l.id} className="line-item col">
                <span>{l.action}</span>
                <small className="muted">{l.actorName ?? '系统'} · {new Date(l.createdAt).toLocaleString('zh-CN')}</small>
              </div>
            ))}
          </section>
        </div>
        <aside className="pd-side">
          <section className="card pad" aria-label="当前在岗人员">
            <h3 className="section-title">当前在岗人员（{p.staff.filter((s) => s.status === 'active').length}）</h3>
            {p.staff.length === 0 && <p className="muted">暂无在岗人员，到员工页给员工绑定这个岗位。</p>}
            {p.staff.map((s) => <div key={s.id} className="line-item">{s.name}{s.concurrent && <span className="pill"> 兼任</span>}{s.status !== 'active' && <span className="pill warn"> 已停用</span>}</div>)}
          </section>
          <section className="card pad" aria-label="岗位权限">
            <div className="between"><h3 className="section-title">岗位权限（{p.permissions.length}）</h3>{canEdit && listPos && <button type="button" className="link-button" onClick={() => setDlg({ kind: 'perm' })}>编辑与授权</button>}</div>
            {p.permissions.length === 0 && <p className="muted">暂无岗位权限。员工可在个人权限里追加。</p>}
            <ul className="plain-list pd-perms">{p.permissions.map((k) => { const n = permName.get(k); return <li key={k} className="line-item col"><span>{n?.label ?? k}</span><small className="muted">{n?.group ?? '权限'} · {k}</small></li>; })}</ul>
          </section>
          <section className="card pad" aria-label="快速摘要">
            <h3 className="section-title">快速摘要</h3>
            {MAIN_SECTIONS.map(([c]) => <div key={c} className="line-item col"><span>{c}</span><small className="muted">{summary(c)}</small></div>)}
          </section>
        </aside>
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
      {dlg?.kind === 'perm' && listPos && <PositionDialog position={listPos} departments={tree} catalog={catalog} canEditPerms={canEdit} onClose={() => setDlg(null)} onSaved={done} />}
    </div>
  );
}

/** 基础信息就地编辑（旧版“编辑”按钮把每一行变成输入框）。 */
function BaseForm({ pos, listPos, tree, positions, onCancel, onSaved }: { pos: PositionProfile['position']; listPos?: PositionDto; tree: DepartmentNode[]; positions: PositionDto[]; onCancel: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: pos.name, positionKey: pos.positionKey ?? listPos?.positionKey ?? '', departmentId: pos.departmentId, workspaceType: pos.workspaceType, level: pos.level as PositionLevel, supervisorPositionId: pos.supervisorPositionId, description: pos.description ?? '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const num = (v: string) => (v ? Number(v) : null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!f.name.trim()) return setError('请填写岗位名称');
    setBusy(true);
    try {
      await orgApi.updatePosition(pos.id, { name: f.name.trim(), positionKey: f.positionKey.trim() || null, departmentId: f.departmentId, workspaceType: f.workspaceType, level: f.level, supervisorPositionId: f.supervisorPositionId, description: f.description.trim() || null });
      onSaved();
    } catch (err) { setError(errText(err)); setBusy(false); }
  }
  return (
    <form onSubmit={submit} className="pd-edit">
      <div className="form-grid">
        <label>岗位名称<input value={f.name} maxLength={100} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label>岗位编码<input value={f.positionKey} maxLength={64} placeholder="选填，同一部门内不重复" onChange={(e) => setF({ ...f, positionKey: e.target.value })} /></label>
        <label>所属部门
          <select value={f.departmentId ?? ''} onChange={(e) => setF({ ...f, departmentId: num(e.target.value) })}>
            <option value="">（不属于任何部门）</option>
            {flattenDepartments(tree).map((d) => <option key={d.id} value={d.id}>{'　'.repeat(d.depth)}{d.name}</option>)}
          </select>
        </label>
        <label>岗位层级
          <select value={f.level} onChange={(e) => setF({ ...f, level: e.target.value as PositionLevel })}>{Object.entries(LEVEL_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
        <label>岗位类型
          <select value={f.workspaceType} onChange={(e) => setF({ ...f, workspaceType: e.target.value })}>{Object.entries(WORKSPACE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
        <label>上级岗位
          <select value={f.supervisorPositionId ?? ''} onChange={(e) => setF({ ...f, supervisorPositionId: num(e.target.value) })}>
            <option value="">（无）</option>
            {positions.filter((x) => x.id !== pos.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </label>
      </div>
      <label>岗位说明<textarea rows={2} maxLength={1000} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
      {error && <div role="alert" className="notice error">{error}</div>}
      <div className="row-actions"><button type="submit" className="primary-button small" disabled={busy}>保存岗位</button><button type="button" className="secondary-button small" onClick={onCancel}>取消</button></div>
    </form>
  );
}
