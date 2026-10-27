import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AFTER_SALES_TYPES, HIGH_AMOUNT_CENTS, afterSalesTypeLabel, parseAfterSalesText, type AfterSalesPrefill } from '@kudesi/shared';
import { CopyButton, copyText } from '../../resources/CopyValue';
import { newRequestKey } from '../flow/flowApi';
import { remember, useDebounced } from '../flow/flowUi';
import { Pager, centsToYuan, money, yuanToCents } from '../finance/common';
import { AfterSalesDetail } from './AfterSalesDetail';
import { DueText, StageTag, errText, useNow } from './CaseParts';
import { serviceApi, type CaseList, type CaseRow, type StoreOption } from './serviceApi';
import { StorePicker } from './StorePicker';

type Filter = 'open' | 'late' | 'soon' | 'done' | 'all';
const FILTER_KEY = 'kudesi.afterSales.filter';
const FILTERS: Array<[Filter, string]> = [['open', '处理中'], ['late', '已超时'], ['soon', '6 小时内到期'], ['done', '已办结'], ['all', '全部']];
const isFilter = (v: string): v is Filter => FILTERS.some(([k]) => k === v);

interface Draft { storeId: number | ''; orderNo: string; buyerName: string; caseType: string; amount: string; reason: string; dueDate: string }
const EMPTY: Draft = { storeId: '', orderNo: '', buyerName: '', caseType: 'return_refund', amount: '', reason: '', dueDate: '' };

