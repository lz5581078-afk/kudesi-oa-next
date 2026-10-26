import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { money, yuanToCents } from './common';
import { financeApi, type DebugExportInput, type DebugList, type DebugProfit, type DebugQuote, type DebugRow, type DebugSlider } from './financeApi';
import { PricingComponentFilter, type ComponentFilterValue } from './PricingComponentFilter';
import { selectPricingPage, sortPricingRows } from './pricing-selection';

interface Form { step: number; roi: string; price: string; source: 'roiToPrice' | 'priceToRoi' | null; sourceValue: string; profit?: DebugProfit; profitDraft?: string }
type SliderState = Partial<DebugSlider> & { step: number; pending?: boolean };
type QuoteState = (Partial<DebugQuote> & { pending?: boolean }) | null;

const defaultForm = (): Form => ({ step: 0, roi: '', price: '', source: null, sourceValue: '' });
const yuan = (cents: number) => `${(cents / 100).toFixed(2).replace(/\.00$/, '')} 元`;
const msg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message || '操作失败');
const priceText = (cents: number) => (cents / 100).toFixed(2);
const PAGE = 30;

/**
 * 定价调试表：从成本表挑组合，按“公司低价”调预留利润（0–140 档），投产和售价互相联动，导出 Excel。
 * 只试算，不会改正式售价或成本。
 */
