import { FormEvent, useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { SearchPick, money, pct } from './common';
import { JstSyncItems } from './jst/JstSyncItems';
import { JstSyncExtras } from './jst/JstSyncExtras';
import { api } from '../../api/client';
import { CopyButton } from '../../resources/CopyValue';
import { financeApi, type MarginHistoryRow, type PricingHistoryRow, type OutboxJobRow, type ApiKeyRow, type CostSnapshotRow, type PackagingMatch, type ResetPreview, type SnapshotRow } from './financeApi';

const msg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message || '操作失败');
const when = (s: string) => new Date(s).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

/** 成本历史：每个组合每次成本/重量/运费/利润率/最低售价变化的快照。验证通过时自动登记，也能手工登记。 */
export function CostHistoryPage() {
  const [rows, setRows] = useState<CostSnapshotRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  // 三种记录：成本变更（每次成本/重量/运费/利润率/最低售价的变化）、售价维护（使用快递、单品利润率）、分类利润率调整
  const [source, setSource] = useState<'changes' | 'pricing' | 'margins'>('changes');
  const [pricingRows, setPricingRows] = useState<PricingHistoryRow[]>([]);
  const [marginRows, setMarginRows] = useState<MarginHistoryRow[]>([]);
  const load = () => {
    setError('');
    const q = { keyword: keyword || undefined, page };
    if (source === 'pricing') return financeApi.pricingHistory(q).then((r) => { setPricingRows(r.rows); setTotal(r.total); }).catch((e) => setError(msg(e)));
    if (source === 'margins') return financeApi.marginHistory(q).then((r) => { setMarginRows(r.rows); setTotal(r.total); }).catch((e) => setError(msg(e)));
    return financeApi.costHistory(q).then((r) => { setRows(r.rows); setTotal(r.total); }).catch((e) => setError(msg(e)));
  };
  useEffect(() => { void load(); }, [page, keyword, source]); // eslint-disable-line react-hooks/exhaustive-deps
  async function register() {
    setBusy(true); setError(''); setNotice('');
    try { const r = await financeApi.registerCost({ reason: '手工登记' }); setNotice(`登记了 ${r.recorded} 个组合的新成本，${r.unchanged} 个没有变化`); await load(); } catch (e) { setError(msg(e)); }
    setBusy(false);
  }
  const fmt = (k: string, v: number | null) => (v === null ? '—' : k === 'weightG' ? `${v}g` : k === 'marginPercent' ? `${v}%` : money(v));
  return (
    <div>
      <div className="page-head between"><h1>成本历史</h1><div className="toolbar"><select aria-label="历史类型" value={source} onChange={(e) => { setSource(e.target.value as typeof source); setPage(1); setKeyword(''); }}><option value="changes">成本变更记录</option><option value="pricing">售价维护记录</option><option value="margins">分类利润率记录</option></select><input aria-label="搜索组合" placeholder={source === 'margins' ? '搜索分类或修改原因' : '搜索组合编码或名称'} value={keyword} onChange={(e) => { setKeyword(e.target.value); setPage(1); }} />{source === 'changes' && <button type="button" className="secondary-button" disabled={busy} onClick={register}>{busy ? '登记中…' : '登记所有已验证组合的当前成本'}</button>}</div></div>
      <p className="muted">组合验证通过时会自动登记一次；成本、重量、运费、利润率或最低售价和上一次不同才会新增一条版本，没变化不重复记。</p>
      {notice && <div role="status" className="notice ok">{notice}</div>}
      {error && <div role="alert" className="notice error">{error}</div>}
      {source === 'pricing' && (
        <div className="table-scroll"><table className="data-table">
          <thead><tr><th>时间</th><th>组合</th><th>使用快递</th><th>单品利润率</th><th>操作人</th><th>修改原因</th></tr></thead>
          <tbody>
            {pricingRows.length === 0 && <tr><td colSpan={6} className="empty-state muted">还没有售价维护记录。在成本表里点“维护售价”保存后会出现在这里。</td></tr>}
            {pricingRows.map((r) => (
              <tr key={r.id}><td>{when(r.createdAt)}</td><td><strong>{r.code}</strong><div className="muted">{r.name}</div></td><td>{r.beforeCarrier || '未指定'} → <strong>{r.afterCarrier || '未指定'}</strong></td>
                <td>{r.beforePercent === null ? '继承' : pct(r.beforePercent)} → <strong>{r.afterPercent === null ? '继承' : pct(r.afterPercent)}</strong></td><td>{r.actorName}</td><td>{r.reason}</td></tr>
            ))}
          </tbody>
        </table></div>
      )}
      {source === 'margins' && (
        <div className="table-scroll"><table className="data-table">
          <thead><tr><th>时间</th><th>分类</th><th>利润率变化</th><th>操作人</th><th>修改原因</th></tr></thead>
          <tbody>
            {marginRows.length === 0 && <tr><td colSpan={5} className="empty-state muted">还没有分类利润率记录。</td></tr>}
            {marginRows.map((r) => (
              <tr key={r.id}><td>{when(r.createdAt)}</td><td>{r.scopeName}</td><td>{r.beforePercent === null ? '未设置（继承）' : pct(r.beforePercent)} → <strong>{r.afterPercent === null ? '未设置（继承）' : pct(r.afterPercent)}</strong></td><td>{r.actorName}</td><td>{r.reason}</td></tr>
            ))}
          </tbody>
        </table></div>
      )}
      {source === 'changes' && <div className="table-scroll"><table className="data-table">
        <thead><tr><th>时间</th><th>组合</th><th>版本</th><th className="num">发货前成本</th><th className="num">运费</th><th className="num">最低售价</th><th>相比上一版</th><th>登记人 / 原因</th></tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={8} className="empty-state muted">还没有成本历史。组合验证通过后会自动出现。</td></tr>}
          {rows.map((r) => (
            <tr key={r.id}><td>{when(r.createdAt)}</td><td><strong>{r.code}</strong><div className="muted">{r.name}</div></td><td>v{r.revision}</td>
              <td className="num">{fmt('p', r.preShipCostCents)}</td><td className="num">{fmt('f', r.freightCents)}</td><td className="num">{fmt('m', r.minPriceCents)}</td>
              <td>{r.revision === 1 ? <span className="muted">首版</span> : r.changes.map((c) => <div key={c.field}>{c.label}：{fmt(c.field, c.before)} → <strong>{fmt(c.field, c.after)}</strong></div>)}</td>
              <td>{r.actorName}<div className="muted">{r.reason}</div></td></tr>
          ))}
        </tbody>
      </table></div>}
      <div className="toolbar"><button type="button" className="secondary-button small" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button><span className="muted">共 {total} 条 · 第 {page} 页</span><button type="button" className="secondary-button small" disabled={page * 20 >= total} onClick={() => setPage(page + 1)}>下一页</button></div>
    </div>
  );
}

