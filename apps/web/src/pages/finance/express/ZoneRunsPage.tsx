import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../../auth/AuthContext';
import { ApiError } from '../../../api/client';
import { sortRecommendationRules } from '@kudesi/shared';
import { Pager, money } from '../common';
import { expressApi, type ZoneRule, type ZoneRunSummary } from './expressApi';
import { zoneCsvLines } from './zoneCsv';

const err = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message || '操作失败');
const when = (s: string) => new Date(s).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const csvCell = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
const weightText = (r: ZoneRule) => `${r.weightStartOperator === '>' ? '>' : '≥'} ${r.weightStart} kg${r.weightEnd === '' ? '' : `，${r.weightEndOperator === '<' ? '<' : '≤'} ${r.weightEnd} kg`}`;
const priceText = (r: ZoneRule) => (r.amount !== null ? money(r.amount) : r.priceLabel);

/** 分区建议：每次生成都留一条记录，以后能回头翻；生成后不会随价格变动，要看最新的重新生成一次。 */
export function ZoneRunsPage() {
  const { can } = useAuth();
  const canGenerate = can('resource.finance-express-prices.edit');
  const [maxW, setMaxW] = useState('30');
  const [runs, setRuns] = useState<{ items: ZoneRunSummary[]; total: number } | null>(null);
  const [page, setPage] = useState(1);
  const [active, setActive] = useState<(ZoneRunSummary & { rules: ZoneRule[] }) | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const open = useCallback(async (id: number) => {
    try { setActive(await expressApi.zoneRun(id)); setError(''); } catch (e) { setError(err(e)); }
  }, []);
  const load = useCallback(async (p: number, openFirst = false) => {
    try {
      const r = await expressApi.zoneRuns(p, 5);
      setRuns(r);
      if (openFirst && r.items[0]) await open(r.items[0].id);
    } catch (e) { setError(err(e)); }
  }, [open]);
  useEffect(() => { void load(page, page === 1 && active === null); }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  async function generate() {
    const n = Number(maxW);
    if (!(n > 0) || n > 1000) return setError('最高重量要在 0 到 1000 公斤之间');
    setBusy(true); setError('');
    try {
      const r = await expressApi.generateZone(n);
      setPage(1);
      await load(1);
      await open(r.id);
    } catch (e) { setError(err(e)); }
    setBusy(false);
  }
  async function remove(id: number) {
    if (!window.confirm('删除这条生成记录？不会影响价格数据。')) return;
    try { await expressApi.deleteZoneRun(id); if (active?.id === id) setActive(null); await load(page); } catch (e) { setError(err(e)); }
  }
  function exportCsv() {
    if (!active) return;
    const lines = zoneCsvLines(active.rules);
    const blob = new Blob(['﻿' + lines.map((l) => l.map(csvCell).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `聚水潭快递分区建议-第${active.sequence}次.csv`; a.click(); URL.revokeObjectURL(a.href);
  }

  return (
    <div>
      <div className="page-head between">
        <h1>分区建议</h1>
        <div className="toolbar">
          <label>最高重量（kg）<input type="number" min="0.01" step="any" aria-label="最高重量" value={maxW} onChange={(e) => setMaxW(e.target.value)} style={{ width: 90 }} /></label>
          {canGenerate && <button type="button" className="primary-button" disabled={busy} onClick={() => void generate()}>{busy ? '生成中…' : '生成分区建议'}</button>}
          <button type="button" className="secondary-button" disabled={!active?.rules.length} onClick={exportCsv}>导出清单</button>
        </div>
      </div>
      <div className="notice">
        <strong>这份分区建议怎么来的</strong>
        <ol>
          <li>只看“当前版本 + 合作中 + 日期有效”的价格；按各价格的重量边界切成重量段，每个省、每段选报价最低的快递和网点。</li>
          <li>来源和价格都相同的省份合并成一条建议。排序：快递公司 → 网点 → 重量从轻到重 → 省份。</li>
          <li>这是录入聚水潭的参考清单，不会自动写入；临时加收未计入；平台/店铺、优先级、禁发地区仍需在聚水潭里确认。</li>
        </ol>
      </div>
      {error && <div role="alert" className="notice error">{error}</div>}

      <h2>生成记录</h2>
      {runs && runs.items.length === 0 && <p className="muted">还没有生成过。点“生成分区建议”。</p>}
      <ul className="plain-list">
        {runs?.items.map((r) => (
          <li key={r.id} className="between">
            <button type="button" className={active?.id === r.id ? 'tree-item active' : 'tree-item'} onClick={() => void open(r.id)}>
              第 {r.sequence} 次 · {when(r.createdAt)} · 上限 {r.maxWeightKg}kg · {r.cooperatingVersionCount} 个价格版本 · {r.ruleCount} 条规则
            </button>
            {canGenerate && <button type="button" className="link-button danger" onClick={() => void remove(r.id)}>删除记录</button>}
          </li>
        ))}
      </ul>
      {runs && runs.total > 5 && <Pager page={page} total={runs.total} pageSize={5} onPage={setPage} />}

      {active && (
        <div>
          <h2>第 {active.sequence} 次结果</h2>
          <p className="muted">生成于 {when(active.createdAt)}，共 {active.rules.length} 条建议规则。这是当时的快照，之后价格变了不会跟着变。</p>
          <div className="table-scroll"><table className="data-table">
            <thead><tr><th>建议规则名称</th><th>快递 / 网点</th><th>重量范围</th><th className="num">最低标准运费</th><th>限定到达省份</th></tr></thead>
            <tbody>
              {active.rules.length === 0 && <tr><td colSpan={5} className="empty-state muted">没有可用的价格。</td></tr>}
              {sortRecommendationRules(active.rules).map((r, i) => (
                <tr key={i}><td>{r.suggestedRuleName}</td><td>{r.carrierName}{r.branchName ? ` / ${r.branchName}` : ''}{r.jstLogisticsName ? <div className="muted small">聚水潭：{r.jstLogisticsName}</div> : null}</td>
                  <td>{weightText(r)}</td><td className="num">{priceText(r)}</td><td>{r.provinceScope}</td></tr>
              ))}
            </tbody>
          </table></div>
        </div>
      )}
    </div>
  );
}
