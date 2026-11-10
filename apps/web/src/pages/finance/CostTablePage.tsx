import { useCostIdentityKey } from './CostIdentityBoundary';
import { CostRegistrationDialog } from './CostRegistrationDialog';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { History, Pencil, RefreshCw, X } from 'lucide-react';
import { Pager, money, pct } from './common';
import { CostCategoryTree } from './CostCategoryTree';
import { BreakdownDialog, costMoney, PricingEditDialog, SkuHistoryDialog, type EditTarget } from './CostDialogs';
import { financeApi, type CostRow, type CostTableData, type CostRegisterPreview } from './financeApi';
import { CostVersionWorkspace } from './CostVersionWorkspace';

export function CostTablePage() {
  return <CurrentCostTable />;
}

export function CostVersionsPage() {
  return <CostVersionWorkspace />;
}

const EMPTY: CostTableData = { total: 0, page: 1, pageSize: 20, rows: [], categories: [], defaultMargin: { percent: null, revision: 'none' }, allTotal: 0, canEdit: false };
const REFRESH_MS = 15000;

/** 成本表：每个商品组合的成本、重量、运费、含运费成本、利润率、最低售价，现算，不存副本；15 秒自动刷新。 */
export function CurrentCostTable() {
  const identity = useCostIdentityKey();
  return <CurrentCostTableContent key={identity}/>;
}

function CurrentCostTableContent() {
  const [keyword, setKeyword] = useState('');
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<CostTableData>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [registration, setRegistration] = useState<CostRegisterPreview | null>(null);
  const [registering, setRegistering] = useState(false);
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
      .catch((e) => { if (current === serial.current) setError(e instanceof ApiError ? e.message : '加载失败'); })
      .finally(() => { if (current === serial.current) setBusy(false); });
  }, [keyword, categoryId, page]);


  useEffect(() => { const t = setTimeout(() => load(), 200); return () => { clearTimeout(t); serial.current++; }; }, [load]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState !== 'hidden') load(true); };
    const timer = setInterval(refresh, REFRESH_MS);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [load]);

  async function previewMissing() {
    setRegistering(true); setError('');
    try { setRegistration(await financeApi.previewCostRegistration()); }
    catch (error) { setError(error instanceof Error ? error.message : '预览失败'); }
    finally { setRegistering(false); }
  }
  async function fillMissing() {
    if (!registration) return;
    setRegistering(true); setError('');
    try {
      const result = await financeApi.registerCost({ missingOnly: true, confirmed: true, signature: registration.signature, reason: '补齐已验证SKU' });
      setRegistering(false); setRegistration(null); setNotice(`已补齐 ${result.recorded} 条SKU成本`);
      load();
    } catch (error) { setError(error instanceof Error ? error.message : '补齐失败'); setRegistering(false); }
  }

  return (
    <div>
      <div className="page-head between">
        <h1>SKU成本表</h1>

      </div>
      {notice && <div role="status" className="notice ok">{notice} <button type="button" className="link-button" aria-label="关闭提示" onClick={() => setNotice('')}><X size={14}/></button></div>}
      {error && !editing && !registration && <div role="alert" className="notice error">{error}</div>}
      <div className="cost-layout">
        <CostCategoryTree data={data} selected={categoryId} onSelect={(id) => { setCategoryId(id); setPage(1); }}
          onEdit={(t) => { setError(''); setEditing({ kind: 'category', ...t }); }} />
        <main className="cost-main">
          <div className="toolbar">
            <input className="search-box" type="search" aria-label="搜索SKU成本" placeholder="SKU组合编码 / SKU名称" value={keyword} onChange={(e) => { setKeyword(e.target.value); setPage(1); }} />
            <span className="muted">{data.total} 条</span>
            {data.canFill && <button type="button" className="secondary-button" disabled={busy || registering} onClick={() => void previewMissing()}>补齐已验证SKU</button>}
            <button type="button" className="secondary-button" aria-label="刷新成本表" title="刷新成本表" disabled={busy} onClick={() => load()}><RefreshCw size={16}/></button>
          </div>
          <div className="table-scroll">
            <table className="data-table cards-narrow">
              <thead><tr><th>SKU组合编码</th><th>SKU名称</th><th className="num">成本</th><th className="num">预发货成本</th><th className="num">重量（kg）</th><th>使用快递</th><th className="num">预估运费</th><th className="num">含快递成本</th><th className="num">利润率</th><th className="num">最低售价</th><th>操作</th></tr></thead>
              <tbody>
                {data.rows.length === 0 && <tr><td colSpan={11} className="empty-state muted">{busy ? '正在加载成本资料…' : '暂无符合条件的SKU成本'}</td></tr>}
                {data.rows.map((r) => (
                  <tr key={r.bundleId}>
                    <td className="mono" data-label="SKU组合编码">{r.code}</td>
                    <td data-label="SKU名称" title={r.issues.join('；') || undefined}>{r.name}{r.costState && r.costState !== 'current' && <div className="notice warning" role="status"><strong>{r.costState === 'fallback' ? '沿用上次有效成本' : '待完善成本'}</strong><div>{r.issues.join('；')}</div>{r.lastSuccessfulAt && <div className="muted">有效成本更新于 {new Date(r.lastSuccessfulAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</div>}</div>}</td>
                    <td className="num" data-label="成本"><button type="button" className="link-button" aria-label={`查看${r.name}成本组成`} onClick={() => setBreakdown({ row: r, kind: 'cost' })}>{costMoney(r.preShipCostCents)}</button></td>
                    <td className="num" data-label="预发货成本">{costMoney(r.preShipCostCents)}</td>
                    <td className="num" data-label="重量（kg）"><button type="button" className="link-button" aria-label={`查看${r.name}重量组成`} onClick={() => setBreakdown({ row: r, kind: 'weight' })}>{r.weightG === null ? '未设置' : Number((r.weightG / 1000).toFixed(6))}</button></td>
                    <td data-label="使用快递">{r.carrierName || <span className="muted">未指定</span>}</td>
                    <td className="num" data-label="预估运费">{costMoney(r.freightCents)}<div className="muted">{r.freightMethod === 'manual_override' ? '重量段预估（人工调整）' : r.freightMethod === '手工填写' ? '本组合手工填写' : r.freightMethod ? '重量段预估' : '缺少运费预估'}</div></td>
                    <td className="num" data-label="含快递成本">{r.costIncludingFreightCents === null ? '待估价' : costMoney(r.costIncludingFreightCents)}</td>
                    <td className="num" data-label="利润率"><strong>{pct(r.marginPercent)}</strong><div className="muted">{r.marginOverride ? '单品设置' : `继承：${r.marginSource}`}</div></td>
                    <td className="num strong" data-label="最低售价">{money(r.minPriceCents)}</td>
                    <td>
                      <div className="row-actions">
                        {data.canEdit && <button type="button" className="link-button" aria-label={`维护${r.name}售价`} onClick={() => { setError(''); setEditing({ kind: 'sku', row: r }); }}><Pencil size={16}/></button>}
                        <button type="button" className="link-button" aria-label={`查看${r.name}成本历史`} onClick={() => setHistory(r)}><History size={16}/></button>
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
      {registration && <CostRegistrationDialog preview={registration} busy={registering} error={error} onClose={() => { setRegistration(null); setError(''); }} onRefresh={() => void previewMissing()} onConfirm={() => void fillMissing()} />}
      {breakdown && <BreakdownDialog row={breakdown.row} kind={breakdown.kind} onClose={() => setBreakdown(null)} />}
    </div>
  );
}
