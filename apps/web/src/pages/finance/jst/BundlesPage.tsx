import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { getResourceDef } from '@kudesi/shared';
import { ApiError } from '../../../api/client';
import { useAuth } from '../../../auth/AuthContext';
import { CopyButton } from '../../../resources/CopyValue';
import { downloadText } from '../../../resources/csv';
import { displayValue, statusOf } from '../../../resources/format';
import { ImportDialog } from '../../../resources/ImportDialog';
import { RecordDetail, useResourceCan } from '../../../resources/RecordDetail';
import { resourceApi, type ListResult, type ResourceDto } from '../../../resources/api';
import { Pager, money } from '../common';
import { BundleProfileEditor } from '../../../resources/BundleProfileEditor';
import { CodeCategoryDirectory } from './CodeCategoryDirectory';
import { CodeVerificationTabs } from './CodeVerificationTabs';
import { BundleManualDialog } from './BundleManualDialog';
import { BundleRegenDialog } from './BundleRegenDialog';
import { BundleVerifyDialog, GenerateDialog, NamingCenterDialog, RemoveDialog, RevisionDialog } from './BundleDialogs';
import { jstApi } from './jstApi';
import { CodeSyncDialog } from './CodeSyncDialog';
import { BundleBomDialog } from './BundleBomDialog';

const TYPE = 'finance-bundles';
const ROLE_OPTIONS = getResourceDef('finance-bundle-lines')?.fields.find((f) => f.key === 'role')?.options ?? [];
const roleLabel = (v: string) => ROLE_OPTIONS.find((o) => o.value === v)?.label ?? v;
const TABS: Array<[string, string]> = [['', '全部'], ['pending', '待验证'], ['reverify', '需重新验证'], ['verified', '已验证'], ['archived', '失效归档']];