export function PricingDebugPage() {
  const [keyword, setKeyword] = useState('');
  const [component, setComponent] = useState<ComponentFilterValue | null>(null);
  const [page, setPage] = useState(1);
  const [resultPage, setResultPage] = useState(1);
  const [data, setData] = useState<DebugList>({ rows: [], total: 0, page: 1, pageSize: PAGE, canViewInternals: false });
  const [selected, setSelected] = useState<Record<number, DebugRow>>({});
  const [forms, setForms] = useState<Record<number, Form>>({});
  const [quotes, setQuotes] = useState<Record<number, QuoteState>>({});
  const [sliders, setSliders] = useState<Record<number, SliderState>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [exporting, setExporting] = useState(false);
  const [addingAll, setAddingAll] = useState(false);
  const serial = useRef(0);
  const quoteTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});
  const quoteSerial = useRef<Record<number, number>>({});
  const sliderTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});
  const sliderSerial = useRef<Record<number, number>>({});
  const cancelled = useRef(false);

  const categoryId = component?.baseCodeId ? undefined : component?.categoryId;
  const baseCodeId = component?.baseCodeId;

  const load = useCallback((quiet = false) => {
    const current = ++serial.current;
    if (!quiet) setLoading(true);
    financeApi.debugList({ keyword: keyword.trim() || undefined, categoryId, baseCodeId, page, pageSize: PAGE })
      .then((r) => {
        if (current !== serial.current) return;
        setData(r); setError('');
        // 已选的商品用最新数据刷新（低价、是否可试算）
        setSelected((old) => Object.fromEntries(Object.entries(old).map(([id, row]) => [id, r.rows.find((x) => x.id === Number(id)) ?? row])));
      })
      .catch((e) => { if (current === serial.current && !quiet) setError(msg(e)); })
      .finally(() => { if (current === serial.current) setLoading(false); });
  }, [keyword, categoryId, baseCodeId, page]);
  useEffect(() => { setLoading(true); const t = setTimeout(() => load(), 220); return () => { clearTimeout(t); serial.current++; }; }, [load]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') load(true); };
    const timer = setInterval(refresh, 30000);
    window.addEventListener('focus', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [load]);
  useEffect(() => () => { cancelled.current = true; Object.values(quoteTimers.current).forEach(clearTimeout); Object.values(sliderTimers.current).forEach(clearTimeout); }, []);

  const scheduleSlider = useCallback((id: number, step: number, profit?: DebugProfit) => {
    clearTimeout(sliderTimers.current[id]);
    const current = (sliderSerial.current[id] ?? 0) + 1;
    sliderSerial.current[id] = current;
    setSliders((old) => ({ ...old, [id]: { step, pending: true } }));
    sliderTimers.current[id] = setTimeout(async () => {
      try {
        const r = await financeApi.debugSlider({ id, step, profit });
        if (sliderSerial.current[id] !== current) return;
        const resolved = r.step ?? step;
        setSliders((old) => ({ ...old, [id]: { ...r, step: resolved } }));
        // 手填利润金额换算出的档位，同步回滑块
        if (profit && r.available) setForms((old) => ({ ...old, [id]: { ...(old[id] ?? defaultForm()), step: resolved } }));
      } catch (e) {
        if (sliderSerial.current[id] === current) setSliders((old) => ({ ...old, [id]: { step, available: false, message: msg(e) } }));
      }
    }, 250);
  }, []);

  const scheduleQuote = useCallback((id: number, source: Form['source'], value: string, step: number, profit?: DebugProfit) => {
    clearTimeout(quoteTimers.current[id]);
    const current = (quoteSerial.current[id] ?? 0) + 1;
    quoteSerial.current[id] = current;
    const num = source === 'priceToRoi' ? yuanToCents(value) : Number(value);
    if (!source || value === '' || num === null || !Number.isFinite(num) || num <= 0) { setQuotes((old) => ({ ...old, [id]: null })); return; }
    setQuotes((old) => ({ ...old, [id]: { pending: true } }));
    quoteTimers.current[id] = setTimeout(async () => {
      try {
        const r = (await financeApi.debugQuote({ mode: source, inputs: [{ id, value: num, step, profit }] })).rows[0];
        if (quoteSerial.current[id] !== current) return;
        setQuotes((old) => ({ ...old, [id]: r }));
        if (r.available) {
          setForms((old) => {
            const f = old[id];
            if (!f || f.source !== source || f.sourceValue !== value || (!profit && f.step !== step) || JSON.stringify(f.profit) !== JSON.stringify(profit)) return old;
            return { ...old, [id]: { ...f, ...(source === 'roiToPrice' ? { price: priceText(r.priceCents!) } : { roi: String(r.roi) }) } };
          });
        }
      } catch (e) {
        if (quoteSerial.current[id] === current) setQuotes((old) => ({ ...old, [id]: { available: false, message: msg(e) } }));
      }
    }, 300);
  }, []);

  // 当前结果页上的商品：档位变了或还没算过的，算一遍
  const chosen = sortPricingRows(Object.values(selected));
  const resultPages = Math.max(1, Math.ceil(chosen.length / 20));
  const visibleResultPage = Math.min(resultPage, resultPages);
  const visibleChosen = chosen.slice((visibleResultPage - 1) * 20, visibleResultPage * 20);
  useEffect(() => {
    visibleChosen.forEach((row) => {
      const f = forms[row.id] ?? defaultForm();
      if (sliders[row.id]?.step !== f.step) scheduleSlider(row.id, f.step, f.profit);
    });
  }, [selected, resultPage]); // eslint-disable-line react-hooks/exhaustive-deps

  function update(id: number, key: 'step' | 'roi' | 'price', value: string | number) {
    const old = forms[id] ?? defaultForm();
    const next: Form = { ...old, [key]: value } as Form;
    if (key === 'roi') { next.source = 'roiToPrice'; next.sourceValue = String(value); next.price = ''; }
    if (key === 'price') { next.source = 'priceToRoi'; next.sourceValue = String(value); next.roi = ''; }
    if (key === 'step') { delete next.profit; delete next.profitDraft; }
    setForms((cur) => ({ ...cur, [id]: next }));
    scheduleQuote(id, next.source, next.sourceValue, next.step, next.profit);
    if (key === 'step') scheduleSlider(id, Number(value));
  }

  /** 手填预留利润金额；sync = 按这个商品的利润比例同步右侧所有已选商品 */
  function setProfit(id: number, text: string, sync = false) {
    if (exporting || addingAll) return;
    const cents = yuanToCents(text);
    if (text === '' || cents === null || Number.isNaN(cents) || cents < 0) {
      if (!sync) {
        clearTimeout(sliderTimers.current[id]); clearTimeout(quoteTimers.current[id]);
        sliderSerial.current[id] = (sliderSerial.current[id] ?? 0) + 1; quoteSerial.current[id] = (quoteSerial.current[id] ?? 0) + 1;
        setSliders((old) => ({ ...old, [id]: { step: (forms[id] ?? defaultForm()).step, available: false, message: '请填写利润金额（元，最多两位小数）' } }));
        setQuotes((old) => ({ ...old, [id]: null }));
        setForms((old) => ({ ...old, [id]: { ...(old[id] ?? defaultForm()), profitDraft: text } }));
      }
      return;
    }
    const profit: DebugProfit = { id, amountCents: cents };
    const targets = sync ? Object.keys(selected).map(Number) : [id];
    const nextForms = { ...forms };
    for (const t of targets) {
      const f = { ...(forms[t] ?? defaultForm()), profit, profitDraft: t === id ? text : undefined };
      nextForms[t] = f;
      scheduleSlider(t, f.step, profit);
      scheduleQuote(t, f.source, f.sourceValue, f.step, profit);
    }
    setForms(nextForms);
    if (sync) setFeedback(`已按当前商品的利润比例同步 ${targets.length} 项；没有可用价格的商品会提示原因`);
  }

  const forget = (id: number) => {
    clearTimeout(quoteTimers.current[id]); clearTimeout(sliderTimers.current[id]);
    quoteSerial.current[id] = (quoteSerial.current[id] ?? 0) + 1; sliderSerial.current[id] = (sliderSerial.current[id] ?? 0) + 1;
    const drop = <T,>(o: Record<number, T>) => { const n = { ...o }; delete n[id]; return n; };
    setSliders(drop); setQuotes(drop);
  };
  function toggle(row: DebugRow) {
    if (addingAll || exporting) return;
    if (selected[row.id]) forget(row.id);
    setSelected((old) => { const next = { ...old }; if (next[row.id]) delete next[row.id]; else next[row.id] = row; return next; });
  }
  function togglePage(checked: boolean) {
    if (addingAll || exporting || loading || error) return;
    if (!checked) data.rows.forEach((r) => forget(r.id));
    setSelected((old) => selectPricingPage(old, data.rows, checked));
    setResultPage(1);
  }
  async function addAll() {
    if (addingAll || loading || error || !data.total) return;
    setAddingAll(true); setError(''); setFeedback('');
    try {
      const rows = new Map<number, DebugRow>();
      for (let p = 1; ; p++) {
        const r = await financeApi.debugList({ keyword: keyword.trim() || undefined, categoryId, baseCodeId, page: p, pageSize: 100 });
        if (cancelled.current) return;
        r.rows.forEach((x) => rows.set(x.id, x));
        if (!r.rows.length || p * r.pageSize >= r.total) break;
      }
      const added = [...rows.values()].filter((r) => !selected[r.id]);
      setSelected((old) => ({ ...Object.fromEntries([...rows.values()].map((r) => [r.id, r])), ...old }));
      setResultPage(1);
      setFeedback(`已加入 ${added.length} 项，筛选结果共 ${rows.size} 项（已选项自动去重）`);
    } catch (e) { setFeedback(msg(e) || '批量加入失败，请重试'); }
    setAddingAll(false);
  }
  function clearSelection() {
    Object.keys(selected).forEach((id) => forget(Number(id)));
    setSelected({}); setForms({}); setQuotes({}); setSliders({}); setResultPage(1);
  }
  async function copyText(value: string, label: string) {
    let copied = false;
    try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); copied = true; } } catch { /* 用下面的备用办法 */ }
    if (!copied) {
      const ta = document.createElement('textarea');
      ta.value = value; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      try { ta.select(); copied = document.execCommand('copy'); } catch { /* 复制失败 */ } finally { ta.remove(); }
    }
    setFeedback(copied ? `已复制${label}` : `复制${label}失败，请手动复制`);
  }

  const exportable = chosen.filter((row) => {
    const f = forms[row.id] ?? defaultForm(), s = sliders[row.id], q = quotes[row.id];
    const sliderReady = s?.available && s.step === f.step && !s.pending;
    return !q?.pending && (sliderReady || q?.available === true);
  });
  async function exportResults() {
    if (exporting || !exportable.length) return;
    setExporting(true); setFeedback('');
    try {
      const inputs: DebugExportInput[] = exportable.map((row) => {
        const f = forms[row.id] ?? defaultForm(), q = quotes[row.id], s = sliders[row.id];
        const ready = q?.available === true && f.source !== null;
        const value = f.source === 'priceToRoi' ? yuanToCents(f.sourceValue) ?? undefined : Number(f.sourceValue);
        return {
          id: row.id, step: f.step, profit: f.profit, mode: ready ? f.source! : 'sliderPrice',
          ...(ready ? { value, sellingPriceCents: q.priceCents, roi: q.roi } : {}),
          ...(s?.available && s.step === f.step ? { sliderPriceCents: s.priceCents } : {}),
        };
      });
      const r = await financeApi.debugExport(inputs);
      const bytes = Uint8Array.from(window.atob(r.fileBase64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const a = document.createElement('a');
      a.href = url; a.download = r.fileName; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setFeedback(`已导出 ${r.rowCount} 条已完成调试的商品`);
    } catch (e) {
      setFeedback(msg(e) || '导出失败，请重试');
      // 服务端核对发现数据变过：把已选商品全部重新试算一遍
      if (e instanceof ApiError && e.status === 409) {
        load(true);
        chosen.forEach((row) => { const f = forms[row.id] ?? defaultForm(); scheduleSlider(row.id, f.step, f.profit); scheduleQuote(row.id, f.source, f.sourceValue, f.step, f.profit); });
      }
    }
    setExporting(false);
  }

  const pageCount = Math.max(1, Math.ceil(data.total / data.pageSize));
  const pageSelected = data.rows.filter((r) => selected[r.id]).length;
  const allPageSelected = data.rows.length > 0 && pageSelected === data.rows.length;
  const weightText = (r: DebugRow) => (r.weightG && r.weightG > 0 ? `${Number((r.weightG / 1000).toFixed(3))} kg` : '重量未记录');

  return (
    <div className="pricing-debug-page">
      <div className="page-head"><h1>定价调试表</h1></div>
      <p className="muted">从当前SKU成本表选择组合商品；按公司低价调节预留利润，试算不修改正式售价或成本。</p>
      <div className="pricing-debug-layout">
        <section className="card pricing-debug-panel">
          <header className="between"><h2>挑选商品</h2><small className="muted">{loading ? '正在筛选…' : `筛选结果 ${data.total} 项`}</small></header>
          <div className="toolbar">
            <PricingComponentFilter value={component} disabled={addingAll} onChange={(v) => { setComponent(v); setPage(1); }} />
            <input type="search" aria-label="搜索组合编码或名称" placeholder="搜索组合编码或名称" disabled={addingAll} value={keyword} onChange={(e) => { setKeyword(e.target.value); setPage(1); }} />
            <button type="button" className="primary-button" disabled={loading || addingAll || exporting || Boolean(error) || !data.total} onClick={addAll}>{addingAll ? '加入中…' : '全选到右侧 →'}</button>
          </div>
          <div className="between">
            <label className="check-line"><input type="checkbox" aria-label="全选当前页商品" checked={allPageSelected} ref={(n) => { if (n) n.indeterminate = pageSelected > 0 && !allPageSelected; }}
              disabled={loading || addingAll || exporting || Boolean(error) || !data.rows.length} onChange={(e) => togglePage(e.target.checked)} />{allPageSelected ? '取消全选' : '全选'} <small className="muted">本页 {data.rows.length} 项</small></label>
            <small className="muted">按重量由轻到重</small>
          </div>
          {error && <div role="alert" className="notice error">{error}</div>}
          <div className="pricing-debug-list" aria-busy={loading}>
            {!loading && !error && sortPricingRows(data.rows).map((row) => (
              <label key={row.id} className="pricing-debug-item">
                <input type="checkbox" checked={Boolean(selected[row.id])} disabled={exporting || addingAll} onChange={() => toggle(row)} />
                <span><strong>{row.skuName}</strong><small className="muted">{row.skuCode} · {row.categoryName} · {weightText(row)}{!row.ready ? ' · 暂不可试算' : ''}</small></span>
                <em>公司低价 {money(row.minPriceCents)}</em>
              </label>
            ))}
            {loading ? <p className="muted" role="status">正在加载…</p> : !error && !data.rows.length && <p className="muted">没有匹配的SKU成本项目</p>}
          </div>
          <footer className="between"><span className="muted">共 {data.total} 项 · 第 {page}/{pageCount} 页</span>
            <span className="row-actions"><button type="button" className="secondary-button small" disabled={page <= 1 || loading || addingAll} onClick={() => setPage(page - 1)}>上一页</button><button type="button" className="secondary-button small" disabled={page >= pageCount || loading || addingAll} onClick={() => setPage(page + 1)}>下一页</button></span></footer>
        </section>

        <section className="card pricing-debug-panel">
          <header className="between"><h2>联动试算</h2>
            <span className="row-actions"><small className="muted">已选 {chosen.length} 项 · 可导出 {exportable.length} 项</small>
              <button type="button" className="secondary-button small" disabled={exporting || addingAll || !chosen.length} onClick={clearSelection}>清空</button>
              <button type="button" className="primary-button small" disabled={exporting || addingAll || !exportable.length} onClick={exportResults}>{exporting ? '导出中…' : '导出 Excel'}</button></span></header>
          {feedback && <div role="status" className="notice ok">{feedback}</div>}
          <div className="table-scroll">
            <table className="data-table pricing-debug-table">
              <thead><tr><th>商品与分类</th><th>预留利润</th><th>目标投产</th><th>试算售价（元）</th><th>状态</th><th className="num">公司低价</th><th>操作</th></tr></thead>
              <tbody>
                {visibleChosen.map((row) => {
                  const f = forms[row.id] ?? defaultForm(), q = quotes[row.id], s = sliders[row.id];
                  const sliderOk = s?.available && s.step === f.step && !s.pending;
                  return (
                    <tr key={row.id}>
                      <td>
                        <div><strong>{row.skuName}</strong> <button type="button" className="link-button" aria-label={`复制商品名称 ${row.skuName}`} onClick={() => copyText(row.skuName, '商品名称')}>复制</button></div>
                        <div className="muted">{row.skuCode} · {row.categoryName} · {weightText(row)} <button type="button" className="link-button" aria-label={`复制SKU编码 ${row.skuCode}`} onClick={() => copyText(row.skuCode, 'SKU编码')}>复制</button></div>
                      </td>
                      <td className="pricing-debug-slider-cell">
                        <input aria-label={`${row.skuName} 预留利润`} type="range" disabled={exporting} min={0} max={140} step={1} value={f.step} onChange={(e) => update(row.id, 'step', Number(e.target.value))} />
                        <div aria-live="polite" className="pricing-debug-slider-values">
                          {s?.step !== f.step || s?.pending
                            ? <><small>预留利润 · 计算中…</small><small>预留利润后售价 —</small></>
                            : s?.available
                              ? <><small>预留利润 {yuan(s.reservedProfitCents!)}{s.reservedProfitPercent != null && <span>（{s.reservedProfitPercent}%）</span>}</small><small>预留利润后售价 {money(s.priceCents)}</small></>
                              : <><small>预留利润 —</small><small title={s?.message}>{s?.message || '暂无可用价格'}</small></>}
                        </div>
                        <div className="row-actions">
                          <input aria-label={`${row.skuName} 手填预留利润金额`} type="number" min="0" step="0.01" placeholder="利润金额" disabled={exporting || addingAll || !row.ready}
                            value={f.profitDraft ?? (sliderOk ? (s.reservedProfitCents! / 100).toFixed(2) : '')} onChange={(e) => setProfit(row.id, e.target.value)} />元
                          <button type="button" className="secondary-button small" disabled={exporting || addingAll || !row.ready || (f.profitDraft == null && !sliderOk) || f.profitDraft === ''}
                            title="按此商品的预留利润比例同步右侧所有已选商品" onClick={() => setProfit(row.id, f.profitDraft ?? (s!.reservedProfitCents! / 100).toFixed(2), true)}>同步利润率</button>
                        </div>
                      </td>
                      <td><input aria-label={`${row.skuName} 目标投产`} type="number" disabled={exporting} min="1.01" step="0.01" placeholder="填投产" value={f.roi} onChange={(e) => update(row.id, 'roi', e.target.value)} /></td>
                      <td><input aria-label={`${row.skuName} 试算售价`} type="number" disabled={exporting} min="0.01" step="0.01" placeholder="填售价" value={f.price} onChange={(e) => update(row.id, 'price', e.target.value)} /></td>
                      <td>{q?.pending ? '试算中…' : q?.available === false ? q.message : q?.available ? '已试算' : sliderOk ? '档位已调试' : '待填写'}</td>
                      <td className="num">{money(row.minPriceCents)}</td>
                      <td><button type="button" className="link-button" disabled={exporting} onClick={() => toggle(row)}>移除</button></td>
                    </tr>
                  );
                })}
                {!chosen.length && <tr><td colSpan={7} className="empty-state muted">尚未选择商品</td></tr>}
              </tbody>
            </table>
          </div>
          {chosen.length > 0 && (
            <footer className="between"><span className="muted">已选 {chosen.length} 项 · 第 {visibleResultPage}/{resultPages} 页</span>
              <span className="row-actions"><button type="button" className="secondary-button small" aria-label="试算上一页" disabled={visibleResultPage <= 1 || exporting || addingAll} onClick={() => setResultPage(visibleResultPage - 1)}>上一页</button>
                <button type="button" className="secondary-button small" aria-label="试算下一页" disabled={visibleResultPage >= resultPages || exporting || addingAll} onClick={() => setResultPage(visibleResultPage + 1)}>下一页</button></span></footer>
          )}
        </section>
      </div>
    </div>
  );
}
