import { useEffect, useMemo, useState } from 'react';
import { FolderTree, GripVertical, X } from 'lucide-react';
import { getResourceDef, hasFeeDefaults, PARTY_SEED_CATEGORIES, resourceTabOptions, treeFilterField, type ResourceDef } from '@kudesi/shared';
import { ApiError, api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useCategoryOptions } from './categoryOptions';
import { useUnitOptions } from './unitOptions';
import { resourceApi, type CategoryTreeResult, type ResourceDto } from './api';
import { ArchiveTypeDialog } from './ArchiveTypeDialog';
import { FeeSnapshotsDialog } from './FeeSnapshotsDialog';
import { ReasonDialog, clearRefCache } from './RecordForm';
import { useResourceCan } from './RecordDetail';
import { PageHint } from './PageHint';
import { AppbarHint, useAppbarBare, useHasAppbarSlot } from '../layout/AppbarSlot';
import './archiveHome.css';
import { resourceDescription } from '@kudesi/shared';

export interface HierEntry { key: string; title: string; subtitle: string; rootId?: number }

const TAB_ACCENT: Record<string, string> = { raw: 'green', self_made: 'blue', original_purchase: 'orange', supplier_oem: 'teal', package: 'purple', shipping_material: 'blue', oem_package: 'teal' };
/** 商品档案顶级分类（档案类型）的说明，旧版同款文字 */
const TAB_BLURB: Record<string, string> = {
  raw: '种子、原料、辅料等采购和生产使用的商品资料。',
  self_made: '公司自有生产、加工和包装后的成品商品。',
  purchased: '外部采购后直接销售或组合销售的成品商品。',
  original_purchase: '采购完整成品后直接销售或组合销售的商品资料。',
  supplier_oem: '供应商使用公司 OEM 包装形成的外购成品资料。',
  package: '包装袋、盒、箱、标签等包装类商品资料。',
  shipping_material: '纸箱、胶带、填充物、随货卡等发货环节使用的物料资料。',
  oem_package: '用于管理放在供应商那边的包装资料。',
};
const TAB_CODE: Record<string, string> = { raw: 'YL', self_made: 'ZC', original_purchase: 'WG-YZ', supplier_oem: 'WG-OEM', package: 'BZ', shipping_material: 'FH', oem_package: 'OEM' };

/** 商品档案的顶级入口：档案类型页签（含外购成品拆成的两个、公司自建的类型） */
export function useHierTabs(def: ResourceDef) {
  const catOptions = useCategoryOptions(def.key);
  const unitOpts = useUnitOptions();
  return useMemo(() => {
    const base = resourceTabOptions(def, catOptions?.filter((o) => !o.hidden));
    const custom = def.tabsBy === 'archiveType' ? (unitOpts.archive_type ?? []).filter((o) => !resourceTabOptions(def).some((b) => b.value === o.value)) : [];
    return [...base, ...custom];
  }, [def, catOptions, unitOpts]);
}

