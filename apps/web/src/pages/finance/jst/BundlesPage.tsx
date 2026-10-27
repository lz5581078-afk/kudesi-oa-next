import { useCallback, useEffect, useState } from 'react';
import { getResourceDef } from '@kudesi/shared';
import { ApiError } from '../../../api/client';
import { useAuth } from '../../../auth/AuthContext';
import { downloadText } from '../../../resources/csv';
import { displayValue, statusOf } from '../../../resources/format';
import { ImportDialog } from '../../../resources/ImportDialog';
import { RecordDetail, useResourceCan } from '../../../resources/RecordDetail';
import { RecordForm } from '../../../resources/RecordForm';
import { resourceApi, type ListResult, type ResourceDto } from '../../../resources/api';
import { Pager } from '../common';
import { CategoryTree } from '../../../resources/CategoryTree';
import { BundleManualDialog } from './BundleManualDialog';
import { BundleRegenDialog } from './BundleRegenDialog';
import { BundleVerifyDialog, GenerateDialog, NamingCenterDialog, RemoveDialog, RevisionDialog } from './BundleDialogs';
import { jstApi } from './jstApi';

const TYPE = 'finance-bundles';
const TABS: Array<[string, string]> = [['', '全部'], ['pending', '待验证'], ['reverify', '需重新验证'], ['verified', '已验证'], ['archived', '失效归档']];

