import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { Pager, money, pct } from './common';
import { CostCategoryTree } from './CostCategoryTree';
import { BreakdownDialog, METHOD, PricingEditDialog, SkuHistoryDialog, type EditTarget } from './CostDialogs';
import { financeApi, type CostRow, type CostTableData } from './financeApi';

const EMPTY: CostTableData = { total: 0, page: 1, pageSize: 20, rows: [], categories: [], defaultMargin: { percent: null, revision: 'none' }, allTotal: 0, canEdit: false };
const REFRESH_MS = 15000;

/** 成本表：每个商品组合的成本、重量、运费、含运费成本、利润率、最低售价，现算，不存副本；15 秒自动刷新。 */
export function CostTablePage() {
  const [keyword, setKeyword] = useState('');
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<CostTableData>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [history, setHistory] = useState<CostRow | null>(null);
  const [breakdown, setBreakdown] = useState<{ row: CostRow; kind: 'cost' | 'weight' } | null>(null);
  const serial = useRef(0);

  const load = useCallback((quiet = false) => {
    const current = ++serial.current;
    if (!quiet) setBusy(true);
    financeApi.costTable({ keyword: keyword.trim(), categoryId: categoryId ?? undefined, page })
      .then((r) => {
        if (current !== serial.current) return;
        setData(r);
        if (!quiet) setError('');
        setPage((p) => Math.min(p, Math.max(1, Math.ceil(r.total / r.pageSize))));
      })
      .catch((e) => { if (current === serial.current && !quiet) setError(e instanceof ApiError ? e.message : '加载失败'); })
      .finally(() => { if (current === serial.current) setBusy(false); });
  }, [keyword, categoryId, page]);

  async function exportTable() {
    setError('');
    try {
      const r = await financeApi.exportCostTable({ categoryId: categoryId ?? undefined, keyword: keyword.trim() || undefined });
      const bytes = Uint8Array.from(window.atob(r.fileBase64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const a = document.createElement('a');
      a.href = url; a.download = r.fileName; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setNotice(`已导出 ${r.rowCount} 条（按当前分类和搜索条件）`);
    } catch (e) { setError(e instanceof ApiError ? e.message : '导出失败'); }
  }

  useEffect(() => { const t = setTimeout(() => load(), 200); return () => { clearTimeout(t); serial.current++; }; }, [load]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState !== 'hidden') load(true); };
    const timer = setInterval(refresh, REFRESH_MS);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [load]);

  return (
    <div>
      <div className="page-head between">
        <h1>成本表</h1>
        <div className="row-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void exportTable()}>导出 Excel</button>
          <button type="button" className="secondary-button" disabled={busy} onClick={() => load()}>刷新</button>
        </div>
      </div>
      <p className="muted">
        最低售价 = (发货前成本 + 运费) ÷ (1 − 利润率)，向上取整到分。成本、重量、运费、利润率任何一处改了，这里立刻跟着变（每 15 秒自动刷新）。
        运费来自 <Link to="/finance/finance-express-prices">快递价格表</Link>；利润率可以在左边的分类目录里设置，也可以在每一行单独设置。
      </p>
      {notice && <div role="status" className="notice ok">{notice} <button type="button" className="link-button" onClick={() => setNotice('')}>关闭</button></div>}
      {error && !editing && <div role="alert" className="notice error">{error}</div>}
      <div className="cost-layout">
        <CostCategoryTree data={data} selected={categoryId} onSelect={(id) => { setCategoryId(id); setPage(1); }}
          onEdit={(t) => { setError(''); setEditing({ kind: 'category', ...t }); }} />
        <main className="cost-main">
          <div className="toolbar">
            <input className="search-box" type="search" aria-label="搜索SKU成本" placeholder="SKU组合编码 / SKU名称" value={keyword} onChange={(e) => { setKeyword(e.target.value); setPage(1); }} />
            <span className="muted">{data.total} 条</span>
          </div>
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th>SKU组合编码</th><th>SKU名称</th><th className="num">成本</th><th className="num">重量(g)</th><th>使用快递</th><th className="num">预估运费</th><th className="num">含快递成本</th><th className="num">利润率</th><th className="num">最低售价</th><th>状态</th><th>操作</th></tr></thead>
              <tbody>
                {data.rows.length === 0 && <tr><td colSpan={11} className="empty-state muted">{busy ? '正在加载成本资料…' : '暂无符合条件的SKU成本。先去“商品组合编码”建组合并验证。'}</td></tr>}
                {data.rows.map((r) => (
                  <tr key={r.bundleId}>
                    <td className="mono">{r.code}</td>
                    <td>{r.name}</td>
                    <td className="num"><button type="button" className="link-button" aria-label={`查看${r.name}成本组成`} onClick={() => setBreakdown({ row: r, kind: 'cost' })}>{money(r.preShipCostCents)}</button></td>
                    <td className="num"><button type="button" className="link-button" aria-label={`查看${r.name}重量组成`} onClick={() => setBreakdown({ row: r, kind: 'weight' })}>{r.weightG ?? '未设置'}</button></td>
                    <td>{r.carrierName || <span className="muted">未指定</span>}</td>
                    <td className="num">{money(r.freightCents)}<div className="muted">{r.freightMethod ? (METHOD[r.freightMethod] ?? r.freightMethod) : '缺少运费预估'}</div></td>
                    <td className="num">{r.costIncludingFreightCents === null ? '待估价' : money(r.costIncludingFreightCents)}</td>
                    <td className="num"><strong>{pct(r.marginPercent)}</strong><div className="muted">{r.marginOverride ? '单品设置' : `继承：${r.marginSource}`}</div></td>
                    <td className="num strong">{money(r.minPriceCents)}</td>
                    <td>{r.issues.length ? <span className="pill warn" title={r.issues.join('；')}>{r.issues.length} 项待补</span> : <span className="pill ok">完整</span>}</td>
                    <td>
                      <div className="row-actions">
                        {data.canEdit && <button type="button" className="link-button" aria-label={`维护${r.name}售价`} onClick={() => { setError(''); setEditing({ kind: 'sku', row: r }); }}>维护售价</button>}
                        <button type="button" className="link-button" aria-label={`查看${r.name}成本历史`} onClick={() => setHistory(r)}>成本历史</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={page} total={data.total} pageSize={data.pageSize} onPage={setPage} />
        </main>
      </div>
      {editing && (
        <PricingEditDialog target={editing} categories={data.categories} onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); setNotice('已保存，售价已按最新规则更新'); load(); }} onConflict={() => load(true)} />
      )}
      {history && <SkuHistoryDialog row={history} onClose={() => setHistory(null)} />}
      {breakdown && <BreakdownDialog row={breakdown.row} kind={breakdown.kind} onClose={() => setBreakdown(null)} />}
    </div>
  );
}