/** 顶级分类卡片页：每张卡片 = 一个顶级分类 + 数量 + 说明，点进去才是“左侧分类树 + 右侧列表”。 */
export function ArchiveHome({ type, onEnter }: { type: string; onEnter: (e: HierEntry) => void }) {
  const def = getResourceDef(type)!;
  const cfg = def.hierarchy!;
  const can = useResourceCan(type);
  const catType = cfg.categoryType ?? '';
  const catCan = useResourceCan(catType || type);
  const { user: me } = useAuth();
  const tabs = useHierTabs(def);
  const treeField = useMemo(() => treeFilterField(def), [def]);
  const [categoryCounts, setCategoryCounts] = useState<Record<string, number>>({});
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [total, setTotal] = useState<number | null>(null);
  const [tree, setTree] = useState<CategoryTreeResult | null>(null);
  const [cats, setCats] = useState<ResourceDto[]>([]);
  const [managing, setManaging] = useState(false);
  const [typesOpen, setTypesOpen] = useState(false);
  const [snapshots, setSnapshots] = useState(false);
  const [draft, setDraft] = useState<{ id?: number; name: string; subtitle: string; categoryCode?: string } | null>(null);
  const [deleting, setDeleting] = useState<ResourceDto | null>(null);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [dragId, setDragId] = useState<number | null>(null);
  const refresh = () => setReload((n) => n + 1);
  useAppbarBare(); // 顶部页面栏省略面包屑，内容区按24号源码保留档案标题。
  const hasAppbar = useHasAppbarSlot();

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await resourceApi.list(type, { pageSize: 1 });
        if (!alive) return;
        setCounts(r.tabCounts ?? {}); setTotal(r.total);
        if (cfg.kind === 'category' && treeField) {
          const [t, c] = await Promise.all([
            resourceApi.categoryTree(type, { field: treeField.key }),
            resourceApi.list(catType, { pageSize: 200, showHidden: false }),
          ]);
          if (!alive) return;
          setTree(t); setCats(c.items);
        }
        setError('');
      } catch (e) { if (alive) setError(e instanceof ApiError ? e.message : '加载失败'); }
    })();
    return () => { alive = false; };
  }, [type, cfg.kind, catType, treeField, reload]);

  useEffect(() => {
    if (cfg.kind !== 'tab' || !treeField) return;
    let alive = true;
    void Promise.all(tabs.map(async t => {
      try { const tree = await resourceApi.categoryTree(type, { field: treeField.key, tab: t.value }); return [t.value, tree.nodes.filter(n => !['original_purchase', 'supplier_oem'].includes(t.value) || n.count > 0).length] as const; }
      catch { return null; }
    })).then(rows => { if (alive) setCategoryCounts(Object.fromEntries(rows.filter((r): r is readonly [string, number] => r !== null))); });
    return () => { alive = false; };
  }, [type, cfg.kind, treeField, tabs, reload]);

  const roots = useMemo(() => {
    if (cfg.kind !== 'category' || !tree) return [];
    const byId = new Map(cats.map((c) => [c.id, c]));
    return tree.nodes.filter((n) => n.parentId === 0).map((n) => ({ node: n, rec: byId.get(n.id) }));
  }, [cfg.kind, tree, cats]);

  // 供应商/客户的默认一级分类（旧程序自带）：空库首次进入自动建好，不用手点“导入默认分类”。每家公司每种档案只自动导入一次。
  useEffect(() => {
    if (cfg.kind !== 'category' || type === 'finance-fee-items' || !tree || !PARTY_SEED_CATEGORIES[catType as 'finance-supplier-categories']) return;
    if (roots.length > 0 || !catCan('create')) return;
    const flag = `kudesi.hier.autoseed.${me?.companyName ?? ""}.${catType}`;
    try { if (localStorage.getItem(flag)) return; localStorage.setItem(flag, '1'); } catch { /* 无本地存储时只做一次内存级尝试 */ }
    void seed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, roots.length]);

  const canManageRoots = cfg.kind === 'category' && catCan('edit');
  async function reorderRoots(next: typeof roots) {
    if (busy) return;
    setBusy(true);
    try { await resourceApi.reorderCategories(catType, next.map(r => r.node.id)); clearRefCache(catType); refresh(); }
    catch (e) { setError(e instanceof ApiError ? e.message : '排序失败'); }
    finally { setBusy(false); }
  }
  const move = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= roots.length) return;
    const next = [...roots]; [next[idx], next[j]] = [next[j], next[idx]];
    void reorderRoots(next);
  };
  async function saveDraft(e: React.FormEvent) {
    e.preventDefault();
    if (!draft || !draft.name.trim()) return;
    setBusy(true); setError('');
    try {
      const values = { name: draft.name.trim(), subtitle: draft.subtitle.trim(), ...(draft.categoryCode !== undefined ? { categoryCode: draft.categoryCode.trim() } : {}) };
      if (draft.id) await resourceApi.update(catType, draft.id, values); else await resourceApi.create(catType, values);
      clearRefCache(catType); setDraft(null); refresh();
    } catch (er) { setError(er instanceof ApiError ? er.message : '保存失败'); }
    setBusy(false);
  }
  async function seed() {
    setBusy(true); setError('');
    try {
      if (type === 'finance-fee-items') {
        if (!window.confirm('把旧程序里的费用类别树和费用项目（约 380 项）导入进来？已经有的编号不会重复，也不会被覆盖。')) { setBusy(false); return; }
        const r = await api<{ categoriesCreated: number; itemsCreated: number }>('/finance/fee-archive/seed', { method: 'POST', body: {} });
        setMsg(`导入完成：新增费用类别 ${r.categoriesCreated} 个、费用项目 ${r.itemsCreated} 个。`);
      } else {
        const have = new Set((await resourceApi.list(catType, { pageSize: 200, showHidden: true })).items.map((i) => i.title));
        let n = 0;
        for (const [name, subtitle] of PARTY_SEED_CATEGORIES[catType as 'finance-supplier-categories']) if (!have.has(name)) { await resourceApi.create(catType, { name, subtitle }); n++; }
        setMsg(n ? `已导入 ${n} 个默认分类` : '默认分类都已经有了');
      }
      clearRefCache(catType); refresh();
    } catch (er) { setError(er instanceof ApiError ? er.message : '导入失败'); }
    setBusy(false);
  }

  const desc = resourceDescription(type);
  const contact = ['finance-suppliers', 'finance-customers'].includes(type);
  const noun = def.label.replace('档案', '');
  const seedable = cfg.kind === 'category' && can('create') && (type === 'finance-fee-items' ? hasFeeDefaults(me?.companyName) : Boolean(PARTY_SEED_CATEGORIES[catType as 'finance-supplier-categories']));
  const cards: Array<{ key: string; title: string; subtitle: string; count: number; foot: string; rootId?: number; rec?: ResourceDto; idx: number }> = cfg.kind === 'tab'
    ? tabs.map((t, i) => ({ key: t.value, title: t.label, subtitle: TAB_BLURB[t.value] ?? '公司自定义的档案类型。', count: counts[t.value] ?? 0, foot: `标识 ${TAB_CODE[t.value] ?? t.value}${categoryCounts[t.value] !== undefined ? ` · ${categoryCounts[t.value]} ${['original_purchase', 'supplier_oem'].includes(t.value) ? '个有资料分类' : '个分类'}` : ''}`, idx: i }))
    : roots.map((r, i) => ({ key: String(r.node.id), title: r.node.title, subtitle: String(r.rec?.data.subtitle ?? '') || `${def.label}分类维护。`, count: r.node.count, foot: type === 'finance-fee-items' ? `${r.node.count} 个费用项` : '', rootId: r.node.id, rec: r.rec, idx: i }));

  return (
    <div className={`res-page hier-home finance-base-home${contact ? ' finance-contact-home' : ''}`} data-resource={type}>
      {hasAppbar && desc && <AppbarHint><PageHint text={desc} /></AppbarHint>}
      <header className="hier-home-head">
        <div className="finance-base-home-title">{contact && <span>财务基础资料</span>}{!hasAppbar && <h1>{def.label}</h1>}<p>{contact ? `按${noun}类型分层维护。进入一个分类后，只展示该目录直属的${noun}资料。` : type === 'finance-products' ? '按原料、自产品、原装采购、供应商 OEM、产品包装、发货物料和 OEM 包装分别维护，后续用于采购、成本和核算。' : cfg.subtitle}</p></div>
        <div className="hier-home-actions">
          {type === 'finance-fee-items' && <>{catCan('create') && <button type="button" className="res-btn primary" onClick={() => setDraft({ name: '', subtitle: '' })}>新增顶级分类</button>}<button type="button" className="res-btn" onClick={() => setSnapshots(true)}>存为历史包</button></>}
          {cfg.kind === 'category' && <details className="finance-home-more"><summary>更多</summary><button type="button" className="res-btn" onClick={() => onEnter({ key: 'all', title: `全部${noun}`, subtitle: cfg.subtitle })}>查看全部{total !== null ? `（${total}）` : ''}</button>{type === 'finance-fee-items' && canManageRoots && <button type="button" className="res-btn" onClick={() => setManaging(v => !v)}>{managing ? '完成管理' : '管理顶级分类'}</button>}</details>}
          {cfg.kind === 'tab' && can('edit') && <button type="button" className="res-btn" onClick={() => setTypesOpen(true)}>管理顶级分类</button>}
          {canManageRoots && type !== 'finance-fee-items' && <button type="button" className={managing ? 'res-btn on' : 'res-btn'} aria-pressed={managing} onClick={() => { setManaging(!managing); setDraft(null); }}>{managing ? '完成管理' : '管理顶级分类'}</button>}
          {managing && type !== 'finance-fee-items' && catCan('create') && <button type="button" className="res-btn primary" onClick={() => setDraft({ name: '', subtitle: '' })}>＋ 新增顶级分类</button>}
        </div>
      </header>
      {error && !draft && <div role="alert" className="notice error m">{error}</div>}
      {msg && <div role="status" className="notice m between"><span>{msg}</span><button type="button" className="icon-button" aria-label="关闭提示" onClick={() => setMsg('')}>✕</button></div>}
      {draft && (
        <div className="modal-backdrop finance-root-editor-backdrop" role="presentation">
          <form className="finance-root-editor" role="dialog" aria-modal="true" aria-label={draft.id ? '编辑顶级分类' : '新增顶级分类'} onSubmit={saveDraft}>
            <header><span className="finance-root-editor-icon"><FolderTree size={20} /></span><div><small>{draft.id ? '修改顶级分类' : '创建顶级分类'}</small><h2>{draft.id ? '编辑顶级分类' : '新增顶级分类'}</h2><p>顶级分类用于划分{def.label}的主要业务方向。</p></div><button type="button" aria-label="关闭分类编辑" disabled={busy} onClick={() => setDraft(null)}><X size={18} /></button></header>
            <div className="finance-root-editor-body">
              <label><span>分类名称 <em>必填</em></span><input autoFocus aria-label="分类名称" placeholder="请输入分类名称" maxLength={60} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
              <label><span>分类标识</span><input aria-label="分类标识" placeholder="不填则自动取首字母" maxLength={12} value={draft.categoryCode ?? ''} onChange={(e) => setDraft({ ...draft, categoryCode: e.target.value })} /></label>
              <details><summary>分类说明</summary><label><span>分类说明</span><input aria-label="分类说明" maxLength={200} value={draft.subtitle} onChange={(e) => setDraft({ ...draft, subtitle: e.target.value })} /></label></details>
              <div className="finance-root-editor-preview"><span>分类用途</span><strong>该分类会显示为{def.label}主页的一张顶级分类卡片</strong></div>
              {error && <p role="alert" className="notice error">{error}</p>}
            </div>
            <footer><button type="button" className="res-btn" disabled={busy} onClick={() => setDraft(null)}>取消</button><button type="submit" className="res-btn primary" disabled={busy || !draft.name.trim()}>保存分类</button></footer>
          </form>
        </div>
      )}
      {contact && <div className="finance-home-guide"><strong>选择{noun}分类</strong><span>点击卡片进入分类；分类维护操作仅在管理状态下显示。</span></div>}
      <div className="hier-grid">
        {cards.map((c) => (
          <article key={c.key} className={`hier-card ${cfg.kind === 'tab' ? TAB_ACCENT[c.key] ?? 'green' : String(c.rec?.data.accent ?? (type === 'finance-suppliers' ? ['green', 'green', 'green', 'green', 'orange', 'purple', 'green'][c.idx] : ['green', 'blue', 'orange', 'purple'][c.idx]) ?? 'green')}`} role="button" tabIndex={0}
            draggable={managing && !!c.rec}
            onDragStart={(e) => { if (!c.rec) return; setDragId(c.rec.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(c.rec.id)); }}
            onDragOver={(e) => { if (dragId !== null && c.rec && dragId !== c.rec.id) e.preventDefault(); }}
            onDragEnd={() => setDragId(null)}
            onDrop={(e) => {
              e.preventDefault();
              const from = roots.findIndex(r => r.node.id === dragId);
              setDragId(null);
              if (from < 0 || !c.rec || from === c.idx) return;
              const next = [...roots]; const [moved] = next.splice(from, 1); next.splice(c.idx, 0, moved);
              void reorderRoots(next);
            }}
            onClick={() => onEnter({ key: c.key, title: c.title, subtitle: c.subtitle, rootId: c.rootId })}
            onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onEnter({ key: c.key, title: c.title, subtitle: c.subtitle, rootId: c.rootId }); } }}>
            <span className="hier-card-name">{c.title}</span><strong className="hier-card-count">{c.count}</strong>
            <small>{c.subtitle}</small>
            {c.foot && <em>{c.foot}</em>}
            {managing && c.rec && (
              <div className="hier-card-acts" onClick={(e) => e.stopPropagation()}><GripVertical size={16} aria-label="拖动排序" />
                <button type="button" className="res-btn sm" disabled={busy || c.idx === 0} aria-label={`前移：${c.title}`} onClick={() => void move(c.idx, -1)}>←</button>
                <button type="button" className="res-btn sm" disabled={busy || c.idx === cards.length - 1} aria-label={`后移：${c.title}`} onClick={() => void move(c.idx, 1)}>→</button>
                <button type="button" className="res-btn sm" onClick={() => setDraft({ id: c.rec!.id, name: c.rec!.title, subtitle: String(c.rec!.data.subtitle ?? ''), categoryCode: String(c.rec!.data.categoryCode ?? '') })}>编辑</button>
                {catCan('delete') && <button type="button" className="res-btn sm danger-text" onClick={() => setDeleting(c.rec!)}>删除</button>}
              </div>
            )}
          </article>
        ))}
      </div>
      {cards.length === 0 && (
        <div className="res-empty">
          <p>暂无{def.hierarchy?.kind === 'tab' ? '档案类型' : `${def.label.replace('档案', '')}分类`}。{can('create') ? '可以先新增顶级分类，再逐级建立。' : ''}</p>
          {seedable && <button type="button" className="res-btn" disabled={busy} onClick={() => void seed()}>{type === 'finance-fee-items' ? '导入默认费用档案' : '导入默认分类'}</button>}
        </div>
      )}
      {type === 'finance-fee-items' && <FeeSnapshotsDialog embedded canWrite={can('create')} canDelete={can('delete')} onClose={() => undefined} onRestored={refresh} />}
      {typesOpen && <ArchiveTypeDialog counts={counts} onClose={() => setTypesOpen(false)} onChanged={refresh} />}
      {snapshots && <FeeSnapshotsDialog createOnly canWrite={can('create')} canDelete={can('delete')} onClose={() => setSnapshots(false)} onRestored={refresh} />}
      {deleting && (
        <ReasonDialog
          title={`删除「${deleting.title}」`}
          hint="下面还有下级分类或资料的顶级分类不能删除（会提示原因）。删除要写原因，会留在操作记录里。"
          confirmLabel="确认删除" danger
          onClose={() => setDeleting(null)}
          onConfirm={async (reason) => { await resourceApi.remove(catType, deleting.id, reason); clearRefCache(catType); setDeleting(null); refresh(); }}
        />
      )}
    </div>
  );
}
