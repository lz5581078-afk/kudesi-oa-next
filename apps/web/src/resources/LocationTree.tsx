import { useEffect, useMemo, useState } from 'react';
import { LOC_TYPE_LABEL, type BNode, type Model } from './locationModel';

export interface QuickAdd { parentKey: string | null; name: string; type: string }

const TYPE_ORDER = ['building', 'floor', 'room', 'cabinet', 'asset_slot', 'shelf', 'drawer', 'box'];
const KIND_ICON: Record<string, string> = { area: '▣', asset: '▤', space: '▫', group: '◌' };

interface Props {
  model: Model;
  selected: string | null;
  onSelect: (key: string | null) => void;
  kw: string;
  onKw: (v: string) => void;
  search: { keep: Set<string>; hits: Set<string> };
  manage: boolean;
  canManage: boolean;
  onManage: (v: boolean) => void;
  quick: QuickAdd | null;
  onQuick: (q: QuickAdd | null) => void;
  onQuickStart: (parentKey: string | null) => void;
  onQuickSave: (q: QuickAdd) => Promise<void>;
  onRename: (key: string, name: string) => Promise<void>;
  onReorder: (key: string, dir: -1 | 1) => void;
  onToggleInactive: (key: string) => void;
  onDelete: (key: string) => void;
  mobileOpen: boolean;
  onMobileOpen: (v: boolean) => void;
}