/** 商品组合编码：状态页签带数量；批量生成（多平台）、命名中心、核对验证、构成修订、删除/归档。普通增删改查沿用通用资料接口。 */
export function BundlesPage() {
  const def = getResourceDef(TYPE)!;
  const can = useResourceCan(TYPE);
  const { user } = useAuth();
  const isAdmin = !!user?.permissions.isCompanyAdmin;
  const [tab, setTab] = useState('pending');
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResult | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [checked, setChecked] = useState<number[]>([]);
  const [dialog, setDialog] = useState<'generate' | 'naming' | 'create' | 'import' | 'regen' | null>(null);
  const [verifyIds, setVerifyIds] = useState<number[] | null>(null);
  const [revise, setRevise] = useState<ResourceDto | null>(null);
  const [remove, setRemove] = useState<ResourceDto | null>(null);
  const [manual, setManual] = useState<ResourceDto | null>(null);
  const [categoryId, setCategoryId] = useState('');

  const reload = useCallback(async () => {
    try {
      setData(await resourceApi.list(TYPE, { page, pageSize: 20, keyword: keyword.trim() || undefined, status: tab || undefined, filters: categoryId ? { bundleCategoryId: categoryId } : undefined }));
      setCounts((await jstApi.bundleOverview()).status);
      setError('');
    } catch (e) { setError(e instanceof ApiError ? e.message : '加载失败'); }
  }, [page, keyword, tab, categoryId]);
  useEffect(() => { const t = setTimeout(() => void reload(), 200); return () => clearTimeout(t); }, [reload]);

  const columns = ['code', 'name', 'bundleCategoryId', 'platformId', 'scenarioId', 'jstStatus'].map((k) => def.fields.find((f) => f.key === k)!);
  const rows = data?.items ?? [];
  const verifiable = rows.filter((r) => checked.includes(r.id) && ['pending', 'reverify'].includes(r.status));
  const one = rows.find((r) => r.id === checked[0]);

  return (
    <div>
      <div className="page-head">
        <h1>商品组合编码</h1>
        <div className="pill-row">
          {can('edit') && <button type="button" className="primary-button" disabled={verifiable.length === 0} onClick={() => setVerifyIds(verifiable.map((r) => r.id))}>核对并验证{verifiable.length ? `（${verifiable.length}）` : ''}</button>}
          {can('edit') && <button type="button" className="secondary-button" disabled={checked.length !== 1 || one?.status === 'archived'} onClick={() => one && setRevise(one)}>修改构成</button>}
          {can('edit') && <button type="button" className="secondary-button" disabled={checked.length !== 1 || one?.status === 'archived'} onClick={() => one && setManual(one)}>改码 / 改名</button>}
          {can('delete') && <button type="button" className="secondary-button" disabled={checked.length !== 1} onClick={() => one && setRemove(one)}>删除 / 归档</button>}
          <button type="button" className="secondary-button" onClick={() => setDialog('naming')}>命名中心</button>
          {can('edit') && <button type="button" className="secondary-button" onClick={() => setDialog('regen')}>按新规则重生成编码</button>}
          {can('import') && <button type="button" className="secondary-button" onClick={() => setDialog('import')}>导入</button>}
          {can('export') && <button type="button" className="secondary-button" onClick={async () => { try { const o = await resourceApi.export(TYPE, true); downloadText(o.filename, o.csv); } catch (e) { setError(e instanceof ApiError ? e.message : '导出失败'); } }}>导出</button>}
          {can('create') && <button type="button" className="secondary-button" onClick={() => setDialog('create')}>＋ 单个新增</button>}
          {can('create') && <button type="button" className="primary-button" onClick={() => setDialog('generate')}>批量生成</button>}
        </div>
      </div>
      <div className="tab-group page-tabs" role="tablist" aria-label="验证状态">
        {TABS.map(([v, label]) => (
          <button key={v} type="button" role="tab" aria-selected={tab === v} className={tab === v ? 'chip active' : 'chip'} onClick={() => { setTab(v); setPage(1); setChecked([]); }}>
            {label} {v ? counts[v] ?? 0 : (counts.pending ?? 0) + (counts.reverify ?? 0) + (counts.verified ?? 0)}
          </button>
        ))}
      </div>
      <div className="tree-layout">
      <CategoryTree type={TYPE} field="bundleCategoryId" tab="bundle" status="" showHidden={false} value={categoryId} reloadKey={data?.total} onSelect={(id) => { setCategoryId(id); setPage(1); setChecked([]); }} />
      <section className="card">
        <div className="toolbar"><input className="grow" aria-label="搜索" placeholder="搜索组合编码、名称" value={keyword} onChange={(e) => { setKeyword(e.target.value); setPage(1); }} /></div>
        {error && <div role="alert" className="notice error">{error}</div>}
        <div className="table-scroll"><table className="data-table">
          <thead><tr>
            <th style={{ width: 32 }}><input type="checkbox" aria-label="本页全选" checked={rows.length > 0 && rows.every((r) => checked.includes(r.id))} onChange={(e) => setChecked(e.target.checked ? [...new Set([...checked, ...rows.map((r) => r.id)])] : checked.filter((id) => !rows.some((r) => r.id === id)))} /></th>
            {columns.map((f) => <th key={f.key}>{f.label}</th>)}<th>状态</th><th />
          </tr></thead>
          <tbody>
            {rows.map((row) => {
              const st = statusOf(def, row.status);
              return (
                <tr key={row.id} className={row.id === selected ? 'selected' : undefined} onClick={() => setSelected(row.id)}>
                  <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`勾选 ${row.title}`} checked={checked.includes(row.id)} onChange={(e) => setChecked(e.target.checked ? [...checked, row.id] : checked.filter((id) => id !== row.id))} /></td>
                  {columns.map((f) => <td key={f.key}>{displayValue(f, row)}</td>)}
                  <td><span className={`pill ${st.tone === 'muted' ? 'warn' : st.tone}`}>{st.label}</span>{typeof row.data.pendingRevisionId === 'number' && <span className="pill warn">有待发布修订</span>}</td>
                  <td onClick={(e) => e.stopPropagation()}>{can('edit') && ['pending', 'reverify'].includes(row.status) && <button type="button" className="secondary-button small" onClick={() => setVerifyIds([row.id])}>核对</button>}</td>
                </tr>
              );
            })}
            {data && rows.length === 0 && <tr><td colSpan={columns.length + 3} className="muted center">没有匹配的组合</td></tr>}
            {!data && !error && <tr><td colSpan={columns.length + 3} className="muted center">加载中…</td></tr>}
          </tbody>
        </table></div>
        <div className="card-foot between"><span>共 {data?.total ?? 0} 条 · 点击一行在右侧查看，组合构成在右侧“组合构成”里加减</span><Pager page={page} total={data?.total ?? 0} pageSize={20} onPage={setPage} /></div>
      </section>
      </div>
      {selected !== null && <RecordDetail def={def} id={selected} onClose={() => setSelected(null)} onChanged={() => void reload()} />}
      {dialog === 'create' && <RecordForm def={def} record={null} onClose={() => setDialog(null)} onSaved={(dto) => { setDialog(null); setSelected(dto.id); void reload(); }} />}
      {dialog === 'import' && <ImportDialog def={def} onClose={() => setDialog(null)} onDone={() => { setDialog(null); void reload(); }} />}
      {dialog === 'generate' && <GenerateDialog onClose={() => setDialog(null)} onDone={() => void reload()} />}
      {dialog === 'regen' && <BundleRegenDialog onClose={() => setDialog(null)} onDone={() => void reload()} />}
      {dialog === 'naming' && <NamingCenterDialog isAdmin={isAdmin} onClose={() => setDialog(null)} />}
      {verifyIds && <BundleVerifyDialog ids={verifyIds} isAdmin={isAdmin} onClose={() => setVerifyIds(null)} onDone={() => { setChecked([]); void reload(); }} />}
      {revise && <RevisionDialog bundle={revise} onClose={() => setRevise(null)} onDone={() => { setChecked([]); void reload(); }} />}
      {manual && <BundleManualDialog bundle={manual} onClose={() => setManual(null)} onDone={() => { setChecked([]); void reload(); }} />}
      {remove && <RemoveDialog bundle={remove} isAdmin={isAdmin} onClose={() => setRemove(null)} onDone={() => { setChecked([]); void reload(); }} />}
    </div>
  );
}
