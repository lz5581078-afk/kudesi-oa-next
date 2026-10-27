import { useCallback, useEffect, useMemo, useState } from 'react';
import { PARTY_SEED_CATEGORIES, archivePolicyOf, getResourceDef, treeFilterField, type FieldDef } from '@kudesi/shared';
import { ApiError, api } from '../api/client';
import { downloadText } from './csv';
import { resourceApi, type ListResult } from './api';
import { displayValue, statusOf } from './format';
import { CategoryTree } from './CategoryTree';
import { ImportDialog } from './ImportDialog';
import { TaxPendingDialog } from './TaxPendingDialog';
import { ReasonLibraryDialog } from './ReasonLibraryDialog';
import { RecordDetail, useResourceCan } from './RecordDetail';
import { RecordForm } from './RecordForm';

const PAGE_SIZE = 20;

function useColumns(type: string, all: FieldDef[], defaults: FieldDef[]) {
  const key = `kudesi.cols.${type}`;
  const [keys, setKeys] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? 'null') as string[] | null;
      if (saved?.length) return saved.filter((k) => all.some((f) => f.key === k));
    } catch {
      /* 存储不可用时用默认列 */
    }
    return defaults.map((f) => f.key);
  });
  const update = (next: string[]) => {
    setKeys(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* 忽略 */
    }
  };
  return [keys, update] as const;
}