/** 商品组合编码：状态页签带数量；批量生成（多平台）、命名中心、核对验证、构成修订、删除/归档。普通增删改查沿用通用资料接口。 */
export function BundlesPage() {
  const def = getResourceDef(TYPE)!;
  const can = useResourceCan(TYPE);
  const { user, can: canAny } = useAuth();
  const isAdmin = !!user?.permissions.isCompanyAdmin;
  const canCost = canAny('product.cost.view'), canPrice = canAny('product.price.view');
  const [tab, setTab] = useState('pending');
  const [keyword, setKeyword] = useState('');
  const [pageSize, setPageSize] = useState(30);
  const [sync, setSync] = useState<string | null>(null);
  const [reuse,setReuse] = useState<ResourceDto | null>(null);
  const [detailTab, setDetailTab] = useState<string | undefined>();
  const [bom,setBom] = useState<ResourceDto | null>(null);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResult | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [checked, setChecked] = useState<number[]>([]);
  const [dialog, setDialog] = useState<'generate' | 'naming' | 'import' | 'regen' | null>(null);
  const [verifyIds, setVerifyIds] = useState<number[] | null>(null);
  const [revise, setRevise] = useState<ResourceDto | null>(null);
  const [remove, setRemove] = useState<ResourceDto | null>(null);
  const [profile, setProfile] = useState<ResourceDto | null>(null);
  const [manual, setManual] = useState<ResourceDto | null>(null);
  const [categoryId, setCategoryId] = useState('');
  const [platform,setPlatform] = useState('');
  const [platforms,setPlatforms] = useState<ResourceDto[]>([]);
  useEffect(()=>{resourceApi.list('finance-platforms',{pageSize:200}).then(r=>setPlatforms(r.items)).catch(()=>setPlatforms([]));},[]);
  const [open, setOpen] = useState<Record<number, ResourceDto[] | 'loading' | 'error'>>({});
  async function toggleLines(id: number) {
    if (open[id]) { setOpen(({ [id]: _, ...rest }) => rest); return; }
    setOpen((o) => ({ ...o, [id]: 'loading' }));
    try { const r = await resourceApi.list('finance-bundle-lines', { fieldKey: 'bundleId', fieldValue: id, pageSize: 100 }); setOpen((o) => (o[id] ? { ...o, [id]: r.items } : o)); } catch { setOpen((o) => ({ ...o, [id]: 'error' })); }
  }
  const filtered = Boolean(keyword.trim() || categoryId || platform);

  const request=useRef(0);
  const reload = useCallback(async () => {
    const token=++request.current;
    try {
      const result=await resourceApi.list(TYPE, { page, pageSize, keyword: keyword.trim() || undefined, status: tab || undefined, showHidden: ['inactive','archived'].includes(tab), filters: { ...(categoryId ? {bundleCategoryId:categoryId} : {}), ...(platform ? {platformId:platform} : {}) } });
      const overview=await jstApi.bundleOverview();
      if(token!==request.current)return;
      setData(result);setCounts(overview.status);setError('');
    } catch (e) { if(token===request.current)setError(e instanceof ApiError ? e.message : '加载失败'); }
  }, [page, pageSize, keyword, tab, categoryId, platform]);
  useEffect(() => { const t = setTimeout(() => void reload(), 200); return () => {clearTimeout(t);request.current++;}; }, [reload]);

  const columns = ['code', 'styleCode', 'name', 'platformId'].map((k) => def.fields.find((f) => f.key === k)!);
  const rows = data?.items ?? [];
  const verifiable = rows.filter((r) => checked.includes(r.id) && ['pending', 'reverify'].includes(r.status));
  const one = rows.find((r) => r.id === checked[0]);

  return (
    <div className="finance-code-page">
      <div className="page-head code-page-title">
        <div><h1>商品组合编码</h1><p>销售组合装，对标聚水潭组合装商品</p></div>

      </div>
      <div className="code-bundle-entries"><button type="button" className="secondary-button" onClick={()=>setDialog('naming')}>组合品编码配置中心</button>{can('create') && <button type="button" className="primary-button" onClick={()=>setDialog('generate')}>SKU批量申请</button>}</div>
      <CodeVerificationTabs value={tab} counts={counts} onChange={status=>{setTab(status);setPage(1);setChecked([]);}} />
      <div className="tree-layout">
      <CodeCategoryDirectory type="finance-bundles" status={tab} value={categoryId} onPick={id=>{setCategoryId(id);setPage(1);setChecked([]);}} reloadKey={counts} onChanged={()=>void reload()} />
      <section className="card code-list-panel">
        <header className="code-list-heading"><h2>组合编码（{data?.total ?? 0}）</h2>          <details className="code-extra-actions"><summary>更多操作</summary>        <div className="pill-row">
          {canAny('finance.jst-sync.view') && <button type="button" className="secondary-button" onClick={() => setSync('')}>聚水潭同步维护</button>}

          {can('edit') && <button type="button" className="secondary-button" disabled={checked.length !== 1 || one?.status === 'archived'} onClick={() => one && setRevise(one)}>修改构成</button>}
          {can('edit') && <button type="button" className="secondary-button" disabled={checked.length !== 1 || one?.status === 'archived'} onClick={() => one && setManual(one)}>改码 / 改名</button>}
          {can('delete') && <button type="button" className="secondary-button" disabled={checked.length !== 1} onClick={() => one && setRemove(one)}>删除 / 归档</button>}
          <button type="button" className="secondary-button" onClick={() => setDialog('naming')}>命名中心</button>
          {can('edit') && <button type="button" className="secondary-button" onClick={() => setDialog('regen')}>按新规则重生成编码</button>}
          {can('import') && <button type="button" className="secondary-button" onClick={() => setDialog('import')}>导入</button>}
          {can('export') && <button type="button" className="secondary-button" onClick={async () => { try { const o = await resourceApi.export(TYPE, true); downloadText(o.filename, o.csv); } catch (e) { setError(e instanceof ApiError ? e.message : '导出失败'); } }}>导出</button>}
          {can('create') && <button type="button" className="primary-button" onClick={() => setDialog('generate')}>＋ 新建组合编码</button>}
        </div></details></header>
        <div className="toolbar"><input className="grow" aria-label="搜索" placeholder="搜索组合编码、名称" value={keyword} onChange={(e) => { setKeyword(e.target.value); setPage(1); }} /><label>销售平台<select aria-label="销售平台筛选" value={platform} onChange={e=>{setPlatform(e.target.value);setPage(1);}}><option value="">全部平台</option>{platforms.map(p=><option key={p.id} value={p.id}>{p.title}</option>)}</select></label><label>资料状态<select aria-label="组合编码状态" value={tab} onChange={e=>{setTab(e.target.value);setPage(1);setChecked([]);}}>{[...TABS,['inactive','已停用']].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><button type="button" className="secondary-button" onClick={() => { setPage(1); void reload(); }}>查询</button></div>
          <div className="code-selection-bar"><span>已选 {checked.length} 条</span>          {can('edit') && <button type="button" className="primary-button" disabled={verifiable.length === 0} onClick={() => setVerifyIds(verifiable.map((r) => r.id))}>批量验证{verifiable.length ? `（${verifiable.length}）` : ''}</button>}</div>

        {error && <div role="alert" className="notice error">{error}</div>}
        <div className="table-scroll"><table className="data-table cards-narrow">
          <thead><tr>
            <th style={{ width: 32 }}><input type="checkbox" aria-label="本页全选" checked={rows.length > 0 && rows.every((r) => checked.includes(r.id))} onChange={(e) => setChecked(e.target.checked ? [...new Set([...checked, ...rows.map((r) => r.id)])] : checked.filter((id) => !rows.some((r) => r.id === id)))} /></th>
            <th>组合编码</th><th>主款式编码</th><th>款式编码</th><th>商品名称 / 简称</th><th>平台</th><th>规格</th>{(canCost || canPrice) && <th>成本价 / 销售价</th>}<th>重量</th><th>组成</th><th>包装</th><th>状态</th><th>操作</th>
          </tr></thead>
          <tbody>
            {rows.map((row) => {
              const st = statusOf(def, row.status);
              const lines = open[row.id];
              return (
                <Fragment key={row.id}>
                <tr className={row.id === selected ? 'selected' : undefined} onClick={() => setSelected(row.id)}>
                  <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`勾选 ${row.title}`} checked={checked.includes(row.id)} onChange={(e) => setChecked(e.target.checked ? [...checked, row.id] : checked.filter((id) => id !== row.id))} /></td>
                  <td data-label="组合编码">{String(row.data.code ?? '')}<CopyButton value={String(row.data.code ?? '')} label="组合编码"/></td>
                  <td data-label="主款式编码">{row.catalog?.mainStyleCode || '—'}</td><td data-label="款式编码">{String(row.data.styleCode || '—')}</td><td data-label="商品名称 / 简称"><strong>{String(row.data.name || '—')}</strong><small className="code-cell-secondary">{String(row.data.shortName || '')}</small></td><td data-label="平台">{row.refLabels.platformId || '—'}</td><td data-label="规格">{String(row.data.manualPropertiesValue || row.data.propertiesValue || '—')}</td>
                  {(canCost || canPrice) && <td data-label="成本价 / 销售价">{canCost && <span>{money(row.catalog?.costCents)}</span>}{canPrice && <small className="code-cell-secondary">{money(row.catalog?.saleCents)}</small>}</td>}
                  <td data-label="重量">{row.catalog?.weightG == null ? '—' : `${row.catalog.weightG / 1000} kg`}</td><td data-label="组成">{row.catalog?.composition.map((l,i)=><small className="code-cell-secondary" key={i}>{l.name} × {l.qty} {l.unit}</small>) ?? '—'}</td><td data-label="包装">{row.catalog?.packaging.map((l,i)=><small className="code-cell-secondary" key={i}>{l.name} × {l.qty} {l.unit}</small>) ?? '—'}</td>
                  <td data-label="状态"><span className={`pill ${st.tone === 'muted' ? 'warn' : st.tone}`}>{st.label}</span>{typeof row.data.pendingRevisionId === 'number' && <span className="pill warn">有待发布修订</span>}</td>
                  <td className="row-actions" onClick={(e) => e.stopPropagation()}><button type="button" className="link-button" onClick={() => { setDetailTab(undefined); setSelected(row.id); }}>查看</button>{can('edit') && row.status !== 'archived' && <><button type="button" className="link-button" onClick={() => setManual(row)}>改码 / 改名</button>{can('create') && <button type="button" className="link-button" onClick={()=>setReuse(row)}>跨平台复用</button>}<button type="button" className="link-button" onClick={() => setRevise(row)}>修改组成</button></>}<button type="button" className="link-button" onClick={() => setBom(row)}>BOM</button>{can('delete') && <button type="button" className="link-button danger" onClick={() => setRemove(row)}>删除</button>}{canAny('finance.jst-sync.view') && <button type="button" className="link-button" onClick={() => setSync(String(row.data.code ?? ''))}>同步</button>}<button type="button" className="link-button" aria-expanded={Boolean(lines)} onClick={() => void toggleLines(row.id)}>{lines ? '收起构成' : '展开构成'}</button>{can('edit') && row.status !== 'archived' && <button type="button" className="link-button" onClick={() => setProfile(row)}>编辑</button>}{can('edit') && ['pending', 'reverify'].includes(row.status) && <button type="button" className="secondary-button small" onClick={() => setVerifyIds([row.id])}>核对</button>}</td>
                </tr>
                {lines && (
                  <tr className="bundle-lines-row"><td colSpan={(canCost || canPrice ? 13 : 12)}>
                    {lines === 'loading' ? <span className="muted" role="status">正在加载构成…</span> : lines === 'error' ? <span className="muted">构成加载失败，请重试</span> : lines.length === 0 ? <span className="muted">这个组合还没有构成行</span> : (
                      <ul className="plain-list">{lines.map((l) => <li key={l.id}>{l.refLabels.baseCodeId || l.refLabels.laborId || l.title} × {String(l.data.qty ?? '')}{l.data.unit ? ` ${String(l.data.unit)}` : ''} <span className="muted">{roleLabel(String(l.data.role ?? ''))}</span></li>)}</ul>
                    )}
                  </td></tr>
                )}
                </Fragment>
              );
            })}
            {data && rows.length === 0 && <tr><td colSpan={(canCost || canPrice ? 13 : 12)} className="muted center">没有匹配的组合{filtered && <> <button type="button" className="link-button" onClick={() => { setKeyword(''); setCategoryId(''); setPlatform(''); setPage(1); }}>清除搜索和分类</button></>}</td></tr>}
            {!data && !error && <tr><td colSpan={(canCost || canPrice ? 13 : 12)} className="muted center">加载中…</td></tr>}
          </tbody>
        </table></div>
        <div className="card-foot between"><span>共 {data?.total ?? 0} 条</span><label>每页条数<select aria-label="每页条数" value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(1); setChecked([]); }}>{[10,20,30,50].map(n => <option key={n} value={n}>{n}</option>)}</select></label><Pager page={page} total={data?.total ?? 0} pageSize={pageSize} onPage={setPage} /></div>
      </section>
      </div>
      {profile && <BundleProfileEditor record={profile} onClose={() => setProfile(null)} onSaved={() => { setProfile(null); void reload(); }} />}
      {selected !== null && <RecordDetail def={def} id={selected} initialTab={detailTab} onClose={() => { setSelected(null); setDetailTab(undefined); }} onChanged={() => void reload()} />}
      {sync !== null && <CodeSyncDialog type={TYPE} code={sync} onClose={() => setSync(null)} onChanged={() => void reload()} />}
      {bom && <BundleBomDialog bundle={bom} onClose={()=>setBom(null)} onRevise={()=>{setRevise(bom);setBom(null);}}/>}
      {dialog === 'import' && <ImportDialog def={def} onClose={() => setDialog(null)} onDone={() => { setDialog(null); void reload(); }} />}
      {reuse && <GenerateDialog sourceBundle={reuse} onClose={()=>setReuse(null)} onDone={()=>void reload()}/>}
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
