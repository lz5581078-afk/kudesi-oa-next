import { useEffect, useMemo, useState } from 'react';
import type { FieldDef } from '@kudesi/shared';
import { ApiError } from '../api/client';
import { resourceApi, type CategoryTreeResult } from './api';
import { clearRefCache } from './RecordForm';
import { clearTreeNodes } from './treeNodes';
import { ParamsDialog, ReasonDialog } from './TreeManage';

type Node = CategoryTreeResult['nodes'][number];

const FLAT_UNSET: Record<string, string> = { user: '没有使用人', department: '没有所属部门' };

/**
 * 列表左侧的目录：一眼看到该板块下所有分类（或位置、使用人、部门）和各自的数量，点一下就筛选（含下级）。
 * 资料有几种浏览维度时（固定资产：分类 / 位置 / 使用人 / 部门），上面一排切换；配置了 treeManage 的维度可以点“管理”就地增删改排序。
 */
function BrowseTree({ type, fields, tab, status, showHidden, values, reloadKey, onSelect, onPath, canManage, onChanged, rootId, createExtra, hint, onLeaf }: {
  type: string;
  fields: FieldDef[];
  tab: string;
  status: string;
  showHidden: boolean;
  values: Record<string, string>;
  reloadKey: unknown;
  onSelect: (key: string, id: string) => void;
  onPath?: (key: string, path: string) => void;
  /** 这个维度当前用户能不能就地管理（有对方资料的编辑权限，且资料配置允许） */
  canManage?: (field: FieldDef) => boolean;
  /** 管理动作改了目录（分类名、参数、排序、删除）后，让列表重新加载 */
  onChanged?: () => void;
  /** 分级布局：只显示这个顶级分类和它的下级；“全部”就是这个顶级分类本身（选中它 = 筛整个顶级分类） */
  rootId?: number;
  /** 就地新增分类时一并提交的字段（如商品分类的所属档案类型） */
  createExtra?: Record<string, unknown>;
  /** 目录上方的一行提示（如“请选择最末级分类后新增”） */
  hint?: string;
  /** 当前选中的分类是不是最末级（没有下级）；分级布局里新增资料要先选最末级 */
  onLeaf?: (leaf: boolean) => void;
}) {
  const top = rootId ?? 0;
  const [activeKey, setActiveKey] = useState(() => fields.find((f) => values[f.key])?.key ?? fields[0].key);
  const field = fields.find((f) => f.key === activeKey) ?? fields[0];
  const value = values[field.key] ?? '';
  const flat = field.ref === 'user' || field.ref === 'department';
  const [tree, setTree] = useState<CategoryTreeResult | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [kw, setKw] = useState('');
  const [mOpen, setMOpen] = useState(false); // 手机上目录折叠成一行，点开再选
  const [manage, setManage] = useState(false);
  const [reload, setReload] = useState(0);
  const [adding, setAdding] = useState<{ parent: number; name: string } | null>(null);
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const [deleting, setDeleting] = useState<Node | null>(null);
  const [params, setParams] = useState<Node | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const manageable = Boolean(canManage?.(field)) && !flat;
  const target = field.ref!;

  useEffect(() => { setTree(null); setKw(''); setAdding(null); setRenaming(null); if (!manageable) setManage(false); }, [field.key, manageable]);
  useEffect(() => {
    let alive = true;
    resourceApi.categoryTree(type, { field: field.key, tab: tab || undefined, status: status || undefined, showHidden })
      .then((r) => { if (alive) { setTree(r); setError(''); } })
      .catch(() => alive && setError('分类目录加载失败'));
    return () => { alive = false; };
  }, [type, field.key, tab, status, showHidden, reloadKey, reload]);

  const kids = useMemo(() => {
    const m = new Map<number, Node[]>();
    for (const n of tree?.nodes ?? []) m.set(n.parentId, [...(m.get(n.parentId) ?? []), n]);
    return m;
  }, [tree]);
  const byId = useMemo(() => new Map((tree?.nodes ?? []).map((n) => [n.id, n])), [tree]);

  // 默认展开一级；选中的分类，上面各级自动展开
  useEffect(() => {
    if (!tree) return;
    setOpen((cur) => {
      const next = new Set(cur.size ? cur : (kids.get(top) ?? []).map((n) => n.id));
      for (let n = byId.get(Number(value)), i = 0; n && n.parentId && i < 8; n = byId.get(n.parentId), i++) next.add(n.parentId);
      return next;
    });
  }, [tree, value, kids, byId]);

  useEffect(() => {
    if (!onLeaf || !tree) return;
    const cur = Number(value) || top;
    onLeaf((kids.get(cur) ?? []).length === 0);
  }, [onLeaf, tree, value, kids, top]);

  // 把每个维度当前选中的路径告诉外面（筛选标签条、新建时预填用）
  useEffect(() => {
    if (!onPath || !tree) return;
    const parts: string[] = [];
    for (let n = byId.get(Number(value)), i = 0; n && i < 8; n = byId.get(n.parentId), i++) parts.unshift(n.title);
    onPath(field.key, parts.join(' / '));
  }, [value, byId, onPath, field.key, tree]);

  const word = kw.trim().toLowerCase();
  // 搜索时：命中的分类及其所有上级都保留
  const keep = useMemo(() => {
    if (!word) return null;
    const s = new Set<number>();
    for (const n of tree?.nodes ?? []) {
      if (!n.title.toLowerCase().includes(word)) continue;
      for (let c: Node | undefined = n, i = 0; c && i < 8; c = byId.get(c.parentId), i++) s.add(c.id);
    }
    return s;
  }, [word, tree, byId]);

  const toggle = (id: number) => setOpen((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allParents = (tree?.nodes ?? []).filter((n) => kids.has(n.id)).map((n) => n.id);

  const changed = () => { clearRefCache(target); clearTreeNodes(target); setReload((x) => x + 1); onChanged?.(); };
  async function run(fn: () => Promise<unknown>, okMsg = '') {
    setNotice('');
    try { await fn(); changed(); if (okMsg) setNotice(okMsg); } catch (e) { setNotice(e instanceof ApiError ? e.message : '操作失败'); }
  }
  async function addNode(e: React.FormEvent) {
    e.preventDefault();
    if (!adding || !adding.name.trim()) return;
    const parent = adding.parent || top;
    await run(() => resourceApi.create(target, { ...(createExtra ?? {}), name: adding.name.trim(), ...(parent ? { parentId: parent } : {}) }));
    setAdding(null);
    if (parent) setOpen((cur) => new Set(cur).add(parent));
  }
  async function renameNode(e: React.FormEvent) {
    e.preventDefault();
    if (!renaming || !renaming.name.trim()) return;
    await run(() => resourceApi.update(target, renaming.id, { name: renaming.name.trim() }));
    setRenaming(null);
  }
  /** 同一级里重新排序：全部按新顺序重写排序值（间隔 10），只提交变了的 */
  async function reorder(parent: number, movedId: number, beforeId: number | null) {
    const sibs = (kids.get(parent) ?? []).filter((n) => n.id !== movedId);
    const moved = byId.get(movedId);
    if (!moved || moved.parentId !== parent) return;
    const at = beforeId === null ? sibs.length : Math.max(0, sibs.findIndex((n) => n.id === beforeId));
    sibs.splice(at, 0, moved);
    const changes = sibs.map((n, i) => ({ n, sort: (i + 1) * 10 })).filter((x) => x.n.sort !== x.sort);
    if (!changes.length) return;
    await run(async () => { for (const c of changes) await resourceApi.update(target, c.n.id, { sort: c.sort }); });
  }
  const move = (n: Node, dir: -1 | 1) => {
    const sibs = kids.get(n.parentId) ?? [];
    const i = sibs.findIndex((x) => x.id === n.id);
    const j = i + dir;
    if (j < 0 || j >= sibs.length) return;
    void reorder(n.parentId, n.id, dir < 0 ? sibs[j].id : (sibs[j + 1]?.id ?? null));
  };

  function addForm(parent: number, depth: number) {
    if (!adding || adding.parent !== parent) return null;
    return (
      <li key={`add-${parent}`}>
        <form className="cat-edit" style={{ paddingLeft: 6 + depth * 14 }} onSubmit={addNode}>
          <input autoFocus aria-label="新分类名称" placeholder={parent ? '输入下级名称' : '输入一级名称'} maxLength={60} value={adding.name} onChange={(e) => setAdding({ parent, name: e.target.value })} />
          <button type="submit" className="res-btn sm primary">保存</button>
          <button type="button" className="res-btn sm" onClick={() => setAdding(null)}>取消</button>
        </form>
      </li>
    );
  }

  function rows(parentId: number, depth: number): JSX.Element[] {
    return (kids.get(parentId) ?? []).filter((n) => !keep || keep.has(n.id)).map((n, idx, arr) => {
      const sub = kids.get(n.id) ?? [];
      const expanded = keep ? true : open.has(n.id);
      const active = String(n.id) === value;
      const editing = renaming?.id === n.id;
      return (
        <li key={n.id} role="treeitem" aria-expanded={sub.length ? expanded : undefined} aria-selected={active}>
          <div
            className={`cat-row${active ? ' active' : ''}${n.status === 'inactive' ? ' stopped' : ''}${manage ? ' managing' : ''}${drag === n.id ? ' dragging' : ''}`}
            style={{ paddingLeft: 6 + depth * 14 }}
            draggable={manage && !editing}
            onDragStart={(e) => { if (!manage) return; setDrag(n.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(n.id)); }}
            onDragOver={(e) => { if (manage && drag !== null && byId.get(drag)?.parentId === n.parentId) e.preventDefault(); }}
            onDrop={(e) => { e.preventDefault(); const from = drag; setDrag(null); if (from !== null && from !== n.id) void reorder(n.parentId, from, n.id); }}
            onDragEnd={() => setDrag(null)}
          >
            <button type="button" className="cat-toggle" tabIndex={-1} disabled={!sub.length} aria-label={expanded ? '收起' : '展开'} onClick={() => toggle(n.id)}>
              {sub.length ? (expanded ? '▾' : '▸') : '·'}
            </button>
            {editing ? (
              <form className="cat-edit grow" onSubmit={renameNode}>
                <input autoFocus aria-label="分类名称" maxLength={60} value={renaming.name} onChange={(e) => setRenaming({ id: n.id, name: e.target.value })} />
                <button type="submit" className="res-btn sm primary">保存</button>
                <button type="button" className="res-btn sm" onClick={() => setRenaming(null)}>取消</button>
              </form>
            ) : (
              <button type="button" className="cat-name" title={n.title} onClick={() => onSelect(field.key, active ? '' : String(n.id))}>{n.title}</button>
            )}
            {!editing && <span className="cat-count">{n.count}</span>}
            {manage && !editing && (
              <span className="cat-acts">
                <button type="button" aria-label={`给「${n.title}」加下级`} title="加下级" onClick={() => { setAdding({ parent: n.id, name: '' }); setOpen((cur) => new Set(cur).add(n.id)); }}>＋下级</button>
                <button type="button" aria-label={`改名「${n.title}」`} title="改名" onClick={() => setRenaming({ id: n.id, name: n.title })}>改名</button>
                {target === 'asset-categories' && <button type="button" aria-label={`「${n.title}」参数配置`} title="参数配置" onClick={() => setParams(n)}>参数</button>}
                <button type="button" aria-label={`上移「${n.title}」`} title="上移" disabled={idx === 0} onClick={() => move(n, -1)}>↑</button>
                <button type="button" aria-label={`下移「${n.title}」`} title="下移" disabled={idx === arr.length - 1} onClick={() => move(n, 1)}>↓</button>
                <button type="button" className="danger" aria-label={`删除「${n.title}」`} title="删除" onClick={() => setDeleting(n)}>删除</button>
              </span>
            )}
          </div>
          {(sub.length > 0 && expanded) || (adding?.parent === n.id) ? <ul role="group">{addForm(n.id, depth + 1)}{expanded && rows(n.id, depth + 1)}</ul> : null}
        </li>
      );
    });
  }

  const multi = fields.length > 1;
  const unsetText = flat ? (FLAT_UNSET[field.ref!] ?? '没有') : `未设置${field.label}`;
  return (
    <aside className="cat-tree" aria-label="分类目录">
      <button type="button" className="cat-fold" aria-expanded={mOpen} onClick={() => setMOpen((v) => !v)}>
        {multi ? `按${field.label}浏览` : '分类目录'}{value ? '（已选）' : ''} {mOpen ? '▴' : '▾'}
      </button>
      <div className={`cat-body${mOpen ? ' open' : ''}`} onClick={(e) => { if ((e.target as HTMLElement).closest('.cat-name, .cat-all')) setMOpen(false); }}>
      {multi && (
        <div className="cat-dims" role="tablist" aria-label="浏览维度">
          {fields.map((f) => (
            <button key={f.key} type="button" role="tab" aria-selected={f.key === field.key} className={f.key === field.key ? 'active' : ''} onClick={() => setActiveKey(f.key)}>
              {f.label.replace(/^所属/, '')}{values[f.key] ? <i aria-label="已选" /> : null}
            </button>
          ))}
        </div>
      )}
      <div className="cat-head">
        <strong>{multi ? `按${field.label}` : '分类目录'}</strong>
        <span className="cat-tools">
          {allParents.length > 0 && <><button type="button" onClick={() => setOpen(new Set(allParents))}>全部展开</button><button type="button" onClick={() => setOpen(new Set())}>收起</button></>}
          {manageable && <button type="button" className={manage ? 'on' : ''} aria-pressed={manage} onClick={() => { setManage((v) => !v); setAdding(null); setRenaming(null); setNotice(''); }}>{manage ? '退出管理' : '管理'}</button>}
        </span>
      </div>
      <input className="cat-search" placeholder={flat ? `找${field.label}` : multi ? `找${field.label}` : '找分类'} aria-label={flat ? `找${field.label}` : multi ? `找${field.label}` : '找分类'} value={kw} onChange={(e) => setKw(e.target.value)} />
      <button type="button" className={`cat-all${value === '' || (rootId && value === String(rootId)) ? ' active' : ''}`} onClick={() => onSelect(field.key, '')}>
        <span>{rootId ? `全部${byId.get(rootId)?.title ?? ''}` : '全部'}</span><span className="cat-count">{rootId ? (byId.get(rootId)?.count ?? '') : (tree?.total ?? '')}</span>
      </button>
      {hint && <div className="cat-hint muted">{hint}</div>}
      {notice && <div role="status" className="muted cat-note">{notice}</div>}
      {error && <div className="muted">{error}</div>}
      {tree && (kids.get(top) ?? []).length === 0 && !manage && <div className="muted">{flat ? `还没有资料填了${field.label}` : '还没有分类，先到“资料维护”里建分类'}</div>}
      {manage && <div className="cat-acts-hint">点一个{flat ? '' : '分类'}，下面会出现 加下级 / 改名 / 参数 / 排序 / 删除；也可以拖动同级的分类排序。</div>}
      {manage && <button type="button" className="cat-addtop" onClick={() => setAdding({ parent: 0, name: '' })}>{rootId ? '＋ 新增下级分类' : '＋ 新增一级'}</button>}
      <ul role="tree">{addForm(0, 0)}{rows(top, 0)}</ul>
      {tree && !rootId && tree.uncategorized > 0 && <div className="muted cat-un">{unsetText} {tree.uncategorized} 条</div>}
      </div>
      {deleting && (
        <ReasonDialog
          title={`删除「${deleting.title}」`}
          hint={sub(deleting, kids) ? `它下面还有 ${sub(deleting, kids)} 个下级，请先处理下级再删除。删除要写原因，会留在操作记录里。` : `被资料使用的分类不能直接删除（会提示是谁在用），可以先改用别的分类。删除要写原因。`}
          confirmLabel="确认删除"
          onClose={() => setDeleting(null)}
          onSubmit={async (reason) => {
            await resourceApi.remove(target, deleting.id, reason);
            if (String(deleting.id) === value) onSelect(field.key, '');
            setDeleting(null);
            changed();
          }}
        />
      )}
      {params && <ParamsDialog target={target} id={params.id} name={params.title} onClose={() => setParams(null)} onSaved={() => { setParams(null); changed(); setNotice('参数已保存'); }} />}
    </aside>
  );
}

function sub(n: Node, kids: Map<number, Node[]>) {
  return (kids.get(n.id) ?? []).length;
}

interface LegacyProps { type: string; field: string; tab: string; status: string; showHidden: boolean; value: string; reloadKey: unknown; onSelect: (id: string) => void; onPath?: (path: string) => void }
type TreeProps = Parameters<typeof BrowseTree>[0];

/**
 * 目录入口。新用法传 fields（多个浏览维度）；只有一个分类字段的老用法（商品组合编码页等）传 field / value，行为不变。
 * 名字保持 CategoryTree，各页面的测试里对它的替身不用改。
 */
export function CategoryTree(props: LegacyProps): JSX.Element;
export function CategoryTree(props: TreeProps): JSX.Element;
export function CategoryTree(props: TreeProps | LegacyProps): JSX.Element {
  const legacy = 'field' in props ? props : null;
  const fields = useMemo<FieldDef[]>(() => (legacy ? [{ key: legacy.field, label: '分类', type: 'ref', group: '', ref: 'category' }] : []), [legacy?.field]); // eslint-disable-line react-hooks/exhaustive-deps
  const values = useMemo(() => (legacy ? { [legacy.field]: legacy.value } : {}), [legacy?.field, legacy?.value]); // eslint-disable-line react-hooks/exhaustive-deps
  if (legacy) {
    const { onSelect, onPath, ...rest } = legacy;
    return <BrowseTree {...rest} fields={fields} values={values} onSelect={(_, id) => onSelect(id)} onPath={onPath ? (_, p) => onPath(p) : undefined} />;
  }
  return <BrowseTree {...(props as TreeProps)} />;
}