const SCENES = [['', '全部场景'], ['production', '生产包装'], ['supplier_oem', '供应商 OEM 包装'], ['dispatch', '发货包装']];
const TREAT: Record<string, string> = { include: '计入成本', included_in_parent: '含在上级内', reference_only: '仅参考' };

/** 包装方案匹配试算：输入对象和重量，看会命中哪个包装方案；同优先级命中多条会提示冲突。 */
export function PackagingMatchPage() {
  const [scene, setScene] = useState('');
  const [targetType, setTargetType] = useState<'bundle' | 'base_code' | 'product_archive'>('bundle');
  const [code, setCode] = useState('');
  const [weight, setWeight] = useState('');
  const [cat, setCat] = useState<{ id: number | null; name: string }>({ id: null, name: '' });
  const [brand, setBrand] = useState<{ id: number | null; name: string }>({ id: null, name: '' });
  const [scen, setScen] = useState<{ id: number | null; name: string }>({ id: null, name: '' });
  const [res, setRes] = useState<PackagingMatch | null>(null);
  const [error, setError] = useState('');
  async function run(e: FormEvent) {
    e.preventDefault(); setError('');
    try {
      setRes(await financeApi.packagingMatch({ usageScene: scene || undefined, targetType, targetCode: code.trim() || undefined, categoryId: cat.id ?? undefined, brandId: brand.id ?? undefined, scenarioId: scen.id ?? undefined, weightKg: weight.trim() ? Number(weight) : undefined }));
    } catch (er) { setError(msg(er)); }
  }
  return (
    <div>
      <div className="page-head"><h1>包装方案匹配试算</h1></div>
      <p className="muted">方案和匹配规则在“包装方案”里维护。这里只试算，不会改任何数据；没有命中时按业务规则保持无包装，不会自动补行。</p>
      <form className="form-grid" onSubmit={run}>
        <label>使用场景<select aria-label="使用场景" value={scene} onChange={(e) => setScene(e.target.value)}>{SCENES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label>对象类型<select aria-label="对象类型" value={targetType} onChange={(e) => setTargetType(e.target.value as 'bundle')}><option value="bundle">商品组合</option><option value="base_code">基础编码</option><option value="product_archive">商品档案</option></select></label>
        <label>编码<input aria-label="编码" value={code} onChange={(e) => setCode(e.target.value)} /></label>
        <label>重量（kg）<input aria-label="重量" inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} /></label>
        <label>分类<SearchPick ariaLabel="分类" type="finance-categories" value={cat.id} label={cat.name} onChange={(id, name) => setCat({ id, name })} /></label>
        <label>品牌<SearchPick ariaLabel="品牌" type="finance-brands" value={brand.id} label={brand.name} onChange={(id, name) => setBrand({ id, name })} /></label>
        <label>销售场景<SearchPick ariaLabel="销售场景" type="finance-scenarios" value={scen.id} label={scen.name} onChange={(id, name) => setScen({ id, name })} /></label>
        <div className="row-actions"><button className="primary-button" type="submit">试算</button></div>
      </form>
      {error && <div role="alert" className="notice error">{error}</div>}
      {res && (
        <section>
          {res.issues.map((i) => <div key={i.message} className="notice">{i.message}</div>)}
          {res.ambiguous && <div role="alert" className="notice error">有多条同优先级的规则同时命中，请在方案里调整优先级。</div>}
          {res.selected && (
            <>
              <h2 className="section-title">命中：{res.selected.scheme.name}（{res.selected.scheme.code}） <CopyButton value={matchText(res.selected)} label="匹配结果" /></h2>
              <table className="data-table"><thead><tr><th>包装档案</th><th className="num">数量</th><th className="num">损耗率</th><th>计价处理</th></tr></thead>
                <tbody>{res.selected.lines.map((l, i) => <tr key={i}><td>{l.componentName}</td><td className="num">{l.qty}</td><td className="num">{l.lossRate ?? 0}%</td><td>{TREAT[l.costTreatment] ?? l.costTreatment}</td></tr>)}</tbody></table>
            </>
          )}
          {res.matches.length > 1 && <p className="muted">全部命中：{res.matches.map((m) => `${m.schemeName}（优先级 ${m.priority}）`).join('、')}</p>}
        </section>
      )}
    </div>
  );
}