/** 售后表格：左边看工单（超时、到期、退款金额一眼可见），右边粘贴买家文字快速预填并登记工单。 */
export function AfterSalesPage() {
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<Filter>(() => { const v = remember.get(FILTER_KEY, 'open'); return isFilter(v) ? v : 'open'; });
  const [keyword, setKeyword] = useState('');
  const kw = useDebounced(keyword.trim(), 300);
  const [mine, setMine] = useState(false);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<CaseList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<{ text: string; id?: number } | null>(null);
  const [stores, setStores] = useState<StoreOption[]>([]);
  const now = useNow();
  const open = Number(params.get('case')) || null;
  const formRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    setLoading(true);
    serviceApi.asList({ filter, keyword: kw || undefined, mine, page })
      .then((d) => { setData(d); setError(''); })
      .catch((e) => setError(errText(e, '加载失败')))
      .finally(() => setLoading(false));
  }, [filter, kw, mine, page]);
  useEffect(load, [load]);
  useEffect(() => { serviceApi.asStores().then(setStores).catch(() => setStores([])); }, []);
  const choose = (f: Filter) => { setFilter(f); setPage(1); remember.set(FILTER_KEY, f); };
  const stats = data?.stats;
  const count = (f: Filter) => (!stats ? '' : ` ${f === 'open' ? stats.open : f === 'late' ? stats.late : f === 'soon' ? stats.soon : f === 'done' ? stats.done : stats.total}`);

  return (
    <div className="svc-page">
      <div className="page-head">
        <div><h1>售后表格</h1><p className="muted">售后工单、72 小时完结监督、退款补偿流程。超时的会进入“兜底监督”。</p></div>
        <div className="row-actions">
          <button type="button" className="primary-button svc-jump" onClick={() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>登记工单</button>
          <button type="button" className="secondary-button" disabled={loading} onClick={load}>{loading ? '刷新中…' : '刷新'}</button>
        </div>
      </div>
      <div className="metric-row" aria-label="工单概况">
        <button type="button" className={`metric clickable${filter === 'open' ? ' active' : ''}`} onClick={() => choose('open')}><span>处理中工单</span><strong>{stats?.open ?? '—'}</strong></button>
        <button type="button" className={`metric clickable${filter === 'late' ? ' active' : ''}${stats?.late ? ' svc-metric-late' : ''}`} onClick={() => choose('late')}><span>已超时</span><strong>{stats?.late ?? '—'}</strong></button>
        <button type="button" className={`metric clickable${filter === 'soon' ? ' active' : ''}${stats?.soon ? ' svc-metric-soon' : ''}`} onClick={() => choose('soon')}><span>6 小时内到期</span><strong>{stats?.soon ?? '—'}</strong></button>
        <div className="metric"><span>处理中退款金额</span><strong>{stats ? money(stats.openAmountCents) : '—'}</strong></div>
      </div>
      {notice && (
        <div role="status" className="notice ok-notice toast-line"><span>{notice.text}{notice.id && <> <button type="button" className="link-button" onClick={() => setParams({ case: String(notice.id) })}>查看工单</button></>}</span><button type="button" aria-label="关闭提示" onClick={() => setNotice(null)}>✕</button></div>
      )}
      <div className="svc-cols">
        <section className="card svc-tickets">
          <div className="toolbar">
            <div className="tab-group" role="group" aria-label="工单筛选">
              {FILTERS.map(([k, label]) => <button key={k} type="button" className={`chip${filter === k ? ' active' : ''}`} aria-pressed={filter === k} onClick={() => choose(k)}>{label}{count(k)}</button>)}
            </div>
          </div>
          <div className="toolbar">
            <input type="search" className="search-input" aria-label="搜索工单" placeholder="搜索订单号、买家、店铺、编号（多个订单号用空格分开）" value={keyword} onChange={(e) => { setKeyword(e.target.value); setPage(1); }} />
            <label className="check-inline"><input type="checkbox" checked={mine} onChange={(e) => { setMine(e.target.checked); setPage(1); }} /> 只看我的</label>
            {(keyword || mine) && <button type="button" className="secondary-button" onClick={() => { setKeyword(''); setMine(false); setPage(1); }}>清除筛选</button>}
          </div>
          {error && <div role="alert" className="notice error toast-line m"><span>{error}</span><button type="button" className="link-button" onClick={load}>重试</button></div>}
          {stats && stats.late > 0 && filter !== 'late' && (
            <p className="notice error m svc-late-note">有 {stats.late} 单已超时，涉及金额 {money(stats.lateAmountCents)}。<button type="button" className="link-button" onClick={() => choose('late')}>只看超时</button></p>
          )}
          <div className="table-scroll"><table className="data-table stack-mobile">
            <thead><tr><th>订单号</th><th>店铺 / 买家</th><th>类型</th><th className="num">申请金额</th><th>状态</th><th>办理人</th><th>剩余时间</th><th /></tr></thead>
            <tbody>
              {loading && !data && <tr><td colSpan={8} className="empty-state muted">正在加载…</td></tr>}
              {data && data.rows.length === 0 && (
                <tr><td colSpan={8} className="empty-state muted">
                  <strong>{stats && stats.total === 0 ? '还没有售后工单' : kw ? '没有匹配的工单' : '这个筛选下没有工单'}</strong>
                  <span>{stats && stats.total === 0 ? '收到买家的售后诉求后，在右侧粘贴文字或手工填写，就能登记第一张工单。' : '换个筛选或关键词试试。'}</span>
                  {filter !== 'all' && stats && stats.total > 0 && <button type="button" className="secondary-button" onClick={() => choose('all')}>查看全部</button>}
                </td></tr>
              )}
              {data?.rows.map((r) => <Row key={r.id} r={r} now={now} onOpen={() => setParams({ case: String(r.id) })} />)}
            </tbody>
          </table></div>
          {data && <div className="card-foot"><Pager page={page} pageSize={20} total={data.total} onPage={setPage} /></div>}
        </section>
        <div ref={formRef}><RegisterPanel stores={stores} onDone={(text, id) => { setNotice({ text, id }); setPage(1); setFilter('open'); load(); }} /></div>
      </div>
      {open && <AfterSalesDetail id={open} onClose={() => setParams({})} onChanged={load} onOpenOther={(id) => setParams({ case: String(id) })} />}
    </div>
  );
}

function Row({ r, now, onOpen }: { r: CaseRow; now: number; onOpen: () => void }) {
  return (
    <tr className={r.overdue ? 'late' : undefined} aria-label={`工单 ${r.caseNo}`}>
      <td data-label="订单号" className="cell-title"><button type="button" className="link-button mono" onClick={onOpen}>{r.orderNo}</button> <CopyButton value={r.orderNo} label="订单号" /><span className="sub-line">{r.caseNo}</span></td>
      <td data-label="店铺 / 买家">{r.storeName}{r.buyerName && <span className="sub-line">买家 {r.buyerName}</span>}</td>
      <td data-label="类型">{afterSalesTypeLabel(r.caseType)}</td>
      <td data-label="申请金额" className="num svc-money">{money(r.amountCents)}</td>
      <td data-label="状态"><StageTag stage={r.stage} returned={r.returnedBack} /></td>
      <td data-label="办理人">{r.open ? r.handlers.join('、') || '—' : '—'}{r.open && r.stepName && <span className="sub-line">{r.stepName}</span>}</td>
      <td data-label="剩余时间"><DueText dueAt={r.dueAt} open={r.open} now={now} /></td>
      <td className="row-actions"><button type="button" className="secondary-button small" onClick={onOpen}>{r.open ? '处理' : '查看'}</button></td>
    </tr>
  );
}

