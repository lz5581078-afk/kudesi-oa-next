import './positionProfiles.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createChecker, resourceDescription } from '@kudesi/shared';
import type { CatalogGroup } from '@kudesi/shared';
import { useAuth } from '../../auth/AuthContext';
import { AppbarHint, useAppbarBare, useHasAppbarSlot } from '../../layout/AppbarSlot';
import { PageHint } from '../../resources/PageHint';
import { SearchGlyph } from '../../resources/ResIcons';
import { orgApi, flattenDepartments, LEVEL_LABELS, WORKSPACE_LABELS, type DepartmentNode, type PositionDto } from './orgApi';
import { ConfirmDialog, PositionDialog, errText } from './OrgDialogs';
import { EnrollmentInviteDialog } from './EnrollmentInviteDialog';
import { CashierWithdrawalDialog } from './CashierWithdrawalDialog';
import { DeskAccessDialog } from './DeskAccessDialog';
import { PositionDetail } from './PositionDetail';

/** 岗位类型（positions.workspace_type 显式字段）对应的默认工作台名称；空白类型没有默认工作台 */
const deskLabel = (t: string) => (t === 'blank' ? '无' : `${(WORKSPACE_LABELS[t] ?? t)}工作台`);

/** 岗位档案（旧版）：左侧部门列表，右侧岗位列表或档案；部门选择包含下级，查看档案保留部门导航。 */
export function PositionProfilesPage() {
  const { user } = useAuth();
  const can = user ? createChecker(user.permissions) : () => false;
  const canEdit = can('org.structure.edit');
  const [positions, setPositions] = useState<PositionDto[]>([]);
  const [tree, setTree] = useState<DepartmentNode[]>([]);
  const [catalog, setCatalog] = useState<CatalogGroup[]>([]);
  const [keyword, setKeyword] = useState('');
  const [dept, setDept] = useState('');
  const [deptKeyword,setDeptKeyword]=useState('');
  const [level, setLevel] = useState('');
  const [status, setStatus] = useState('active');
  const [vacantOnly, setVacantOnly] = useState(false);
  const [sel, setSel] = useState<number | null>(null);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [dlg, setDlg] = useState<{ kind: 'new' } | { kind: 'stop'; p: PositionDto } | { kind: 'del'; p: PositionDto } | null>(null);
  const [invite, setInvite] = useState<{ position?: { id: number; name: string } } | null>(null);
  const [error, setError] = useState('');
  const [cashierOpen, setCashierOpen] = useState(false);
  const [deskAccessOpen, setDeskAccessOpen] = useState(false);
  useAppbarBare();
  const hasSlot = useHasAppbarSlot();
  const hint = <PageHint text={resourceDescription('position-profiles') || '岗位不只是一个名称，它还承接职责、培训、绩效、监督规则和流程节点说明。'} />;
  const reload = useCallback(() => {
    Promise.all([orgApi.positions(), orgApi.departments(), orgApi.catalog().catch(() => [] as CatalogGroup[])]).then(([p, t, c]) => { setPositions(p); setTree(t); setCatalog(c); setError(''); }).catch((e) => setError(errText(e)));
  }, []);
  useEffect(reload, [reload]);
  const flat = useMemo(() => flattenDepartments(tree), [tree]);
  const posName = useMemo(() => new Map(positions.map((p) => [p.id, p.name])), [positions]);
  // 选了上级部门，也包含它的下级部门里的岗位
  const deptScope = useMemo(() => {
    if (!dept || dept==='none') return null;
    const ids = new Set<number>();
    const walk = (nodes: DepartmentNode[], inside: boolean) => { for (const n of nodes) { const hit = inside || String(n.id) === dept; if (hit) ids.add(n.id); walk(n.children, hit); } };
    walk(tree, false);
    return ids;
  }, [dept, tree]);
  const kw = keyword.trim().toLowerCase();
  const filtered = positions.filter((p) =>
    (!kw || `${p.name}${p.positionKey ?? ''}${p.description ?? ''}${WORKSPACE_LABELS[p.workspaceType] ?? ''}${flat.find((d) => d.id === p.departmentId)?.name ?? ''}`.toLowerCase().includes(kw))
    && (!level || p.level === level) && (!status || p.status === status) && (!vacantOnly || (p.status === 'active' && p.userCount === 0)));
  const shown=filtered.filter(p=>dept==='none'?p.departmentId===null:!deptScope||(p.departmentId!==null&&deptScope.has(p.departmentId)));
  const countDepartment=(id:number)=>{const ids=new Set<number>();const walk=(nodes:DepartmentNode[],inside:boolean)=>{for(const n of nodes){const hit=inside||n.id===id;if(hit)ids.add(n.id);walk(n.children,hit);}};walk(tree,false);return filtered.filter(p=>p.departmentId!==null&&ids.has(p.departmentId)).length;};
  const selectDepartment=(value:string)=>{setDept(value);setSel(null);};
  const groups = [
    ...flat.map((d) => ({ key: String(d.id), name: d.name, depth: d.depth, rows: shown.filter((p) => p.departmentId === d.id) })),
    { key: 'none', name: '未分配部门', depth: 0, rows: shown.filter((p) => p.departmentId == null) },
  ].filter((g) => g.rows.length > 0);
  const toggle = (k: string) => setFolded((cur) => { const n = new Set(cur); if (n.has(k)) n.delete(k); else n.add(k); return n; });


  return (
    <div className="res-page org-page pp-page">
      {hasSlot ? <AppbarHint>{hint}</AppbarHint> : null}
      <div className="org-body pp-body">
        <aside className="org-side pp-departments" aria-label="岗位部门列表">
          <div className="org-side-head"><strong>部门</strong><small className="muted">{flat.length} 个部门</small></div>
          <input type="search" aria-label="搜索岗位部门" placeholder="搜索部门" value={deptKeyword} onChange={e=>setDeptKeyword(e.target.value)}/>
          <nav className="pp-dept-list" aria-label="选择部门">
            <button type="button" className="pp-dept" aria-pressed={!dept} onClick={()=>selectDepartment('')}><span>全部部门</span><small>{filtered.length}</small></button>
            {flat.filter(d=>!deptKeyword.trim()||d.name.toLowerCase().includes(deptKeyword.trim().toLowerCase())).map(d=><button type="button" key={d.id} className="pp-dept" style={{paddingLeft:12+d.depth*16}} aria-pressed={dept===String(d.id)} onClick={()=>selectDepartment(String(d.id))}><span>{d.name}</span><small>{countDepartment(d.id)}</small></button>)}
            {deptKeyword.trim()&&!flat.some(d=>d.name.toLowerCase().includes(deptKeyword.trim().toLowerCase()))&&<p role="status" className="muted pad">没有匹配的部门</p>}
            <button type="button" className="pp-dept" aria-pressed={dept==='none'} onClick={()=>selectDepartment('none')}><span>未分配部门</span><small>{filtered.filter(p=>p.departmentId===null).length}</small></button>
          </nav>
        </aside>
        <main className="org-main pp-content" aria-label="岗位内容">
        {sel!==null?<PositionDetail key={sel} id={sel} tree={tree} positions={positions} catalog={catalog} canEdit={canEdit} onEnroll={can('org.staff.create') ? () => { const p = positions.find(p => p.id === sel); if (p) setInvite({ position: p }); } : undefined} onBack={()=>setSel(null)} onChanged={reload}/>:<>
      <section className="res-main pp-main" aria-label="岗位档案列表">
        <div className="pp-content-head"><strong>{dept==='none'?'未分配部门':dept?flat.find(d=>String(d.id)===dept)?.name??'部门岗位':'全部岗位'}</strong><small className="muted">{shown.length} 个岗位{dept&&dept!=='none'?' · 包含下级部门':''}</small></div>
        <fieldset className="res-tools">
          <div className="res-bar">
            <span className="res-search">
              <SearchGlyph />
              <input type="search" aria-label="搜索岗位" placeholder="搜索岗位、部门、岗位类型、说明" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
            </span>
            <select aria-label="层级" value={level} onChange={(e) => setLevel(e.target.value)}>
              <option value="">全部层级</option>
              {Object.entries(LEVEL_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <select aria-label="状态" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">全部状态</option><option value="active">启用</option><option value="inactive">已停用</option>
            </select>
            <button type="button" className={vacantOnly ? 'res-btn on' : 'res-btn'} aria-pressed={vacantOnly} onClick={() => setVacantOnly((v) => !v)}>无人在岗 {positions.filter((p) => p.status === 'active' && p.userCount === 0).length}</button>
            {!hasSlot && hint}
            <span className="res-bar-gap" />
            {can('org.staff.create') && <button type="button" className="res-btn" onClick={() => setInvite({})}>通用入职码</button>}
            {user?.permissions.isCompanyAdmin && <><button type="button" className="res-btn" onClick={() => setCashierOpen(true)}>补齐出纳提现权限</button><button type="button" className="res-btn" onClick={() => setDeskAccessOpen(true)}>按岗位配置功能权限</button></>}
            {can('org.structure.create') && <button type="button" className="res-btn primary" onClick={() => setDlg({ kind: 'new' })}>＋ 新增岗位</button>}
          </div>
        </fieldset>
        {error && <div role="alert" className="notice error m">{error}</div>}
        <div className="pp-groups">
          {groups.map((g) => (
            <section key={g.key} className="pp-group" aria-label={`部门 ${g.name}`}>
              <button type="button" className="pp-group-head" aria-expanded={!folded.has(g.key)} style={{ paddingLeft: 12 + g.depth * 18 }} onClick={() => toggle(g.key)}>
                <span className="pp-caret" aria-hidden="true">{folded.has(g.key) ? '▸' : '▾'}</span>
                <strong>{g.name}</strong>
                <em>{g.rows.length} 个岗位</em>
              </button>
              {!folded.has(g.key) && (
                <div className="table-wrap"><table className="data-table pp-table">
                  <thead><tr><th>岗位名称</th><th>岗位层级</th><th>上级岗位</th><th>默认工作台</th><th className="num">在岗人数</th><th className="num">职责数量</th><th>状态</th><th>操作</th></tr></thead>
                  <tbody>
                    {g.rows.map((p) => (
                      <tr key={p.id}>
                        <td><button type="button" className="link-button pp-name" onClick={() => setSel(p.id)}>{p.name}</button>{p.positionKey && <small className="muted"> {p.positionKey}</small>}</td>
                        <td>{LEVEL_LABELS[p.level]}</td>
                        <td>{p.supervisorPositionId ? posName.get(p.supervisorPositionId) ?? '—' : '—'}</td>
                        <td>{deskLabel(p.workspaceType)}</td>
                        <td className="num">{p.userCount}</td>
                        <td className="num">{p.dutyCount ?? 0}</td>
                        <td><span className={p.status === 'active' ? 'pill ok' : 'pill warn'}>{p.status === 'active' ? '启用' : '已停用'}</span></td>
                        <td className="pp-actions"><span className="row-actions">
                          <button type="button" className="link-button" onClick={() => setSel(p.id)}>查看档案</button>
                          {can('org.staff.create') && p.status === 'active' && <button type="button" className="link-button" onClick={() => setInvite({ position: p })}>岗位入职码</button>}
                          {canEdit && p.status === 'active' && <button type="button" className="link-button" onClick={() => setDlg({ kind: 'stop', p })}>停用</button>}
                          {can('org.structure.delete') && <button type="button" className="link-button danger-text" onClick={() => setDlg({ kind: 'del', p })}>删除</button>}
                        </span></td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              )}
            </section>
          ))}
          {shown.length === 0 && <p className="muted pad">没有符合条件的岗位。可以先新增岗位，再维护岗位职责、培训、绩效和监督规则。</p>}
        </div>
        <div className="res-foot"><span className="res-foot-sum">共 {shown.length} 个岗位，分在 {groups.length} 个部门</span></div>
      </section></>}
        </main>
      </div>
      {invite && <EnrollmentInviteDialog position={invite.position} onClose={() => setInvite(null)} />}
      {cashierOpen && <CashierWithdrawalDialog onClose={() => setCashierOpen(false)} onApplied={reload} />}
      {deskAccessOpen && <DeskAccessDialog catalog={catalog} onClose={() => setDeskAccessOpen(false)} onApplied={reload} />}
      {dlg?.kind === 'new' && <PositionDialog position={null} defaultDepartmentId={dept&&dept!=='none' ? Number(dept) : null} departments={tree} catalog={catalog} canEditPerms={canEdit} onClose={() => setDlg(null)} onSaved={() => { setDlg(null); reload(); }} />}
      {dlg?.kind === 'stop' && (
        <ConfirmDialog title={`停用岗位「${dlg.p.name}」`} text="停用后不能再分配给新员工；已在岗的人员不受影响。" confirmLabel="确认停用" reasonLabel="停用原因" onClose={() => setDlg(null)}
          onConfirm={async (reason) => { await orgApi.updatePosition(dlg.p.id, { status: 'inactive', reason }); setDlg(null); reload(); }} />
      )}
      {dlg?.kind === 'del' && (
        <ConfirmDialog title={`删除岗位「${dlg.p.name}」`} text="岗位上还有员工时不能删除（可以先停用），岗位下的职责条目会一起删除。" onClose={() => setDlg(null)}
          onConfirm={async () => { await orgApi.deletePosition(dlg.p.id); setDlg(null); reload(); }} />
      )}
    </div>
  );
}
