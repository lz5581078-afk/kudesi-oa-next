import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { APPEAL_RECONSIDER_MONTHLY, APPEAL_TYPES, appealTypeLabel } from '@kudesi/shared';
import { CopyButton } from '../../resources/CopyValue';
import { newRequestKey } from '../flow/flowApi';
import { remember, useDebounced } from '../flow/flowUi';
import { Pager, money, yuanToCents } from '../finance/common';
import { AppealDetail } from './AppealDetail';
import { DueText, StageTag, errText, useNow } from './CaseParts';
import { serviceApi, type AppealDetailDto, type AppealList, type AppealRow, type AppealStore, type StoreOption } from './serviceApi';
import { StorePicker } from './StorePicker';

const TABS = APPEAL_TYPES.filter((t) => t.tab);
const STATUS: Array<[string, string]> = [['all', '全部'], ['pending', '待处理（复核/提交平台）'], ['submitted', '已申诉待结果'], ['approved', '申诉通过'], ['rejected', '申诉驳回'], ['cancelled', '已取消/被拒']];
const TAB_KEY = 'kudesi.appeals.tab';

/** 订单申诉：先选经营中的店铺进入申诉工作台（旧系统入口），也可以直接看全部店铺的申诉记录。 */
export function AppealsPage() {
  const [params, setParams] = useSearchParams();
  const scope = params.get('store');
  const [stores, setStores] = useState<AppealStore[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { serviceApi.apStores().then(setStores).catch((e) => setError(errText(e, '加载失败'))); }, []);
  const store = scope && scope !== 'all' ? stores?.find((s) => s.id === Number(scope)) ?? null : null;
  if (scope && (scope === 'all' || Number(scope))) {
    return <Workbench store={store} storeId={scope === 'all' ? undefined : Number(scope)} storeName={store?.name} onBack={() => setParams({})} />;
  }
  return (
    <div className="svc-page">
      <div className="page-head">
        <div><h1>订单申诉</h1><p className="muted">先按经营中的店铺进入申诉工作台；也可以直接查看全部店铺的申诉记录。申诉要有有效凭证，失败次数不限。</p></div>
        <button type="button" className="secondary-button" onClick={() => setParams({ store: 'all' })}>全部店铺的申诉记录</button>
      </div>
      {error && <div role="alert" className="notice error">{error}</div>}
      <section className="card">
        <div className="card-head"><strong>经营中店铺</strong><span className="muted">有当前运营且已领取的店铺</span></div>
        <div className="table-scroll"><table className="data-table stack-mobile">
          <thead><tr><th>平台</th><th>店铺名称</th><th>店铺编号</th><th>当前运营</th><th>店铺状态</th><th className="num">在办申诉</th><th className="num">已超时</th><th /></tr></thead>
          <tbody>
            {!stores && !error && <tr><td colSpan={8} className="empty-state muted">正在加载…</td></tr>}
            {stores?.length === 0 && <tr><td colSpan={8} className="empty-state muted"><strong>暂无经营中店铺</strong><span>有当前运营且领取状态为“已领取”的店铺会显示在这里；没有的话，可以先看“全部店铺的申诉记录”并直接登记。</span></td></tr>}
            {stores?.map((s) => (
              <tr key={s.id}>
                <td data-label="平台">{s.platform || '-'}</td>
                <td data-label="店铺名称" className="cell-title">{s.name}</td>
                <td data-label="店铺编号">{s.storeNo || '-'}</td>
                <td data-label="当前运营">{s.operatorName || '-'}</td>
                <td data-label="店铺状态">{s.status === 'abnormal' ? <span className="pill warn">异常</span> : <span className="pill ok">正常</span>}</td>
                <td data-label="在办申诉" className="num">{s.open}</td>
                <td data-label="已超时" className={`num${s.late ? ' late-text' : ''}`}>{s.late}</td>
                <td className="row-actions"><button type="button" className="primary-button" onClick={() => setParams({ store: String(s.id) })}>申诉</button></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </section>
    </div>
  );
}

function Workbench({ store, storeId, storeName, onBack }: { store: AppealStore | null; storeId?: number; storeName?: string; onBack: () => void }) {
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<string>(() => { const t = remember.get(TAB_KEY, 'all'); return t === 'all' || TABS.some((x) => x.value === t) ? t : 'all'; });
  const [status, setStatus] = useState('all');
  const [keyword, setKeyword] = useState('');
  const [applied, setApplied] = useState({ keyword: '', status: 'all' });
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AppealList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<{ text: string; id?: number } | null>(null);
  const [create, setCreate] = useState<null | { type: string; parent?: AppealDetailDto }>(null);
  const [allStores, setAllStores] = useState<StoreOption[]>([]);
  const now = useNow();
  const open = Number(params.get('appeal')) || null;
  const recordsRef = useRef<HTMLElement>(null);

  const load = useCallback(() => {
    setLoading(true);
    serviceApi.apList({ storeId, type: tab === 'all' ? undefined : tab, status: applied.status, keyword: applied.keyword || undefined, page })
      .then((d) => { setData(d); setError(''); })
      .catch((e) => setError(errText(e, '加载失败')))
      .finally(() => setLoading(false));
  }, [storeId, tab, applied, page]);
  useEffect(load, [load]);
  useEffect(() => { serviceApi.asStores().then(setAllStores).catch(() => setAllStores([])); }, []);
  const pickTab = (t: string) => { setTab(t); setPage(1); remember.set(TAB_KEY, t); };
  const query = () => { setApplied({ keyword: keyword.trim(), status }); setPage(1); };
  const reset = () => { setKeyword(''); setStatus('all'); setApplied({ keyword: '', status: 'all' }); setPage(1); };
  const goRecords = (t: string) => { pickTab(t); recordsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  const s = data?.stats;
  const title = storeId ? `${storeName ?? store?.name ?? '店铺'} / 订单申诉` : '全部店铺 / 订单申诉';

  return (
    <div className="svc-page order-appeal-page">
      <div className="page-head">
        <div><h1>{title}</h1><p className="muted">申诉全程走流程：登记 → 主管复核举证 → 提交平台 → 登记平台结果。平台给的倒计时超时会进入“兜底监督”。</p></div>
        <div className="row-actions"><button type="button" className="secondary-button" onClick={onBack}>返回店铺列表</button><button type="button" className="secondary-button" disabled={loading} onClick={load}>{loading ? '刷新中…' : '刷新'}</button></div>
      </div>
      {notice && <div role="status" className="notice ok-notice toast-line"><span>{notice.text}{notice.id && <> <button type="button" className="link-button" onClick={() => setParams((p) => { const n = new URLSearchParams(p); n.set('appeal', String(notice.id)); return n; })}>查看申诉</button></>}</span><button type="button" aria-label="关闭提示" onClick={() => setNotice(null)}>✕</button></div>}
      <section className="card svc-section">
        <div className="card-head"><strong>申诉概况</strong></div>
        <div className="notice warn m">申诉失败次数不限制，但需要有效凭证；没有凭证不能复核、不能提交平台。</div>
        <div className="metric-row m" aria-label="申诉概况">
          <div className="metric"><span>在办申诉</span><strong>{s?.open ?? '—'}</strong></div>
          <div className={`metric${s?.late ? ' svc-metric-late' : ''}`}><span>已超时</span><strong>{s?.late ?? '—'}</strong></div>
          <div className="metric"><span>待提交平台</span><strong>{s?.toSubmit ?? '—'}</strong></div>
          <div className="metric"><span>已申诉待结果</span><strong>{s?.awaiting ?? '—'}</strong></div>
          <div className="metric"><span>可复议（被驳回）</span><strong>{s?.canReconsider ?? '—'}</strong></div>
          <div className="metric"><span>本月复议</span><strong>{s ? `${s.monthReconsider}/${APPEAL_RECONSIDER_MONTHLY}` : '—'}</strong><small className="muted">平台每月复议权益提示</small></div>
        </div>
      </section>
      <section className="card svc-section">
        <div className="card-head"><strong>申诉入口</strong><span className="muted">订单数据暂时由员工从平台后台抄录登记（没有自动同步）</span></div>
        <div className="appeal-card-grid m">
          {APPEAL_TYPES.map((t) => (
            <div key={t.value} className={`appeal-entry-card${t.compact ? ' compact' : ''}`}>
              <div><strong>{t.label}</strong><p className="muted">{t.detail}</p></div>
              <div className="row-actions">
                <button type="button" className="primary-button" onClick={() => t.value === 'reconsider' ? goRecords('all') : setCreate({ type: t.value })}>{t.value === 'reconsider' ? '去复议' : '去申诉'}</button>
                {t.tab && <button type="button" className="secondary-button" onClick={() => goRecords(t.value)}>申诉记录</button>}
                {t.value === 'reconsider' && <button type="button" className="secondary-button" onClick={() => { setStatus('rejected'); setApplied({ keyword: '', status: 'rejected' }); goRecords('all'); }}>可复议的申诉</button>}
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="card svc-section" ref={recordsRef}>
        <div className="card-head"><strong>申诉记录</strong></div>
        <div className="tabs" role="tablist">
          {[{ value: 'all', label: '全部' }, ...TABS].map((t) => <button key={t.value} type="button" role="tab" aria-selected={tab === t.value} className={tab === t.value ? 'tab active' : 'tab'} onClick={() => pickTab(t.value)}>{t.label}</button>)}
        </div>
        <div className="toolbar">
          <label className="inline-field"><span>订单编号</span><input type="search" aria-label="订单编号" placeholder="多个订单号用空格或逗号分开" value={keyword} onChange={(e) => setKeyword(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') query(); }} /></label>
          <label className="inline-field"><span>处理状态</span><select aria-label="处理状态" value={status} onChange={(e) => setStatus(e.target.value)}>{STATUS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <button type="button" className="primary-button" onClick={query}>查询</button>
          <button type="button" className="secondary-button" onClick={reset}>重置</button>
          <button type="button" className="secondary-button small" onClick={() => setCreate({ type: tab === 'all' ? 'abnormal_order' : tab })}>登记申诉</button>
        </div>
        {error && <div role="alert" className="notice error toast-line m"><span>{error}</span><button type="button" className="link-button" onClick={load}>重试</button></div>}
        <div className="table-scroll"><table className="data-table stack-mobile">
          <thead><tr><th>订单编号</th><th>订单信息</th><th>申诉项</th><th>倒计时</th><th>处理人</th><th>状态</th><th /></tr></thead>
          <tbody>
            {loading && !data && <tr><td colSpan={7} className="empty-state muted">正在加载…</td></tr>}
            {data && data.rows.length === 0 && (
              <tr><td colSpan={7} className="empty-state muted">
                <strong>{applied.keyword || applied.status !== 'all' || tab !== 'all' ? '没有符合条件的申诉' : '还没有申诉记录'}</strong>
                <span>{applied.keyword || applied.status !== 'all' || tab !== 'all' ? '换个条件，或点“重置”。' : '平台订单暂时没有自动同步：从平台后台看到可申诉的订单后，点上面的“去申诉”登记并上传凭证。'}</span>
              </td></tr>
            )}
            {data?.rows.map((r) => <Row key={r.id} r={r} now={now} onOpen={() => setParams((p) => { const n = new URLSearchParams(p); n.set('appeal', String(r.id)); return n; })} />)}
          </tbody>
        </table></div>
        {data && <div className="card-foot"><Pager page={page} pageSize={20} total={data.total} onPage={setPage} /></div>}
      </section>
      {open && <AppealDetail id={open} onClose={() => setParams((p) => { const n = new URLSearchParams(p); n.delete('appeal'); return n; })} onChanged={load}
        onOpenOther={(id) => setParams((p) => { const n = new URLSearchParams(p); n.set('appeal', String(id)); return n; })}
        onReconsider={(a) => { setParams((p) => { const n = new URLSearchParams(p); n.delete('appeal'); return n; }); setCreate({ type: 'reconsider', parent: a }); }} />}
      {create && <AppealForm stores={allStores} fixedStoreId={storeId} initialType={create.type} parent={create.parent} onClose={() => setCreate(null)}
        onDone={(text, id) => { setCreate(null); setNotice({ text, id }); setPage(1); load(); }} />}
    </div>
  );
}

function Row({ r, now, onOpen }: { r: AppealRow; now: number; onOpen: () => void }) {
  return (
    <tr className={r.overdue ? 'late' : undefined} aria-label={`申诉 ${r.appealNo}`}>
      <td data-label="订单编号" className="cell-title"><button type="button" className="link-button mono" onClick={onOpen}>{r.orderNo}</button> <CopyButton value={r.orderNo} label="订单号" /><span className="sub-line">{r.appealNo}{r.parentId ? ' · 复议' : ''}</span></td>
      <td data-label="订单信息">{r.storeName}<span className="sub-line">{money(r.amountCents)} · {r.reason.slice(0, 30)}{r.reason.length > 30 ? '…' : ''}</span></td>
      <td data-label="申诉项">{appealTypeLabel(r.appealType)}{r.open && r.evidenceCount === 0 && <span className="sub-line late-text">缺凭证</span>}</td>
      <td data-label="倒计时">{r.deadlineAt ? <span className="sub-line">平台截止 {String(r.deadlineAt).slice(0, 10)}</span> : null}<DueText dueAt={r.dueAt} open={r.open} now={now} /></td>
      <td data-label="处理人">{r.open ? r.handlers.join('、') || '-' : '-'}{r.open && r.stepName && <span className="sub-line">{r.stepName}</span>}</td>
      <td data-label="状态"><StageTag stage={r.stage} returned={r.returnedBack} />{r.result && <span className={`pill ${r.result === 'approved' ? 'ok' : 'bad'}`}>{r.result === 'approved' ? '通过' : '驳回'}</span>}</td>
      <td className="row-actions"><button type="button" className="secondary-button small" onClick={onOpen}>{r.open ? '处理' : '查看'}</button></td>
    </tr>
  );
}

/** 登记申诉/复议：选类型、店铺、订单号、金额、理由、平台倒计时；凭证随后上传（提交平台前必须有）。 */
function AppealForm({ stores, fixedStoreId, initialType, parent, onClose, onDone }: { stores: StoreOption[]; fixedStoreId?: number; initialType: string; parent?: AppealDetailDto; onClose: () => void; onDone: (text: string, id: number) => void }) {
  const [type, setType] = useState(parent ? 'reconsider' : initialType);
  const [storeId, setStoreId] = useState<number | ''>(parent?.storeId ?? fixedStoreId ?? '');
  const [orderNo, setOrderNo] = useState(parent?.orderNo ?? '');
  const [amount, setAmount] = useState(parent ? (parent.amountCents / 100).toFixed(2) : '');
  const [reason, setReason] = useState('');
  const [deadline, setDeadline] = useState('');
  const [parentId, setParentId] = useState<number | ''>(parent?.id ?? '');
  const [rejected, setRejected] = useState<AppealRow[]>([]);
  const [pending, setPending] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const keyRef = useRef(newRequestKey());
  const fileInput = useRef<HTMLInputElement>(null);
  const isRe = type === 'reconsider';
  const dirty = !!(orderNo || reason || amount || pending.length) && !parent;

  useEffect(() => {
    if (!isRe || parent) return;
    serviceApi.apList({ status: 'rejected', storeId: storeId || undefined, pageSize: 100 }).then((r) => setRejected(r.rows.filter((x) => x.canReconsider))).catch(() => setRejected([]));
  }, [isRe, parent, storeId]);
  useEffect(() => {
    const h = (e: ClipboardEvent) => {
      const imgs = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
      if (imgs.length) { e.preventDefault(); setPending((p) => [...p, ...imgs].slice(0, 20)); }
    };
    document.addEventListener('paste', h);
    return () => document.removeEventListener('paste', h);
  }, []);
  function pickParent(id: number | '') {
    setParentId(id);
    const p = rejected.find((x) => x.id === id);
    if (p) { setStoreId(p.storeId); setOrderNo(p.orderNo); setAmount((p.amountCents / 100).toFixed(2)); }
  }
  const close = () => { if (dirty && !window.confirm('已填写的内容还没有提交，确定放弃吗？')) return; onClose(); };

  async function submit() {
    if (!storeId) return setError('请选择店铺');
    if (!orderNo.trim()) return setError('请填写订单号');
    if (!reason.trim()) return setError('请填写申诉理由');
    const cents = yuanToCents(amount || '0');
    if (cents === null || Number.isNaN(cents) || cents < 0) return setError('涉及金额请填不小于 0 的数字（没有金额填 0）');
    if (isRe && !parentId) return setError('请选择要复议的原申诉');
    setBusy(true); setError('');
    try {
      const r = await serviceApi.apCreate({ storeId: Number(storeId), appealType: type, orderNo: orderNo.trim(), amountCents: cents, reason: reason.trim(), deadlineDate: deadline || undefined, parentId: isRe ? Number(parentId) : undefined, requestKey: keyRef.current });
      let failed = 0;
      for (const f of pending) { try { await serviceApi.apUpload(r.id, f); } catch { failed += 1; } }
      onDone(`已登记${isRe ? '复议' : '申诉'}${failed ? `（有 ${failed} 个凭证没传上去，请在详情里补传）` : ''}。提交平台前请确认凭证齐全。`, r.id);
    } catch (e) { setError(errText(e, '登记失败')); } finally { setBusy(false); }
  }
  const flowOff = /还没有启用/.test(error);
  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal card" role="dialog" aria-label={isRe ? '登记复议' : '登记申诉'} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="modal-head between"><strong>{isRe ? '登记复议' : '登记申诉'}</strong><button type="button" className="icon-button" aria-label="关闭" onClick={close}>✕</button></div>
        <div className="modal-body">
          <div className="form-grid">
            <label><span>申诉类型<b className="req"> *</b></span>
              <select value={type} disabled={!!parent} onChange={(e) => setType(e.target.value)}>{APPEAL_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select></label>
            <label><span>店铺<b className="req"> *</b></span>{fixedStoreId || parent ? <input value={stores.find((s) => s.id === storeId)?.name ?? parent?.storeName ?? ''} readOnly /> : <StorePicker stores={stores} value={storeId} onChange={setStoreId} />}</label>
            {isRe && !parent && (
              <label className="wide"><span>复议的原申诉<b className="req"> *</b></span>
                <select aria-label="复议的原申诉" value={parentId} onChange={(e) => pickParent(e.target.value ? Number(e.target.value) : '')}>
                  <option value="">（选择被平台驳回的申诉）</option>
                  {rejected.map((p) => <option key={p.id} value={p.id}>{p.appealNo} · {p.orderNo} · {appealTypeLabel(p.appealType)}</option>)}
                </select>
                {rejected.length === 0 && <small className="muted">没有可复议的申诉：只有平台已驳回、且还没有复议的申诉才能复议。</small>}
              </label>
            )}
            <label><span>订单号<b className="req"> *</b></span><input value={orderNo} maxLength={80} readOnly={isRe} onChange={(e) => setOrderNo(e.target.value)} /></label>
            <label><span>涉及金额（元）</span><input inputMode="decimal" value={amount} placeholder="没有金额填 0" onChange={(e) => setAmount(e.target.value)} /></label>
            <label><span>平台申诉截止日</span><input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} /><small className="muted">平台页面上的倒计时；填了会按这一天监督</small></label>
            <label className="wide"><span>{isRe ? '复议理由（补充了哪些新凭证）' : '申诉理由'}<b className="req"> *</b></span><textarea rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          </div>
          <div className="svc-pending">
            <div className="row-actions">
              <button type="button" className="secondary-button small" onClick={() => fileInput.current?.click()}>添加举证凭证</button>
              <span className="muted">聊天记录、发货/物流凭证、商品照片等；可直接 Ctrl+V 粘贴截图。提交平台前必须至少有一份。</span>
              <input ref={fileInput} type="file" accept="image/*,application/pdf" multiple hidden aria-label="选择凭证文件" onChange={(e) => { setPending((p) => [...p, ...(e.target.files ?? [])].slice(0, 20)); e.target.value = ''; }} />
            </div>
            {pending.length > 0 && <ul className="svc-pending-list">{pending.map((f, i) => <li key={`${f.name}${i}`}>{f.name || '截图'} <button type="button" className="link-button" aria-label={`移除 ${f.name || '截图'}`} onClick={() => setPending((p) => p.filter((_, j) => j !== i))}>移除</button></li>)}</ul>}
          </div>
          {error && <div role="alert" className="notice error">{error}{flowOff && <> <Link to="/flow/templates">去流程配置</Link></>}</div>}
        </div>
        <div className="modal-foot"><button type="button" className="secondary-button" onClick={close}>取消</button><button type="submit" className="primary-button" disabled={busy}>{busy ? '登记中…' : isRe ? '登记复议' : '登记申诉'}</button></div>
      </form>
    </div>
  );
}