/** 右侧登记区：粘贴买家文字 → 预填 → 核对修改 → 登记；也可以全手工填。截图作为凭证随工单保存。 */
function RegisterPanel({ stores, onDone }: { stores: StoreOption[]; onDone: (text: string, id: number) => void }) {
  const [text, setText] = useState('');
  const [d, setD] = useState<Draft>(EMPTY);
  const [pending, setPending] = useState<File[]>([]);
  const [prefilled, setPrefilled] = useState<AfterSalesPrefill | null>(null);
  const [dup, setDup] = useState<CaseRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const keyRef = useRef(newRequestKey());
  const fileInput = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => { setD((cur) => ({ ...cur, [k]: v })); setCopied(false); };
  const dirty = !!(text || d.orderNo || d.reason || d.amount || d.buyerName || pending.length);

  // 在这个区域里 Ctrl+V 粘贴截图，当作凭证加进来
  useEffect(() => {
    const node = root.current;
    if (!node) return undefined;
    const h = (e: ClipboardEvent) => {
      const imgs = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
      if (imgs.length) { e.preventDefault(); setPending((p) => [...p, ...imgs].slice(0, 20)); }
    };
    node.addEventListener('paste', h);
    return () => node.removeEventListener('paste', h);
  }, []);

  // 订单号填好后查一下有没有重复的工单（防止重复处理）
  const orderNo = useDebounced(d.orderNo.trim(), 400);
  useEffect(() => {
    if (orderNo.length < 6) { setDup(null); return; }
    let alive = true;
    serviceApi.asList({ filter: 'open', keyword: orderNo, pageSize: 5 }).then((r) => alive && setDup(r.rows.find((x) => x.orderNo === orderNo) ?? null)).catch(() => alive && setDup(null));
    return () => { alive = false; };
  }, [orderNo]);

  function prefill() {
    if (!text.trim()) { setError('先粘贴一段买家的售后文字，例如：订单 DD202606270001 买家申请退货退款 金额 328 原因 尺寸不合适'); return; }
    const p = parseAfterSalesText(text);
    setPrefilled(p);
    setD((cur) => ({ ...cur, orderNo: p.orderNo || cur.orderNo, caseType: p.caseType, amount: p.amountCents === null ? cur.amount : centsToYuan(p.amountCents), reason: p.reason || cur.reason }));
    setError('');
  }
  const clear = () => { setText(''); setD(EMPTY); setPending([]); setPrefilled(null); setError(''); setCopied(false); keyRef.current = newRequestKey(); };
  const cents = yuanToCents(d.amount);
  const amountBad = d.amount.trim() !== '' && (cents === null || Number.isNaN(cents) || (cents as number) < 0);
  const high = cents !== null && !Number.isNaN(cents) && cents >= HIGH_AMOUNT_CENTS;

  async function submit() {
    if (!d.storeId) return setError('请选择店铺');
    if (!d.orderNo.trim()) return setError('请填写订单号');
    if (!d.reason.trim()) return setError('请填写原因');
    if (cents === null || Number.isNaN(cents) || (cents as number) < 0) return setError('申请金额请填不小于 0 的数字（没有金额填 0）');
    if (dup && !window.confirm(`订单 ${d.orderNo.trim()} 已有处理中的工单 ${dup.caseNo}，确定还要再登记一张吗？`)) return;
    setBusy(true); setError('');
    try {
      const r = await serviceApi.asCreate({ storeId: Number(d.storeId), orderNo: d.orderNo.trim(), buyerName: d.buyerName.trim() || undefined, caseType: d.caseType, amountCents: cents as number, reason: d.reason.trim(), dueDate: d.dueDate || undefined, requestKey: keyRef.current });
      let failed = 0;
      for (const f of pending) { try { await serviceApi.asUpload(r.id, f); } catch { failed += 1; } }
      onDone(`已登记售后工单${failed ? `（有 ${failed} 张截图没传上去，请在详情里补传）` : ''}，会按流程交给办理人，72 小时内要办结。`, r.id);
      clear();
    } catch (e) { setError(errText(e, '登记失败')); } finally { setBusy(false); }
  }

  async function copy() {
    const typeText = afterSalesTypeLabel(d.caseType);
    const lines = [`订单号：${d.orderNo}`, `售后类型：${typeText}`, `申请金额：${cents === null || Number.isNaN(cents) ? '—' : money(cents as number)}`, `原因：${d.reason}`];
    setCopied(await copyText(lines.join('\n')));
  }

  const flowOff = /还没有启用/.test(error);
  return (
    <section className="card svc-register" ref={root}>
      <div className="card-head between"><strong>登记 / 快速预填</strong>{dirty && <button type="button" className="link-button" onClick={clear}>清空重来</button>}</div>
      <div className="svc-register-body">
        <label>买家售后文字（可选）
          <textarea rows={3} value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} placeholder="粘贴买家的售后信息，例如：订单 DD202606270001 买家申请退货退款 金额 328 原因 尺寸不合适" />
        </label>
        <div className="row-actions"><button type="button" className="secondary-button" onClick={prefill}>识别并预填</button><span className="muted">只预填，不会自动建单；请对照平台核对后再登记</span></div>
        {prefilled && !prefilled.orderNo && <div className="notice warn" role="status">没有认出订单号，请手动填写。</div>}
        <div className="form-grid">
          <label className="wide"><span>店铺<b className="req"> *</b></span><StorePicker stores={stores} value={d.storeId} onChange={(v) => set('storeId', v)} /></label>
          <label><span>订单号<b className="req"> *</b></span><input value={d.orderNo} maxLength={80} onChange={(e) => set('orderNo', e.target.value)} /></label>
          <label><span>买家</span><input value={d.buyerName} maxLength={80} onChange={(e) => set('buyerName', e.target.value)} /></label>
          <label><span>售后类型<b className="req"> *</b></span><select value={d.caseType} onChange={(e) => set('caseType', e.target.value)}>{AFTER_SALES_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select></label>
          <label><span>申请金额（元）<b className="req"> *</b></span><input inputMode="decimal" value={d.amount} aria-invalid={amountBad || undefined} placeholder="没有金额填 0" onChange={(e) => set('amount', e.target.value)} /></label>
          <label className="wide"><span>原因<b className="req"> *</b></span><textarea rows={2} maxLength={500} value={d.reason} onChange={(e) => set('reason', e.target.value)} /></label>
          <label><span>要求办结日期</span><input type="date" value={d.dueDate} onChange={(e) => set('dueDate', e.target.value)} /></label>
        </div>
        {amountBad && <div role="alert" className="notice error">金额请填不小于 0 的数字。</div>}
        {high && <div className="notice warn" role="status">金额较高，会由主管复核后才能办结。</div>}
        {dup && <div className="notice warn" role="status">该订单已有处理中的工单 {dup.caseNo}（{afterSalesTypeLabel(dup.caseType)}，{dup.stepName ?? ''}），请勿重复处理。</div>}
        <div className="svc-pending">
          <div className="row-actions">
            <button type="button" className="secondary-button small" onClick={() => fileInput.current?.click()}>添加截图/凭证</button>
            <span className="muted">也可以在这里直接 Ctrl+V 粘贴截图；图片会随工单保存</span>
            <input ref={fileInput} type="file" accept="image/*,application/pdf" multiple hidden aria-label="选择凭证文件" onChange={(e) => { setPending((p) => [...p, ...(e.target.files ?? [])].slice(0, 20)); e.target.value = ''; }} />
          </div>
          {pending.length > 0 && <ul className="svc-pending-list">{pending.map((f, i) => <li key={`${f.name}${i}`}>{f.name || '截图'} <button type="button" className="link-button" aria-label={`移除 ${f.name || '截图'}`} onClick={() => setPending((p) => p.filter((_, j) => j !== i))}>移除</button></li>)}</ul>}
        </div>
        {error && (
          <div role="alert" className="notice error">{error}{flowOff && <> <Link to="/flow/templates">去流程配置</Link></>}</div>
        )}
        <div className="row-actions svc-actions">
          <button type="button" className="primary-button" disabled={busy} onClick={() => void submit()}>{busy ? '登记中…' : '登记工单'}</button>
          <button type="button" className="secondary-button" disabled={!d.orderNo.trim()} onClick={() => void copy()}>{copied ? '已复制' : '复制工单信息'}</button>
        </div>
        <p className="muted">办理人、时限和主管复核都由“流程配置”里的「售后工单」流程决定；还没配置时登记会提示去配置。</p>
      </div>
    </section>
  );
}

