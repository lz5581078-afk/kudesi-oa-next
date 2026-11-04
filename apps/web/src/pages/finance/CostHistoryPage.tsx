import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { useCostIdentityKey } from './CostIdentityBoundary';
import { CostHistoryArchives } from './CostHistoryArchives';
import { CostHistoryRecords, CostMarginHistoryRecords } from './CostHistoryRecords';
import { financeApi, type CostSnapshotRow, type MarginHistoryRow } from './financeApi';
const msg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message || '操作失败');

/** 成本历史：每个组合每次成本/重量/运费/利润率/最低售价变化的快照。验证通过时自动登记。 */
export function CostHistoryPage() {
  const identity = useCostIdentityKey();
  return <CostHistoryContent key={identity}/>;
}

function CostHistoryContent() {
  const [rows, setRows] = useState<CostSnapshotRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState('');
  const [error, setError] = useState('');
  // 三种记录：成本变更（每次成本/重量/运费/利润率/最低售价的变化）、售价维护（使用快递、单品利润率）、分类利润率调整
  const [source, setSource] = useState<'changes' | 'margins' | 'archive'>('changes');
  const [marginRows, setMarginRows] = useState<MarginHistoryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (source === 'archive') { setLoading(false); setError(''); setTotal(0); return; }
    let active = true;
    setLoading(true); setError(''); setRows([]); setMarginRows([]); setTotal(0);
    const timer = setTimeout(() => {
      const q = { keyword: keyword.trim() || undefined, page };
      const request = source === 'margins' ? financeApi.marginHistory(q).then(r => { if (active) { setMarginRows(r.rows); setTotal(r.total); } })
        : financeApi.costHistory(q).then(r => { if (active) { setRows(r.rows); setTotal(r.total); } });
      void request.catch(e => { if (active) setError(msg(e)); }).finally(() => { if (active) setLoading(false); });
    }, 150);
    return () => { active = false; clearTimeout(timer); };
  }, [page, keyword, source, refresh]);

  return (
    <div className="finance-cost-history-page">
      <header className="finance-history-heading"><h2>成本历史</h2><p>已确认的成本与售价变更</p></header><div className="finance-history-toolbar"><select aria-label="历史类型" value={source} onChange={(e) => { setSource(e.target.value as typeof source); setPage(1); setKeyword(''); }}><option value="changes">成本变更记录</option><option value="margins">分类利润率记录</option><option value="archive">旧版成本档案（只读）</option></select>{source !== 'archive' && <input aria-label="搜索成本历史" placeholder={source === 'margins' ? '分类或修改原因' : 'SKU编码、名称或修改原因'} value={keyword} onChange={(e) => { setKeyword(e.target.value); setPage(1); }} />}<span>{total} 条</span><button type="button" className="secondary-button" aria-label="刷新历史" disabled={loading} onClick={() => setRefresh(v => v + 1)}><RefreshCw size={16} /></button></div>
      {error && <div role="alert" className="notice error">{error}</div>}
      {source === 'margins' && <CostMarginHistoryRecords key={`${page}:${keyword}:${refresh}`} rows={marginRows} busy={loading}/> }
      {source === 'archive' && <CostHistoryArchives key={refresh} onTotal={setTotal} />}
      {source === 'changes' && <CostHistoryRecords key={`${page}:${keyword}:${refresh}`} rows={rows} busy={loading} />}
      {source !== 'archive' && <div className="toolbar"><button type="button" className="secondary-button small" disabled={loading || page <= 1} onClick={() => setPage(page - 1)}>上一页</button><span className="muted">共 {total} 条 · 第 {page} 页</span><button type="button" className="secondary-button small" disabled={loading || page * 20 >= total} onClick={() => setPage(page + 1)}>下一页</button></div>}
    </div>
  );
}
