import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../api/client';
import { orgApi, type DepartmentNode } from '../org/orgApi';
import { designerApi, type DirectoryRow } from './designerApi';
import { fmtTime } from './flowApi';

const PAGE = 20;
type Filters = { dept: string; q: string; kind: string; status: string };
const KEY = 'flow.directory.filters';
const loadFilters = (): Filters => {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? '{}'); return { dept: v.dept ?? 'all', q: '', kind: v.kind ?? 'all', status: v.status ?? 'all' }; } catch { return { dept: 'all', q: '', kind: 'all', status: 'all' }; }
};

const subtreeIds = (nodes: DepartmentNode[], id: number): number[] => {
  const find = (list: DepartmentNode[]): DepartmentNode | null => { for (const n of list) { if (n.id === id) return n; const f = find(n.children); if (f) return f; } return null; };
  const root = find(nodes);
  const out: number[] = [];
  const walk = (n: DepartmentNode) => { out.push(n.id); n.children.forEach(walk); };
  if (root) walk(root);
  return out;
};

/** 流程目录：左侧部门树，右侧流程列表（搜索/类型/状态筛选），每行有配置检查和复制、停用、删除。 */
export function FlowDirectory({ onOpen }: { onOpen: (key: string) => void }) {
  const [rows, setRows] = useState<DirectoryRow[] | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [depts, setDepts] = useState<DepartmentNode[]>([]);
  const [f, setF] = useState<Filters>(loadFilters);
  const [collapsed, setCollapsed] = useState<number[]>([]);
  const [page, setPage] = useState(1);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState<{ kind: 'new' } | { kind: 'copy'; row: DirectoryRow } | { kind: 'stop'; row: DirectoryRow } | { kind: 'delete'; row: DirectoryRow } | null>(null);

  const load = () => { setErr(''); return designerApi.directory().then((d) => { setRows(d.templates); setCanManage(d.canManage); }).catch((e) => setErr(e instanceof ApiError ? e.message : '加载失败')); };
  useEffect(() => { void load(); orgApi.departments().then(setDepts).catch(() => undefined); }, []);
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify({ dept: f.dept, kind: f.kind, status: f.status })); } catch { /* 记不住就算了 */ } }, [f.dept, f.kind, f.status]);

  const matchDept = (r: DirectoryRow, dept: string) => {
    if (dept === 'all') return true;
    if (dept === 'common') return !r.departmentId;
    return !!r.departmentId && subtreeIds(depts, Number(dept)).includes(r.departmentId);
  };
  const count = (dept: string) => (rows ?? []).filter((r) => matchDept(r, dept)).length;
  const shown = useMemo(() => (rows ?? []).filter((r) => matchDept(r, f.dept)
    && (f.kind === 'all' || (f.kind === 'custom') === r.custom)
    && (f.status === 'all' || r.status === f.status)
    && `${r.label} ${r.departmentName || '全公司通用'}`.toLowerCase().includes(f.q.trim().toLowerCase())), [rows, f, depts]);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  const cur = Math.min(page, pages);
  const set = (patch: Partial<Filters>) => { setF((x) => ({ ...x, ...patch })); setPage(1); };
  const title = f.dept === 'all' ? '全部流程' : f.dept === 'common' ? '全公司通用' : depts.length ? (flat(depts).find((d) => String(d.id) === f.dept)?.name ?? '部门流程') : '部门流程';
  const filtered = f.q !== '' || f.kind !== 'all' || f.status !== 'all';

  const tree = (nodes: DepartmentNode[]) => (
    <ul className="fd-tree">{nodes.filter((n) => n.status === 'active').map((n) => {
      const closed = collapsed.includes(n.id);
      return (
        <li key={n.id}>
          <div className={f.dept === String(n.id) ? 'selected' : ''}>
            {n.children.length > 0 ? <button type="button" className="fd-toggle" aria-label={`${closed ? '展开' : '收起'}${n.name}`} aria-expanded={!closed} onClick={() => setCollapsed((c) => (closed ? c.filter((x) => x !== n.id) : [...c, n.id]))}>{closed ? '▸' : '▾'}</button> : <span className="fd-toggle" />}
            <button type="button" className="tree-item" aria-current={f.dept === String(n.id) ? 'page' : undefined} onClick={() => set({ dept: String(n.id) })}>{n.name} <small>{count(String(n.id))}</small></button>
          </div>
          {n.children.length > 0 && !closed && tree(n.children)}
        </li>
      );
    })}</ul>
  );

  return (
    <div className="fd-directory">
      <aside className="card fd-deptnav" aria-label="部门目录">
        <h2>部门目录</h2>
        {([['all', '全部流程'], ['common', '全公司通用']] as const).map(([id, name]) => (
          <button key={id} type="button" className={`tree-item ${f.dept === id ? 'active' : ''}`} aria-current={f.dept === id ? 'page' : undefined} onClick={() => set({ dept: id })}>{name} <small>{count(id)}</small></button>
        ))}
        {tree(depts)}
      </aside>
      <section className="card fd-catalog">
        <div className="between" style={{ padding: '12px 16px' }}>
          <h2 style={{ margin: 0 }}>{title}<small className="muted" style={{ marginLeft: 8 }}>{shown.length} 个流程</small></h2>
          <div className="row-actions">
            <button type="button" className="secondary-button" onClick={() => void load()}>刷新</button>
            {canManage && <button type="button" className="primary-button" onClick={() => setDialog({ kind: 'new' })}>新建流程</button>}
          </div>
        </div>
        <div className="toolbar">
          <input type="search" aria-label="搜索流程" placeholder="搜索流程名称、部门" value={f.q} onChange={(e) => set({ q: e.target.value })} />
          <select aria-label="流程类型" value={f.kind} onChange={(e) => set({ kind: e.target.value })}><option value="all">全部类型</option><option value="custom">自建流程</option><option value="builtin">内置业务流程</option></select>
          <select aria-label="启用状态" value={f.status} onChange={(e) => set({ status: e.target.value })}><option value="all">全部状态</option><option value="active">已启用</option><option value="inactive">未启用</option></select>
          {filtered && <button type="button" className="link-button" onClick={() => set({ q: '', kind: 'all', status: 'all' })}>清除筛选</button>}
        </div>
        {notice && <div role="status" className="notice ok m" onClick={() => setNotice('')}>{notice}</div>}
        {err && <div role="alert" className="notice error m">{err} <button type="button" className="link-button" onClick={() => void load()}>重试</button></div>}
        {!rows && !err && <p className="muted m" role="status">正在加载流程…</p>}
        {rows && shown.length === 0 && (
          <div className="empty-state">
            <strong>{rows.length === 0 ? '还没有流程' : '没有符合条件的流程'}</strong>
            {filtered || f.dept !== 'all' ? <button type="button" className="secondary-button" onClick={() => set({ q: '', kind: 'all', status: 'all', dept: 'all' })}>清除筛选，查看全部</button> : canManage ? <button type="button" className="secondary-button" onClick={() => setDialog({ kind: 'new' })}>新建流程</button> : null}
          </div>
        )}
        {rows && shown.length > 0 && (
          <div className="table-scroll"><table className="data-table fd-table">
            <thead><tr><th>流程名称</th><th>所属部门</th><th>类型</th><th>步骤</th><th>状态</th><th>配置检查</th><th>操作</th></tr></thead>
            <tbody>{shown.slice((cur - 1) * PAGE, cur * PAGE).map((r) => (
              <tr key={r.key}>
                <td data-label="流程名称"><button type="button" className="link-button strong" onClick={() => onOpen(r.key)}>{r.label}</button>
                  <div className="muted small">{r.runningCount > 0 ? `${r.runningCount} 条在办` : r.runCount > 0 ? `${r.runCount} 条历史` : '未使用过'}{r.updatedAt ? ` · ${fmtTime(r.updatedAt)}` : ''}</div></td>
                <td data-label="所属部门">{r.departmentName || '全公司通用'}</td>
                <td data-label="类型">{r.kind}</td>
                <td data-label="步骤">{r.stepCount} 个办理步骤</td>
                <td data-label="状态"><span className={`pill ${r.status === 'active' ? 'ok' : ''}`}>{r.status === 'active' ? `已启用 v${r.version}` : '未启用'}</span>{r.hasDraft && <span className="pill warn" style={{ marginLeft: 4 }}>有草稿</span>}</td>
                <td data-label="配置检查">{r.issues.length === 0 ? <span className="ok-text">配置完整</span> : <ul className="plain-list late-text small">{r.issues.map((x) => <li key={x}>{x}</li>)}</ul>}</td>
                <td data-label="操作"><div className="row-actions">
                  <button type="button" className="link-button" onClick={() => onOpen(r.key)}>{canManage ? '配置' : '查看'}</button>
                  {canManage && <button type="button" className="link-button" onClick={() => setDialog({ kind: 'copy', row: r })}>复制</button>}
                  {canManage && r.status === 'active' && <button type="button" className="link-button" onClick={() => setDialog({ kind: 'stop', row: r })}>停用</button>}
                  {canManage && r.custom && <button type="button" className="link-button danger" disabled={r.runCount > 0} title={r.runCount > 0 ? '已有申请或历史记录，请使用停用' : '删除未使用的流程'} onClick={() => setDialog({ kind: 'delete', row: r })}>删除</button>}
                </div></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        {shown.length > PAGE && (
          <div className="pager" style={{ padding: '0 16px 12px' }}>
            <button type="button" className="secondary-button" disabled={cur <= 1} onClick={() => setPage(cur - 1)}>上一页</button>
            <span className="muted">第 {cur} / {pages} 页</span>
            <button type="button" className="secondary-button" disabled={cur >= pages} onClick={() => setPage(cur + 1)}>下一页</button>
          </div>
        )}
      </section>
      {dialog?.kind === 'new' && <NewFlowDialog depts={depts} rows={rows ?? []} initialDept={/^\d+$/.test(f.dept) ? Number(f.dept) : null} onClose={() => setDialog(null)} onDone={(key) => { setDialog(null); onOpen(key); }} />}
      {dialog?.kind === 'copy' && <NewFlowDialog depts={depts} rows={rows ?? []} source={dialog.row} onClose={() => setDialog(null)} onDone={(key) => { setDialog(null); onOpen(key); }} />}
      {dialog?.kind === 'stop' && <Confirm title="停用流程" body={`停用“${dialog.row.label}”后不能再发起新申请；在办的申请照常办理，历史记录保留。`} ok="停用" onClose={() => setDialog(null)} onOk={async () => { await designerApi.deactivate(dialog.row.key); setDialog(null); setNotice(`流程“${dialog.row.label}”已停用`); await load(); }} />}
      {dialog?.kind === 'delete' && <Confirm title="删除流程" danger body={`删除“${dialog.row.label}”？将同时删除它的全部配置版本，删除后无法恢复。`} ok="删除" onClose={() => setDialog(null)} onOk={async () => { await designerApi.remove(dialog.row.key); setDialog(null); setNotice(`流程“${dialog.row.label}”已删除`); await load(); }} />}
    </div>
  );
}

function flat(nodes: DepartmentNode[]): DepartmentNode[] { return nodes.flatMap((n) => [n, ...flat(n.children)]); }

export function Confirm({ title, body, ok, danger, onClose, onOk }: { title: string; body: string; ok: string; danger?: boolean; onClose: () => void; onOk: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal card small" role="alertdialog" aria-label={title}>
        <div className="modal-head"><strong>{title}</strong></div>
        <div className="modal-body">{err && <div role="alert" className="notice error">{err}</div>}<p>{body}</p></div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
          <button type="button" className="primary-button" style={danger ? { background: '#b42318' } : undefined} disabled={busy} onClick={async () => { setBusy(true); setErr(''); try { await onOk(); } catch (e) { setErr(e instanceof ApiError ? e.message : '操作失败'); setBusy(false); } }}>{ok}</button>
        </div>
      </div>
    </div>
  );
}

function NewFlowDialog({ depts, rows, source, initialDept, onClose, onDone }: { depts: DepartmentNode[]; rows: DirectoryRow[]; source?: DirectoryRow; initialDept?: number | null; onClose: () => void; onDone: (key: string) => void }) {
  const [name, setName] = useState(source ? `${source.label}副本` : '');
  const [dept, setDept] = useState<string>(source?.departmentId ? String(source.departmentId) : initialDept ? String(initialDept) : '');
  const [base, setBase] = useState('');
  const [desc, setDesc] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const sourceKey = source?.key ?? (base || null);
  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal card small" role="dialog" aria-label={source ? '复制流程' : '新建流程'} onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr('');
        try { const r = await designerApi.create({ name: name.trim(), description: desc.trim() || undefined, departmentId: dept ? Number(dept) : null, sourceKey }); onDone(r.key); }
        catch (x) { setErr(x instanceof ApiError ? x.message : '创建失败'); setBusy(false); }
      }}>
        <div className="modal-head"><strong>{source ? `复制流程：${source.label}` : '新建流程'}</strong></div>
        <div className="modal-body">
          {err && <div role="alert" className="notice error">{err}</div>}
          <label>流程名称<input autoFocus required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label>所属部门<select value={dept} onChange={(e) => setDept(e.target.value)}><option value="">全公司通用</option>{flat(depts).filter((d) => d.status === 'active').map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
          {!source && (
            <label>基于
              <select value={base} onChange={(e) => setBase(e.target.value)}>
                <option value="">空白流程（发起 → 审批 → 结束）</option>
                {rows.map((r) => <option key={r.key} value={r.key}>复制：{r.label}</option>)}
              </select>
            </label>
          )}
          <label>说明（可选）<textarea rows={2} maxLength={500} value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
          {(source?.custom === false || rows.find((r) => r.key === base)?.custom === false) && <p className="muted small">复制内置业务流程得到的是普通自建流程：保留步骤和表单，但不带业务专属的自动动作（例如自动登记借用记录、规格清单）。</p>}
        </div>
        <div className="modal-foot"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy || !name.trim()}>{busy ? '创建中…' : source ? '复制' : '创建流程'}</button></div>
      </form>
    </div>
  );
}