/** 通用资料页：列表（搜索/分类页签/状态/分页/列设置）+ 右侧详情抽屉 + 新增/导入/导出，全部由资源定义生成。 */
export function ResourcePage({ type, lockedTab, title }: { type: string; lockedTab?: string; title?: string }) {
  const def = getResourceDef(type)!;
  const can = useResourceCan(type);
  const [keyword, setKeyword] = useState('');
  const [tab, setTab] = useState(lockedTab ?? '');
  const [status, setStatus] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [archived, setArchived] = useState(false);
  const [filterVals, setFilterVals] = useState<Record<string, string>>({});
  const [filterOpts, setFilterOpts] = useState<Record<string, Array<{ id: number | string; label: string }>>>({});
  const treeField = useMemo(() => treeFilterField(def), [def]);
  const filterFields = useMemo(
    () => (def.filterBy ? ([] as string[]).concat(def.filterBy as string | string[]) : []).map((k) => def.fields.find((f) => f.key === k)).filter((f): f is FieldDef => Boolean(f)),
    [def],
  );
  useEffect(() => {
    setFilterVals({});
    setFilterOpts({});
    for (const f of filterFields) {
      if (f.ref === 'user') {
        resourceApi.users().then((list) => setFilterOpts((o) => ({ ...o, [f.key]: list.map((u) => ({ id: u.id, label: u.name })) }))).catch(() => undefined);
      } else if (f.ref) {
        resourceApi.list(f.ref, { pageSize: 200, showHidden: true }).then((r) => setFilterOpts((o) => ({ ...o, [f.key]: r.items.map((i) => ({ id: i.id, label: i.title })) }))).catch(() => undefined);
      } else if (f.options) {
        setFilterOpts((o) => ({ ...o, [f.key]: f.options!.map((x) => ({ id: x.value, label: x.label })) }));
      }
    }
  }, [filterFields]);
  const [catPath, setCatPath] = useState('');
  const [page, setPage] = useState(1);
  const [checked, setChecked] = useState<number[]>([]);
  const [batchMsg, setBatchMsg] = useState('');
  const batchFields = (def.batch ?? []).filter((k) => k !== 'status').map((k) => def.fields.find((f) => f.key === k)).filter((f): f is FieldDef => Boolean(f));
  const [batchField, setBatchField] = useState('');
  const [batchValue, setBatchValue] = useState('');
  const [data, setData] = useState<ListResult | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [copyInit, setCopyInit] = useState<Record<string, unknown> | null>(null);
  const [importing, setImporting] = useState(false);
  const [columnMenu, setColumnMenu] = useState(false);
  const [reasonLib, setReasonLib] = useState(false);
  const [taxPending, setTaxPending] = useState(false);
  const libType = type === 'stores' ? 'store-abnormal-reasons' : type === 'phones' ? 'phone-abnormal-reasons' : '';
  const libCan = useResourceCan(libType || type);

  const shownFields = useMemo(() => def.fields.filter((f) => f.type !== 'secret'), [def]);
  const defaults = useMemo(() => def.fields.filter((f) => f.list), [def]);
  const [colKeys, setColKeys] = useColumns(type, shownFields, defaults);
  const columns = colKeys.map((k) => def.fields.find((f) => f.key === k)).filter((f): f is FieldDef => Boolean(f));
  const tabField = def.tabsBy ? def.fields.find((f) => f.key === def.tabsBy) : undefined;

  // 切换资料类型时重置筛选
  useEffect(() => {
    setKeyword('');
    setTab(lockedTab ?? '');
    setStatus('');
    setShowHidden(false);
    setPage(1);
    setSelected(null);
    setData(null);
  }, [type, lockedTab]);

  const load = useCallback(async () => {
    try {
      setData(await resourceApi.list(type, { page, pageSize: PAGE_SIZE, keyword: keyword.trim() || undefined, tab: tab || undefined, status: status || undefined, showHidden, archived, filters: filterVals }));
      setError('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '加载失败');
    }
  }, [type, page, keyword, tab, status, showHidden, archived, filterVals]);

  useEffect(() => { setArchived(false); }, [type]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 200); // 输入搜索时稍作防抖
    return () => clearTimeout(t);
  }, [load]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const hiddenExists = def.statuses.some((s) => s.hidden);

  const [seeding, setSeeding] = useState(false);
  async function seedFees() {
    if (!window.confirm('把旧程序里的费用类别树和费用项目（约 380 项）导入进来？已经有的编号不会重复，也不会被覆盖。')) return;
    setSeeding(true);
    setError('');
    try {
      const r = await api<{ categoriesCreated: number; itemsCreated: number }>('/finance/fee-archive/seed', { method: 'POST', body: {} });
      window.alert(`导入完成：新增费用类别 ${r.categoriesCreated} 个、费用项目 ${r.itemsCreated} 个。`);
      window.location.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '导入失败');
    } finally {
      setSeeding(false);
    }
  }

  function newInitial(): Record<string, unknown> | undefined {
    const init: Record<string, unknown> = {};
    if (tab && def.tabsBy) init[def.tabsBy] = tab;
    const cat = treeField ? Number(filterVals[treeField.key]) : 0;
    if (treeField && cat) init[treeField.key] = treeField.type === 'refs' ? [cat] : cat;
    return Object.keys(init).length ? init : undefined;
  }

  async function doExport() {
    try {
      const out = await resourceApi.export(type, showHidden);
      downloadText(out.filename, out.csv);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '导出失败');
    }
  }

  return (
    <div className="split">
      <section className="split-main">
        <div className="page-head">
          <h1>{title ?? def.label}</h1>
          <div className="pill-row">
            {type === 'finance-fee-items' && can('create') && <button type="button" className="secondary-button" disabled={seeding} onClick={seedFees}>{seeding ? '导入中…' : '导入默认费用档案'}</button>}
            {(type === 'finance-supplier-categories' || type === 'finance-customer-categories') && can('create') && (
              <button type="button" className="secondary-button" onClick={async () => {
                try {
                  const have = new Set((await resourceApi.list(type, { pageSize: 200, showHidden: true })).items.map((i) => i.title));
                  let n = 0;
                  for (const [name, subtitle] of PARTY_SEED_CATEGORIES[type]) if (!have.has(name)) { await resourceApi.create(type, { name, subtitle }); n++; }
                  setBatchMsg(n ? `已导入 ${n} 个默认分类` : '默认分类都已经有了');
                  void load();
                } catch (e) { setBatchMsg(e instanceof ApiError ? e.message : '导入失败'); }
              }}>导入默认分类</button>
            )}
            {type === 'tax-profiles' && can('create') && <button type="button" className="secondary-button" onClick={() => setTaxPending(true)}>待生成</button>}
            {libType && libCan('view') && <button type="button" className="secondary-button" onClick={() => setReasonLib(true)}>异常原因库</button>}
            {can('import') && <button type="button" className="secondary-button" onClick={() => setImporting(true)}>导入</button>}
            {can('export') && <button type="button" className="secondary-button" onClick={doExport}>导出</button>}
            {can('create') && <button type="button" className="primary-button" onClick={() => setCreating(true)}>＋ 新增</button>}
          </div>
        </div>
        <div className={treeField ? 'tree-layout' : undefined}>
        {treeField && (
          <CategoryTree
            type={type}
            field={treeField.key}
            tab={tab}
            status={status}
            showHidden={showHidden}
            value={filterVals[treeField.key] ?? ''}
            reloadKey={data?.total}
            onPath={setCatPath}
            onSelect={(id) => { setFilterVals((v) => ({ ...v, [treeField.key]: id })); setPage(1); }}
          />
        )}
        <div className="card">
          {tabField && !lockedTab && (
            <div className="tab-group page-tabs" role="tablist" aria-label="分类">
              <button type="button" role="tab" aria-selected={tab === ''} className={tab === '' ? 'chip active' : 'chip'} onClick={() => { setTab(''); setPage(1); if (treeField) setFilterVals((v) => ({ ...v, [treeField.key]: '' })); }}>全部</button>
              {tabField.options?.map((o) => (
                <button key={o.value} type="button" role="tab" aria-selected={tab === o.value} className={tab === o.value ? 'chip active' : 'chip'} onClick={() => { setTab(o.value); setPage(1); if (treeField) setFilterVals((v) => ({ ...v, [treeField.key]: '' })); }}>
                  {o.label}{data?.tabCounts ? ` ${data.tabCounts[o.value] ?? 0}` : ''}
                </button>
              ))}
            </div>
          )}
          <div className="toolbar">
            <input className="grow" placeholder="搜索（多个词用空格隔开）" aria-label="搜索" value={keyword} onChange={(e) => { setKeyword(e.target.value); setPage(1); }} />
            {filterFields.filter((ff) => ff.key !== treeField?.key).map((ff) => (
              <select key={ff.key} aria-label={ff.label} value={filterVals[ff.key] ?? ''} onChange={(e) => { setFilterVals((v) => ({ ...v, [ff.key]: e.target.value })); setPage(1); }}>
                <option value="">{ff.label}：全部</option>
                {(filterOpts[ff.key] ?? []).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            ))}
            <select aria-label="状态" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              <option value="">状态：全部</option>
              {def.statuses.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            {archivePolicyOf(type) && (
              <button type="button" className={archived ? 'secondary-button active' : 'secondary-button'} aria-pressed={archived} onClick={() => { setArchived((v) => !v); setPage(1); }}>
                已归档{data?.archivedCount !== undefined ? ` ${data.archivedCount}` : ''}
              </button>
            )}
            {hiddenExists && !status && !archived && (
              <label className="check"><input type="checkbox" checked={showHidden} onChange={(e) => { setShowHidden(e.target.checked); setPage(1); }} /> 显示{def.statuses.filter((s) => s.hidden).map((s) => s.label).join('/')}</label>
            )}
            <div className="menu-wrap">
              <button type="button" className="secondary-button" aria-expanded={columnMenu} onClick={() => setColumnMenu((v) => !v)}>显示列</button>
              {columnMenu && (
                <div className="menu card" role="menu">
                  {shownFields.map((f) => (
                    <label key={f.key} className="check">
                      <input
                        type="checkbox"
                        checked={colKeys.includes(f.key)}
                        onChange={(e) => setColKeys(e.target.checked ? [...colKeys, f.key] : colKeys.filter((k) => k !== f.key))}
                      />
                      {f.label}
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>
          {catPath && <div className="muted" style={{ padding: '6px 12px' }}>当前分类：{catPath}（含下级分类）</div>}
          {error && <div role="alert" className="notice error m">{error}</div>}
          {def.batch && checked.length > 0 && (
            <div className="toolbar" role="group" aria-label="批量操作">
              <span>已勾选 {checked.length} 条</span>
              {can('edit') && batchFields.length > 0 && (
                <>
                  <select aria-label="批量修改字段" value={batchField} onChange={(e) => { setBatchField(e.target.value); setBatchValue(''); }}>
                    <option value="">批量修改…</option>
                    {batchFields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                  </select>
                  {batchField && (
                    <select aria-label="新的值" value={batchValue} onChange={(e) => setBatchValue(e.target.value)}>
                      <option value="">选择新的值</option>
                      {(filterOpts[batchField] ?? []).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                    </select>
                  )}
                  <button type="button" className="secondary-button" disabled={!batchField || !batchValue} onClick={async () => {
                    const f = def.fields.find((x) => x.key === batchField);
                    try {
                      const r = await resourceApi.batch(type, checked, { [batchField]: f?.type === 'refs' ? [Number(batchValue)] : f?.ref ? Number(batchValue) : batchValue });
                      setBatchMsg(`已修改 ${r.done} 条${r.failed.length ? `，${r.failed.length} 条失败：${r.failed.slice(0, 3).map((x) => `#${x.id} ${x.message}`).join('；')}` : ''}`);
                      setChecked([]); void load();
                    } catch (e) { setBatchMsg(e instanceof ApiError ? e.message : '批量修改失败'); }
                  }}>应用</button>
                </>
              )}
              {can('disable') && def.batch.includes('status') && def.statuses.filter((s) => s.value !== 'deleted').slice(0, 4).map((s) => (
                <button key={s.value} type="button" className="secondary-button" onClick={async () => {
                  const reason = s.requiresReason ? window.prompt(`批量改为“${s.label}”的原因`) : undefined;
                  if (s.requiresReason && !reason) return;
                  try {
                    const r = await resourceApi.batchStatus(type, checked, s.value, reason ?? undefined);
                    setBatchMsg(`已改为${s.label} ${r.done} 条${r.failed.length ? `，${r.failed.length} 条失败：${r.failed.slice(0, 3).map((x) => `#${x.id} ${x.message}`).join('；')}` : ''}`);
                    setChecked([]); void load();
                  } catch (e) { setBatchMsg(e instanceof ApiError ? e.message : '批量改状态失败'); }
                }}>批量{s.label}</button>
              ))}
              <button type="button" className="secondary-button" onClick={() => setChecked([])}>取消勾选</button>
            </div>
          )}
          {batchMsg && <div role="status" className="notice m">{batchMsg}</div>}
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  {def.batch && <th style={{ width: 32 }}><input type="checkbox" aria-label="本页全选" checked={!!data?.items.length && data.items.every((r) => checked.includes(r.id))} onChange={(e) => setChecked(e.target.checked ? [...new Set([...checked, ...(data?.items.map((r) => r.id) ?? [])])] : checked.filter((id) => !data?.items.some((r) => r.id === id)))} /></th>}
                  {columns.map((f) => <th key={f.key}>{f.label}</th>)}
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {data?.items.map((row) => {
                  const st = statusOf(def, row.status);
                  return (
                    <tr
                      key={row.id}
                      className={row.id === selected ? 'selected' : undefined}
                      tabIndex={0}
                      aria-selected={row.id === selected}
                      onClick={() => setSelected(row.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setSelected(row.id);
                        }
                      }}
                    >
                      {def.batch && <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`勾选 ${row.title}`} checked={checked.includes(row.id)} onChange={(e) => setChecked(e.target.checked ? [...checked, row.id] : checked.filter((id) => id !== row.id))} /></td>}
                      {columns.map((f) => <td key={f.key} className={f.type === 'money' ? 'num' : undefined}>{displayValue(f, row)}</td>)}
                      <td><span className={`pill ${st.tone === 'muted' ? 'warn' : st.tone}`}>{st.label}</span></td>
                    </tr>
                  );
                })}
                {data && data.items.length === 0 && (
                  <tr><td colSpan={columns.length + 2} className="muted center">没有匹配的{def.label}</td></tr>
                )}
                {!data && !error && <tr><td colSpan={columns.length + 2} className="muted center">加载中…</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="card-foot between">
            <span>共 {data?.total ?? 0} 条 · 点击一行在右侧查看，不跳转页面</span>
            <span className="pill-row">
              <button type="button" className="secondary-button" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
              <span>{page} / {totalPages}</span>
              <button type="button" className="secondary-button" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>下一页</button>
            </span>
          </div>
        </div>
        </div>
      </section>

      {selected !== null && <RecordDetail def={def} id={selected} onClose={() => setSelected(null)} onChanged={() => void load()} onCopy={def.batch ? (v) => { setCopyInit(v); setSelected(null); setCreating(true); } : undefined} />}

      {creating && (
        <RecordForm
          def={def}
          record={null}
          initial={copyInit ?? newInitial()}
          onClose={() => { setCreating(false); setCopyInit(null); }}
          onSaved={(dto) => {
            setCreating(false);
            setCopyInit(null);
            setSelected(dto.id);
            void load();
          }}
        />
      )}
      {taxPending && <TaxPendingDialog onClose={() => setTaxPending(false)} onCreated={() => void load()} />}
      {reasonLib && libType && <ReasonLibraryDialog libType={libType} title={type === 'stores' ? '店铺异常原因库' : '手机号异常原因库'} onClose={() => setReasonLib(false)} />}
      {importing && (
        <ImportDialog
          def={def}
          onClose={() => setImporting(false)}
          onDone={() => {
            setImporting(false);
            void load();
          }}
        />
      )}
    </div>
  );
}
