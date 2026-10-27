import { useCallback, useEffect, useRef, useState } from 'react';
import { PURCHASE_TEMPLATE } from '@kudesi/shared';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { PurchaseRequestFields } from './PurchaseFields';
import { RunDetail } from './RunDetail';
import { RUN_TONE, flowApi, newRequestKey, type RunList } from './flowApi';
import { purchaseApi, type PurchaseProgress } from './purchaseApi';
import { RUN_STATUS_LABEL } from '@kudesi/shared';

type Tab = 'list' | 'new';
type View = 'started' | 'all';

/** 采购申请中心：发起采购、看每张采购的到货进度（办理在流程详情里，办理人由流程配置决定）。 */
export function PurchaseCenterPage() {
  const { can } = useAuth();
  const canStart = can('flow.apply.view');
  const canAll = can('flow.overview.view');
  const [tab, setTab] = useState<Tab>('list');
  const [view, setView] = useState<View>('started');
  const [status, setStatus] = useState('');
  const [keyword, setKeyword] = useState('');
  const [list, setList] = useState<RunList | null>(null);
  const [progress, setProgress] = useState<Record<string, PurchaseProgress>>({});
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const keyRef = useRef(newRequestKey());

  const load = useCallback(() => {
    flowApi.runs({ view, templateKey: PURCHASE_TEMPLATE, status, keyword: keyword.trim() || undefined })
      .then(async (r) => { setList(r); setError(''); setProgress(await purchaseApi.progress(r.rows.map((x) => x.id)).catch(() => ({}))); })
      .catch((e) => setError(e instanceof ApiError ? e.message : '加载失败'));
  }, [view, status, keyword]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  const lines = (Array.isArray(values.lines) ? values.lines : []) as Array<{ qty: number | '' }>;
  const missing = [!lines.length && '采购商品', lines.some((l) => !(Number(l.qty) > 0)) && '每个商品的数量', !values.requestedArrivalAt && '要求到货日期'].filter(Boolean) as string[];
  const dirty = !!lines.length || !!values.note;

  async function submit() {
    setBusy(true); setError('');
    try {
      const run = await flowApi.start(PURCHASE_TEMPLATE, values, keyRef.current);
      keyRef.current = newRequestKey();
      setNotice(`采购申请已提交（编号 #${run.id}），下一步由采购方案负责人办理。`);
      setValues({}); setConfirm(false); setTab('list'); setView('started'); setOpen(run.id); load();
    } catch (e) { setError(e instanceof ApiError ? e.message : '提交失败'); setConfirm(false); } finally { setBusy(false); }
  }
  function switchTab(t: Tab) {
    if (t !== tab && tab === 'new' && dirty && !window.confirm('采购申请还没有提交，切换后保留已填内容，确定切换吗？')) return;
    setTab(t);
  }
  return (
    <div className="purchase-page">
      <div className="page-head"><h1>采购申请中心</h1></div>
      <p className="muted">提交采购需求后，方案、审批、付款、发货、到货、质检、费用和入库结算都在这里按流程一步步办理，进度一目了然。</p>
      <div className="tab-row" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'list'} className={tab === 'list' ? 'tab active' : 'tab'} onClick={() => switchTab('list')}>采购进度</button>
        <button type="button" role="tab" aria-selected={tab === 'new'} className={tab === 'new' ? 'tab active' : 'tab'} onClick={() => switchTab('new')}>新建采购申请</button>
      </div>
      {notice && <div role="status" className="notice ok-notice toast-line"><span>{notice}</span><button type="button" aria-label="关闭提示" onClick={() => setNotice('')}>✕</button></div>}
      {error && <div role="alert" className="notice error">{error}</div>}

      {tab === 'new' && (
        <section className="card" style={{ padding: 16 }}>
          {!canStart && <div className="notice">你没有发起流程的权限。</div>}
          <PurchaseRequestFields values={values} onChange={(k, v) => setValues((cur) => ({ ...cur, [k]: v }))} />
          {missing.length > 0 && confirm === false && busy === false && <p className="muted">还需要：{missing.join('、')}</p>}
          <div className="row-actions">
            <button type="button" className="primary-button" disabled={!canStart || busy || missing.length > 0} onClick={() => setConfirm(true)}>提交采购申请</button>
          </div>
          {confirm && (
            <div className="modal-backdrop" role="presentation">
              <div className="modal card small" role="dialog" aria-label="确认提交采购申请">
                <div className="modal-head"><strong>确认提交采购申请</strong></div>
                <div className="modal-body"><p>共 {lines.length} 个商品，要求 {String(values.requestedArrivalAt)} 到货。提交后由流程配置的办理人处理。</p></div>
                <div className="modal-foot">
                  <button type="button" className="secondary-button" onClick={() => setConfirm(false)}>返回修改</button>
                  <button type="button" className="primary-button" disabled={busy} onClick={() => void submit()}>确认提交</button>
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {tab === 'list' && (
        <section>
          <div className="exclusive-filters">
            <select aria-label="范围" value={view} onChange={(e) => setView(e.target.value as View)}><option value="started">我发起的</option>{canAll && <option value="all">全部采购</option>}</select>
            <select aria-label="状态" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">全部状态</option>{Object.entries(RUN_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            <input type="search" aria-label="搜索采购" placeholder="商品名或申请人" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
          </div>
          {list && !list.rows.length && <div className="empty-state muted">还没有采购申请。{canStart && <> <button type="button" className="link-button" onClick={() => setTab('new')}>新建一个</button></>}</div>}
          <ul className="purchase-list">
            {list?.rows.map((r) => {
              const p = progress[r.id];
              const pct = p && p.total > 0 ? Math.min(100, Math.round((p.received / p.total) * 100)) : 0;
              return (
                <li key={r.id}>
                  <button type="button" className="purchase-row" onClick={() => setOpen(r.id)}>
                    <strong>{r.title}</strong>
                    <span className={`pill ${RUN_TONE[r.status] ?? ''}`}>{RUN_STATUS_LABEL[r.status as keyof typeof RUN_STATUS_LABEL]}</span>
                    {p?.abnormal && <span className="pill bad">异常</span>}
                    {p?.refunding && <span className="pill warn">退款中</span>}
                    <span className="muted">{r.requesterName} · {r.status === 'running' ? `停在「${r.stepName}」${r.handlers.length ? `（${r.handlers.join('、')}）` : ''}` : ''}{p?.supplierName ? ` · ${p.supplierName}` : ''}{p?.requestedArrivalAt ? ` · 要求 ${p.requestedArrivalAt} 到货` : ''}</span>
                    {p && <span className="purchase-progress" role="progressbar" aria-label="到货进度" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${pct}%` }} /><em>{p.received}/{p.total} · {p.batches} 批</em></span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {open && <RunDetail id={open} onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  );
}
