import { Fragment, useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../../auth/AuthContext';
import { ApiError } from '../../../api/client';
import { Pager, centsToYuan, money, yuanToCents } from '../common';
import { expressApi, type EstimateRow, type Estimates } from './expressApi';

const PAGE_SIZE = 50;
const METHOD: Record<string, string> = {
  provincial_majority_mean_plus_10_percent: '各省最低价，取相差 15% 内的多数省份均价 ×1.1',
  provincial_upper_trimmed_mean_plus_10_percent: '各省最低价，去掉最高约 20% 后均价 ×1.1',
  split_parcel_sum: '超过单包上限，按拆包累加',
};
const err = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message || '操作失败');
const range = (r: EstimateRow) => `${r.start} ~ ${r.end} kg`;

/** 成本表预估快递费：按重量段汇总各合作快递的最低价，估出一个典型运费；可以给某个重量段手工定价，拆包时同样生效。 */
export function FreightEstimatePage() {
  const { can } = useAuth();
  const canEdit = can('resource.finance-freight-overrides.edit') && can('product.cost.edit');
  const [data, setData] = useState<Estimates | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState('30');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ key: string; text: string } | null>(null);

  const apply = (d: Estimates) => { setData(d); setLimit(String(d.parcelLimit)); };
  const load = useCallback(async () => {
    try { apply(await expressApi.estimates()); setError(''); } catch (e) { setError(err(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function run(fn: () => Promise<Estimates>, done: string) {
    setBusy(true); setError(''); setNotice('');
    try { apply(await fn()); setNotice(done); } catch (e) { setError(err(e)); }
    setBusy(false);
  }
  function saveLimit() {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 100) return setError('单包重量上限要填 1 到 100 之间的整数（公斤）');
    void run(() => expressApi.setParcelLimit(n), `单包上限已改为 ${n}kg，已重新计算`);
  }
  function saveManual(r: EstimateRow) {
    const cents = yuanToCents(edit?.text ?? '');
    if (cents === null || Number.isNaN(cents) || cents < 0) return setError('手工运费要填大于等于 0 的金额（最多两位小数，可以填 0）');
    void run(() => expressApi.setOverride(r.start, r.end, cents), `「${range(r)}」已设为手工运费`).then(() => setEdit(null));
  }

  const rows = data?.rows ?? [];
  const shown = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  return (
    <div>
      <div className="page-head between">
        <h1>成本表预估快递费</h1>
        <div className="toolbar">
          <label>单包重量上限（kg）<input type="number" min={1} max={100} step={1} aria-label="单包重量上限" value={limit} disabled={!canEdit} onChange={(e) => setLimit(e.target.value)} style={{ width: 80 }} /></label>
          {canEdit && <button type="button" className="secondary-button" disabled={busy || String(data?.parcelLimit) === limit} onClick={saveLimit}>保存上限</button>}
          {canEdit && <button type="button" className="primary-button" disabled={busy} onClick={() => void run(() => expressApi.recalculate(), '已重新计算并保存')}>{busy ? '计算中…' : '重新计算'}</button>}
        </div>
      </div>
      <div className="notice">
        <strong>这张表怎么算的</strong>
        <ol>
          <li>只看“当前版本 + 合作中 + 日期有效”的价格；每个省取各家最便宜的报价，再取相差 15% 内的多数省份的均价，上浮 10%。省份太少（不足 3 个）的重量段不估价。</li>
          <li>6kg 以上凑不成多数时，会去掉最高约 20% 的省份再取均价。</li>
          <li>超过单包上限的重量，按“整包 + 余量”拆开累加；某个重量段设了手工运费，拆出来的包裹碰到这个段也按手工运费算。</li>
        </ol>
      </div>
      {notice && <div role="status" className="notice ok">{notice}</div>}
      {error && <div role="alert" className="notice error">{error}</div>}
      {data && <p className="muted">目前有 {data.cooperatingGroups} 个价格版本参与计算；{data.calculatedAt ? `上次保存快照：${new Date(data.calculatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}` : '还没有保存过快照，点“重新计算”保存'}。</p>}
      {data && data.orphanOverrides.length > 0 && <div className="notice warn">有 {data.orphanOverrides.length} 条手工运费的重量段在当前单包上限下已不是标准段（{data.orphanOverrides.map((o) => `${o.weightFrom}~${o.weightTo}kg`).join('、')}），暂时不生效。</div>}
      <div className="table-scroll"><table className="data-table">
        <thead><tr><th>重量段</th><th>估算方式</th><th className="num">自动估价</th><th className="num">手工运费</th><th className="num">最终运费</th><th /></tr></thead>
        <tbody>
          {data && rows.length === 0 && <tr><td colSpan={6} className="empty-state muted">还没有可用的价格。请先在“快递价格”里把网点的当前版本设为“合作中”。</td></tr>}
          {shown.map((r) => {
            const isBase = !r.parcels;
            const final = r.manualAmount ?? r.autoAmount;
            return (
              <Fragment key={r.key}>
                <tr>
                  <td>{range(r)}</td>
                  <td>{r.autoAmount === null ? <span className="muted">无法估价（省份样本不足）</span> : METHOD[r.method] ?? r.method}</td>
                  <td className="num">{money(r.autoAmount)}</td>
                  <td className="num">
                    {isBase && edit?.key === r.key ? (
                      <span className="row-actions">
                        <input aria-label={`${range(r)} 手工运费`} autoFocus inputMode="decimal" style={{ width: 90 }} value={edit.text} onChange={(e) => setEdit({ key: r.key, text: e.target.value })} />
                        <button type="button" className="secondary-button small" disabled={busy} onClick={() => saveManual(r)}>保存</button>
                        <button type="button" className="link-button" onClick={() => setEdit(null)}>取消</button>
                      </span>
                    ) : isBase ? (
                      <span className="row-actions">{r.manualAmount !== null ? money(r.manualAmount) : '—'}
                        {canEdit && <button type="button" className="link-button" onClick={() => setEdit({ key: r.key, text: centsToYuan(r.manualAmount ?? r.autoAmount) })}>{r.manualAmount !== null ? '改' : '手工定价'}</button>}
                        {canEdit && r.manualAmount !== null && <button type="button" className="link-button danger" disabled={busy} onClick={() => void run(() => expressApi.setOverride(r.start, r.end, null), `「${range(r)}」已取消手工运费`)}>取消手工</button>}</span>
                    ) : <span className="muted">不能单独定价</span>}
                  </td>
                  <td className="num"><strong>{money(final)}</strong></td>
                  <td><button type="button" className="link-button" aria-expanded={open === r.key} onClick={() => setOpen(open === r.key ? null : r.key)}>{open === r.key ? '收起' : '明细'}</button></td>
                </tr>
                {open === r.key && (
                  <tr><td colSpan={6} className="detail-cell">
                    {r.parcels ? (
                      <div>拆包：{r.parcels.map((p, i) => <span key={i}>{i ? ' + ' : ''}{p.count} 个 {p.weight}kg 包裹 × {money(p.amount)}{p.source === 'manual' ? '（手工）' : ''}</span>)}</div>
                    ) : (
                      <div>
                        <p>参与估价 {r.sampleCount} 个省份，取其中 {r.includedCount} 个，样本均价 {r.baseAverage === null ? '—' : money(Math.round(r.baseAverage))}。
                          {r.excludedHighProvinces.length > 0 && `剔除偏高：${r.excludedHighProvinces.join('、')}。`}{r.excludedLowProvinces.length > 0 && `剔除偏低：${r.excludedLowProvinces.join('、')}。`}</p>
                        <div className="table-scroll"><table className="data-table compact"><thead><tr><th>省份</th><th>最低价</th><th>来自</th><th>适用规则</th></tr></thead><tbody>
                          {r.provinceQuotes.map((q) => <tr key={q.province}><td>{q.province}</td><td>{money(q.amount)}</td><td>{q.carrierName} / {q.branchName} / {q.versionName}</td><td>{q.rule}</td></tr>)}
                        </tbody></table></div>
                      </div>
                    )}
                  </td></tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table></div>
      {rows.length > PAGE_SIZE && <Pager page={page} total={rows.length} pageSize={PAGE_SIZE} onPage={setPage} />}
    </div>
  );
}