const matchText = (sel: NonNullable<PackagingMatch['selected']>) =>
  [`命中方案：${sel.scheme.name}（${sel.scheme.code}）`, ...sel.lines.map((l) => `${l.componentName}\t数量 ${l.qty}\t损耗率 ${l.lossRate ?? 0}%\t${TREAT[l.costTreatment] ?? l.costTreatment}`)].join('\n');

/** API 密钥：给外部程序只读已验证的组合。密钥只在创建时显示一次，库里只存哈希。 */
export function ApiKeysPage() {
  const [rows, setRows] = useState<ApiKeyRow[]>([]);
  const [name, setName] = useState('');
  const [scope, setScope] = useState('verified_bundle_read');
  const [fresh, setFresh] = useState<{ name: string; key: string } | null>(null);
  const [copyMsg, setCopyMsg] = useState('');
  const [showRevoked, setShowRevoked] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [revoking, setRevoking] = useState<ApiKeyRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = () => financeApi.apiKeys().then(setRows).catch((e) => setError(msg(e)));
  useEffect(() => { void load(); }, []);
  async function create(e: FormEvent) {
    e.preventDefault(); setError(''); setCopyMsg('');
    try { const k = await api<{ id: string; name: string; key: string }>('/finance/api-keys', { method: 'POST', body: { name, scope } }); setFresh({ name: k.name, key: k.key }); setName(''); await load(); } catch (er) { setError(msg(er)); }
  }
  async function revoke(r: ApiKeyRow) {
    setBusy(true); setError('');
    try { await financeApi.revokeApiKey(r.id); setRevoking(null); await load(); } catch (er) { setError(msg(er)); }
    setBusy(false);
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setCopyMsg('已复制'); } catch { setCopyMsg('复制失败，请手动选中上面的密钥复制'); }
  }
  const active = rows.filter((r) => !r.revokedAt);
  const listed = showRevoked ? rows : active;
  return (
    <div>
      <div className="page-head"><h1>API 密钥</h1></div>
      <p className="muted">外部程序带上 <code>X-API-Key</code> 只读取本公司数据，不能写入，也不需要员工登录。密钥撤销后立即失效。</p>
      <form className="toolbar" onSubmit={create}><select aria-label="密钥用途" value={scope} onChange={(e) => setScope(e.target.value)}><option value="verified_bundle_read">已验证组合</option><option value="company_catalog_read">商品与成本目录（含成本、利润率）</option></select><input aria-label="用途名称" placeholder="用途名称，如：聚水潭对账" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /><button className="primary-button" type="submit" disabled={!name.trim()}>创建密钥</button></form>
      {error && <div role="alert" className="notice error">{error}</div>}
      {fresh && (
        <div role="status" className="notice ok"><strong>「{fresh.name}」的密钥（只显示这一次，请立即保存）</strong>
          <input aria-label="新建 API 密钥" className="mono" style={{ width: '100%', margin: '8px 0' }} readOnly value={fresh.key} onFocus={(e) => e.target.select()} />
          <div className="row-actions"><button type="button" className="secondary-button small" onClick={() => void copy(fresh.key)}>复制密钥</button> <button type="button" className="secondary-button small" onClick={() => { setFresh(null); setShowGuide(true); }}>查看调用说明</button> <button type="button" className="secondary-button small" onClick={() => { setFresh(null); setCopyMsg(''); }}>我已保存</button>{copyMsg && <span>{copyMsg}</span>}</div></div>
      )}
      <div className="status-line"><strong>有效密钥 {active.length} 个</strong>
        <button type="button" className="link-button" onClick={() => setShowRevoked((v) => !v)}>{showRevoked ? '隐藏已撤销' : `查看已撤销（${rows.length - active.length}）`}</button>
        <button type="button" className="link-button" onClick={() => setShowGuide((v) => !v)}>{showGuide ? '收起调用说明' : '查看调用说明'}</button></div>
      {showGuide && (
        <div className="cost-box" aria-label="调用说明">
          <div>「已验证组合」密钥：<code>GET /api/external/v1/verified-bundles</code>（已验证组合的成本、运费、最低售价）。</div>
          <div>「商品与成本目录」密钥：<code>/api/external/catalog/v1/</code> 下的 <code>bundle-categories</code>、<code>cost-categories</code>、<code>sku-costs</code>、<code>bundle-codes</code>（用 afterId、limit 翻页，每页最多 100 条，可按 code 查）。</div>
          <div className="muted">两种密钥不能互相代替；先同步分类，再同步组合编码；分页游标不是增量游标。</div>
        </div>
      )}
      <div className="table-scroll"><table className="data-table stack-mobile">
        <thead><tr><th>用途</th><th>范围</th><th>密钥编号</th><th>创建时间</th><th>最近使用</th><th>状态</th><th /></tr></thead>
        <tbody>
          {listed.length === 0 && <tr><td colSpan={7} className="empty-state muted">{showRevoked ? '还没有密钥' : '没有有效密钥，用上面的表单创建一个'}</td></tr>}
          {listed.map((r) => <tr key={r.id}><td className="cell-title">{r.name}</td><td data-label="范围">{r.scope === 'company_catalog_read' ? '商品与成本目录' : '已验证组合'}</td><td data-label="密钥编号"><code>••••{String(r.id).slice(-8)}</code></td><td data-label="创建时间">{when(r.createdAt)}</td><td data-label="最近使用">{r.lastUsedAt ? when(r.lastUsedAt) : '从未'}</td><td data-label="状态">{r.revokedAt ? <span className="pill bad">已撤销</span> : <span className="pill ok">可用</span>}</td><td>{!r.revokedAt && <button type="button" className="secondary-button small" onClick={() => setRevoking(r)}>撤销</button>}</td></tr>)}
        </tbody>
      </table></div>
      {revoking && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal card small" role="alertdialog" aria-label="撤销密钥">
            <div className="modal-head"><strong>撤销密钥「{revoking.name}」</strong></div>
            <div className="modal-body"><p>撤销后，使用这个密钥的外部程序会立刻读不到数据，且不能恢复。</p>{error && <div role="alert" className="notice error">{error}</div>}</div>
            <div className="modal-foot"><button type="button" className="secondary-button" disabled={busy} onClick={() => setRevoking(null)}>取消</button><button type="button" className="primary-button" disabled={busy} onClick={() => void revoke(revoking)}>{busy ? '撤销中…' : '确认撤销'}</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 主数据整体重置：先自动留快照再清空商品基础资料；输入确认文本才执行；可以随时从快照恢复。 */
export function MasterResetPage() {
  const [includePlatforms, setIncludePlatforms] = useState(true);
  const [pre, setPre] = useState<ResetPreview | null>(null);
  const [snaps, setSnaps] = useState<SnapshotRow[]>([]);
  const [confirm, setConfirm] = useState('');
  const [restoreText, setRestoreText] = useState<Record<number, string>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => {
    try { setPre(await financeApi.resetPreview(includePlatforms)); setSnaps(await financeApi.snapshots()); } catch (e) { setError(msg(e)); }
  };
  useEffect(() => { void load(); }, [includePlatforms]); // eslint-disable-line react-hooks/exhaustive-deps
  async function reset() {
    setBusy(true); setError(''); setNotice('');
    try { const r = await financeApi.resetExecute({ confirm, includePlatforms }); setNotice(`已清空 ${r.totalDeleted} 条，备份快照 #${r.snapshot.id}`); setConfirm(''); await load(); } catch (e) { setError(msg(e)); }
    setBusy(false);
  }
  async function restore(s: SnapshotRow) {
    setBusy(true); setError(''); setNotice('');
    try { const r = await financeApi.restoreSnapshot(s.id, restoreText[s.id] ?? ''); setNotice(`已从快照 #${s.id} 恢复 ${r.restored} 条`); await load(); } catch (e) { setError(msg(e)); }
    setBusy(false);
  }
  return (
    <div>
      <div className="page-head"><h1>主数据重置</h1></div>
      <div className="notice error"><strong>危险操作。</strong>会清空商品档案、分类、品牌、基础编码、商品组合、包装方案、分类利润率，以及成本历史。执行前自动留一份快照，可以从下面恢复。已经有财务单据用到商品档案时不允许重置。</div>
      {error && <div role="alert" className="notice error">{error}</div>}
      {notice && <div role="status" className="notice ok">{notice}</div>}
      {pre && (
        <section>
          <label className="check-line"><input type="checkbox" checked={includePlatforms} onChange={(e) => setIncludePlatforms(e.target.checked)} />同时清空销售平台和销售场景</label>
          <table className="data-table"><thead><tr><th>将清空的资料</th><th className="num">条数</th></tr></thead>
            <tbody>{pre.tables.map((t) => <tr key={t.type}><td>{t.label}</td><td className="num">{t.count}</td></tr>)}</tbody>
            <tfoot><tr><th>合计</th><th className="num">{pre.total}</th></tr></tfoot></table>
          <p className="muted">不会动：{pre.exclusions.join('；')}。</p>
          {pre.blockedByDocuments > 0 && <div className="notice error">有 {pre.blockedByDocuments} 行财务单据明细用到了商品档案，目前不能重置。</div>}
          <div className="toolbar"><input aria-label="确认文本" placeholder={`输入 ${pre.confirmation} 确认`} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            <button type="button" className="primary-button" disabled={busy || confirm !== pre.confirmation || pre.total === 0 || pre.blockedByDocuments > 0} onClick={reset}>清空并留快照</button></div>
        </section>
      )}
      <h2 className="section-title">备份快照</h2>
      <div className="table-scroll"><table className="data-table">
        <thead><tr><th>时间</th><th>类型</th><th>说明</th><th className="num">条数</th><th>操作</th></tr></thead>
        <tbody>
          {snaps.length === 0 && <tr><td colSpan={5} className="empty-state muted">还没有快照</td></tr>}
          {snaps.map((s) => (
            <tr key={s.id}><td>{when(s.createdAt)}</td><td>{s.operation === 'reset' ? '重置前' : '恢复前安全快照'}</td><td>{s.label}{s.restoredAt ? <span className="muted">（{when(s.restoredAt)} 已恢复过）</span> : null}</td><td className="num">{s.rowCount}</td>
              <td><input aria-label={`恢复确认 ${s.id}`} placeholder={s.confirmation} value={restoreText[s.id] ?? ''} onChange={(e) => setRestoreText((m) => ({ ...m, [s.id]: e.target.value }))} /> <button type="button" className="secondary-button small" disabled={busy || restoreText[s.id] !== s.confirmation} onClick={() => void restore(s)}>恢复</button></td></tr>
          ))}
        </tbody>
      </table></div>
    </div>
  );
}

const JOB_KIND: Record<string, string> = { base_code_upsert: '上传基础编码', base_code_replace: '改码上传', base_code_disable: '停用基础编码', bundle_upsert: '上传组合', bundle_replace: '组合改码上传', bundle_disable: '停用组合', normal_product_upload: '商品资料上传', bundle_price_update: '同步基本售价', category_sync: '同步分类' };
const JOB_STATUS: Record<string, [string, string]> = { pending: ['待发送', 'warn'], sending: ['发送中', 'warn'], done: ['已同步', 'ok'], failed: ['失败', 'bad'], cancelled: ['已取消', 'muted'] };

/** 聚水潭同步队列：所有对外写入先排队；总开关默认关，关着时只积压不发送，随时可以一键停止。 */
export function JstSyncPage() {
  const [sw, setSw] = useState<{ enabled: boolean; senderConfigured: boolean } | null>(null);
  const [data, setData] = useState<{ total: number; counts: Record<string, number>; rows: OutboxJobRow[] } | null>(null);
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = async () => {
    try { setSw(await financeApi.jstSwitch()); setData(await financeApi.jstJobs({ status: status || undefined, page })); } catch (e) { setError(msg(e)); }
  };
  useEffect(() => { void load(); }, [status, page]); // eslint-disable-line react-hooks/exhaustive-deps
  async function toggle(on: boolean) {
    if (on && !window.confirm('打开后，队列里的内容会被发送到聚水潭（需要已接入接口）。确定打开吗？')) return;
    try { setSw(await financeApi.setJstSwitch(on, on ? '管理员打开' : '管理员一键停止')); } catch (e) { setError(msg(e)); }
  }
  async function act(fn: () => Promise<unknown>) { try { await fn(); await load(); } catch (e) { setError(msg(e)); } }
  return (
    <div>
      <div className="page-head"><h1>聚水潭同步队列</h1></div>
      {sw && (
        <div className={`notice ${sw.enabled ? 'ok' : ''}`}>
          <strong>对外同步总开关：{sw.enabled ? '已打开' : '已关闭（默认）'}</strong>
          {!sw.senderConfigured && <div className="bad-text">还没有接入聚水潭接口（需要管理员提供并授权接口凭证），即使开关打开也不会发送任何内容。</div>}
          <div className="row-actions">
            {sw.enabled ? <button type="button" className="primary-button" onClick={() => void toggle(false)}>一键停止所有外部写入</button> : <button type="button" className="secondary-button" onClick={() => void toggle(true)}>打开同步</button>}
          </div>
        </div>
      )}
      {notice && <div role="status" className="notice ok">{notice}</div>}
      {error && <div role="alert" className="notice error">{error}</div>}
      <div className="pill-row">
        {['', 'pending', 'failed', 'done', 'cancelled'].map((s) => <button key={s} type="button" className={`mode-button${status === s ? ' active' : ''}`} aria-pressed={status === s} onClick={() => { setStatus(s); setPage(1); }}>{s ? JOB_STATUS[s][0] : '全部'}{s && data ? ` ${data.counts[s] ?? 0}` : ''}</button>)}
      </div>
      <div className="table-scroll"><table className="data-table">
        <thead><tr><th>时间</th><th>内容</th><th>状态</th><th className="num">尝试</th><th>最近错误</th><th /></tr></thead>
        <tbody>
          {data?.rows.length === 0 && <tr><td colSpan={6} className="empty-state muted">队列是空的</td></tr>}
          {data?.rows.map((j) => (
            <tr key={j.id}><td>{when(j.createdAt)}</td><td>{JOB_KIND[j.kind] ?? (j.resourceType === 'finance-bundles' ? '商品组合' : '基础编码')} <strong>{j.payload.code ?? (j.payload as { skuId?: string }).skuId}</strong><div className="muted">{j.payload.name}</div>{(j.payload as { oldCode?: string }).oldCode && <div className="muted">旧编码：{(j.payload as { oldCode?: string }).oldCode}</div>}</td>
              <td><span className={`pill ${JOB_STATUS[j.status][1]}`}>{JOB_STATUS[j.status][0]}</span></td><td className="num">{j.attempts}</td><td className="bad-text">{j.lastError}</td>
              <td>{(j.status === 'failed' || j.status === 'cancelled') && <button type="button" className="secondary-button small" onClick={() => void act(() => financeApi.jstRetry(j.id))}>重试</button>}{(j.status === 'pending' || j.status === 'failed') && <button type="button" className="secondary-button small" onClick={() => void act(() => financeApi.jstCancel(j.id))}>取消</button>}</td></tr>
          ))}
        </tbody>
      </table></div>
      <div className="toolbar"><button type="button" className="secondary-button small" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button><span className="muted">共 {data?.total ?? 0} 条 · 第 {page} 页</span><button type="button" className="secondary-button small" disabled={page * 20 >= (data?.total ?? 0)} onClick={() => setPage(page + 1)}>下一页</button></div>
      <JstSyncItems onQueued={() => void load()} />
      <JstSyncExtras onQueued={() => void load()} />
    </div>
  );
}