/** 左边的位置树：房间 → 柜子 → 层位/抽屉。每个节点后面是里面的档案数；有借出/遗失的档案时亮一个点。 */
export function LocationTree(p: Props) {
  const { model: m, selected } = p;
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<{ key: string; name: string } | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const searching = p.kw.trim().length > 0;

  // 默认展开前两级；选中的节点，上面各级自动展开
  useEffect(() => {
    setOpen((cur) => {
      if (cur.size === 0) { const init = new Set<string>(); for (const r of m.roots) { init.add(r); for (const c of m.kids.get(r) ?? []) init.add(c); } return init; }
      return cur;
    });
  }, [m]);
  useEffect(() => {
    if (!selected) return;
    setOpen((cur) => { const next = new Set(cur); for (let n = m.nodes.get(selected)?.parentKey, i = 0; n && i < 30; n = m.nodes.get(n)?.parentKey ?? null, i++) next.add(n); return next; });
  }, [selected, m]);
  const allParents = useMemo(() => [...m.kids.entries()].filter(([k, v]) => k && v.length).map(([k]) => k as string), [m]);

  const toggle = (k: string) => setOpen((cur) => { const n = new Set(cur); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setErr('');
    try { await fn(); } catch (e) { setErr((e as { message?: string }).message ?? '操作失败'); } finally { setBusy(false); }
  };

  function quickForm(parentKey: string | null, depth: number) {
    if (!p.quick || p.quick.parentKey !== parentKey) return null;
    const q = p.quick;
    const parent = parentKey ? m.nodes.get(parentKey) : null;
    const types = parent?.kind === 'asset' || parent?.kind === 'space' ? TYPE_ORDER.slice(4) : parent?.kind === 'area' ? TYPE_ORDER : TYPE_ORDER.slice(0, 3);
    return (
      <li key={`q-${parentKey ?? 'root'}`}>
        <form className="cat-edit lb-quick" style={{ paddingLeft: 6 + depth * 14 }} onSubmit={(e) => { e.preventDefault(); if (q.name.trim()) void run(() => p.onQuickSave(q)); }}>
          <select aria-label="位置类型" value={q.type} onChange={(e) => p.onQuick({ ...q, type: e.target.value })}>
            {types.map((t) => <option key={t} value={t}>{LOC_TYPE_LABEL[t]}</option>)}
          </select>
          <input autoFocus aria-label="新位置名称" placeholder="名称，回车保存" maxLength={60} value={q.name} onChange={(e) => p.onQuick({ ...q, name: e.target.value })} />
          <button type="submit" className="res-btn sm primary" disabled={busy}>保存</button>
          <button type="button" className="res-btn sm" onClick={() => p.onQuick(null)}>取消</button>
        </form>
      </li>
    );
  }

  function rows(parentKey: string | null, depth: number): JSX.Element[] {
    return (m.kids.get(parentKey) ?? []).filter((k) => !searching || p.search.keep.has(k)).map((k, idx, arr) => {
      const n = m.nodes.get(k)!;
      const sub = (m.kids.get(k) ?? []).filter((c) => !searching || p.search.keep.has(c));
      const expanded = searching ? true : open.has(k);
      const active = selected === k;
      const editing = renaming?.key === k;
      const editable = n.kind === 'area' || n.kind === 'space';
      const alerts = m.deepAlerts.get(k) ?? 0;
      return (
        <li key={k} role="treeitem" aria-expanded={sub.length ? expanded : undefined} aria-selected={active}>
          <div className={`cat-row lb-row${p.manage ? ' managing' : ''}${active ? ' active' : ''}${n.status === 'inactive' ? ' stopped' : ''}${p.search.hits.has(k) ? ' hit' : ''}`} style={{ paddingLeft: 6 + depth * 14 }}>
            <button type="button" className="cat-toggle" tabIndex={-1} disabled={!sub.length} aria-label={expanded ? '收起' : '展开'} onClick={() => toggle(k)}>{sub.length ? (expanded ? '▾' : '▸') : '·'}</button>
            {editing ? (
              <form className="cat-edit grow" onSubmit={(e) => { e.preventDefault(); if (renaming!.name.trim()) void run(async () => { await p.onRename(k, renaming!.name.trim()); setRenaming(null); }); }}>
                <input autoFocus aria-label="位置名称" maxLength={60} value={renaming!.name} onChange={(e) => setRenaming({ key: k, name: e.target.value })} />
                <button type="submit" className="res-btn sm primary" disabled={busy}>保存</button>
                <button type="button" className="res-btn sm" onClick={() => setRenaming(null)}>取消</button>
              </form>
            ) : (
              <button type="button" className="cat-name" title={`${n.title}（${n.kind === 'asset' ? '固定资产' : n.tag}）`} onClick={() => p.onSelect(active ? null : k)}>
                <i className={`lb-ico ${n.kind}`} aria-hidden="true">{KIND_ICON[n.kind]}</i>{n.title}{n.kind !== 'group' && <small className="lb-kind">{n.kind === 'asset' ? '柜' : n.tag}</small>}
              </button>
            )}
            {!editing && alerts > 0 && <span className="lb-dot" title={`${alerts} 份档案借出或遗失`} aria-label={`${alerts} 份档案借出或遗失`} />}
            {!editing && <span className="cat-count" title="档案数（含下级）">{m.deepArchives.get(k) ?? 0}</span>}
            {p.manage && !editing && (
              <span className="cat-acts">
                {(n.kind === 'area' || n.kind === 'asset' || n.kind === 'space') && <button type="button" aria-label={`给「${n.title}」加下级`} title="加下级" onClick={() => p.onQuickStart(k)}>＋下级</button>}
                {editable && <button type="button" aria-label={`改名「${n.title}」`} title="改名" onClick={() => setRenaming({ key: k, name: n.title })}>改名</button>}
                {editable && <button type="button" aria-label={`上移「${n.title}」`} title="上移" disabled={idx === 0 || busy} onClick={() => p.onReorder(k, -1)}>↑</button>}
                {editable && <button type="button" aria-label={`下移「${n.title}」`} title="下移" disabled={idx === arr.length - 1 || busy} onClick={() => p.onReorder(k, 1)}>↓</button>}
                {editable && <button type="button" aria-label={`${n.status === 'inactive' ? '启用' : '停用'}「${n.title}」`} title={n.status === 'inactive' ? '启用' : '停用'} onClick={() => p.onToggleInactive(k)}>{n.status === 'inactive' ? '启用' : '停用'}</button>}
                {editable && <button type="button" className="danger" aria-label={`删除「${n.title}」`} title="删除" onClick={() => p.onDelete(k)}>删除</button>}
              </span>
            )}
          </div>
          {((sub.length > 0 && expanded) || p.quick?.parentKey === k) ? <ul role="group">{quickForm(k, depth + 1)}{expanded && rows(k, depth + 1)}</ul> : null}
        </li>
      );
    });
  }

  const cur = selected ? m.nodes.get(selected) : null;
  return (
    <aside className="cat-tree lb-tree" aria-label="位置目录">
      <button type="button" className="cat-fold" aria-expanded={p.mobileOpen} onClick={() => p.onMobileOpen(!p.mobileOpen)}>
        位置：{cur ? cur.title : '全部'} {p.mobileOpen ? '▴' : '▾'}
      </button>
      <div className={`cat-body${p.mobileOpen ? ' open' : ''}`}>
        <div className="cat-head">
          <strong>位置层级</strong>
          <span className="cat-tools">
            {allParents.length > 0 && <><button type="button" onClick={() => setOpen(new Set(allParents))}>全部展开</button><button type="button" onClick={() => setOpen(new Set())}>收起</button></>}
            {p.canManage && <button type="button" className={p.manage ? 'on' : ''} aria-pressed={p.manage} onClick={() => { p.onManage(!p.manage); p.onQuick(null); setRenaming(null); }}>{p.manage ? '退出管理' : '管理'}</button>}
          </span>
        </div>
        <input className="cat-search" type="search" placeholder="找位置、柜子、档案" aria-label="找位置、柜子、档案" value={p.kw} onChange={(e) => p.onKw(e.target.value)} />
        <button type="button" className={`cat-all${selected === null ? ' active' : ''}`} onClick={() => p.onSelect(null)}><span>全部档案</span><span className="cat-count">{[...m.archivesAt.values()].reduce((n, l) => n + l.length, 0) + m.stray.length}</span></button>
        {p.manage && <div className="cat-acts-hint">点一个位置，下面会出现 加下级 / 改名 / 排序 / 停用 / 删除。</div>}
        {err && <div role="alert" className="notice error m">{err}</div>}
        {m.roots.length === 0 && !p.quick && <div className="muted lb-empty">还没有位置。{p.canManage ? <button type="button" className="link-button" onClick={() => p.onQuickStart(null)}>新增一级位置</button> : null}</div>}
        <ul role="tree">{quickForm(null, 0)}{rows(null, 0)}</ul>
        {searching && p.search.keep.size === 0 && <div className="muted lb-empty">没有找到「{p.kw.trim()}」</div>}
        {m.stray.length > 0 && <div className="muted cat-un">{m.stray.length} 份档案没有存放位置（可在右边“全部档案”里补）</div>}
      </div>
    </aside>
  );
}
