import { useEffect, useState } from 'react';
import { FileCheck2, RefreshCw } from 'lucide-react';
import { useAuth } from '../../../auth/AuthContext';
import { centsToYuan, money, yuanToCents } from '../common';
import { useExpressWorkspace } from './ExpressWorkspaceContext';
import { expressApi, type EstimateRow, type Estimates } from './expressApi';
import './freightEstimate.css';

const PAGE_SIZE = 50;
const range = (row: EstimateRow) => `${row.start}–${row.end}kg`;
const formatTime = (text: string) => new Date(text).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

/** Edits span every page and are submitted together; automatic amounts belong to the saved snapshot. */
export function FreightEstimatePage() {
  const hosted = Boolean(useExpressWorkspace());
  const { can } = useAuth();
  const canEdit = can('resource.finance-freight-overrides.edit') && can('product.cost.edit');
  const [data, setData] = useState<Estimates | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [limit, setLimit] = useState('30');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(1);
  function apply(result: Estimates) {
    setData(result); setLimit(String(result.parcelLimit)); setPage(1);
    setDrafts(Object.fromEntries(result.rows.filter(row => !row.parcels).map(row => [row.key, centsToYuan(row.manualAmount)])));
  }
  useEffect(() => {
    let active = true;
    void expressApi.estimates().then(result => { if (active) apply(result); }).catch(e => { if (active) setError((e as Error).message || '预估运费读取失败'); });
    return () => { active = false; };
  }, []);
  async function run(operation: () => Promise<Estimates>) {
    if (busy) return;
    setBusy(true); setError('');
    try { apply(await operation()); }
    catch (e) { setError((e as Error).message || '保存失败'); }
    finally { setBusy(false); }
  }
  function recalculate() {
    const value = Number(limit);
    if (!Number.isInteger(value) || value < 1 || value > 100) return setError('单包重量上限要填 1 到 100 之间的整数（公斤）');
    void run(() => expressApi.recalculate(value, data?.revision ?? 0));
  }
  function saveManual() {
    if (!data) return;
    const changes: Array<{ weightFrom: number; weightTo: number; amount: number | null }> = [];
    for (const row of data.rows.filter(row => !row.parcels)) {
      const value = yuanToCents(drafts[row.key] ?? '');
      if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > 100_000_000)) return setError(`${range(row)} 的手工运费必须是非负金额（最多两位小数）。`);
      changes.push({ weightFrom: row.start, weightTo: row.end, amount: value });
    }
    void run(() => expressApi.saveOverrides(data.revision ?? 0, changes));
  }
  const rows = data?.rows ?? [];
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  return <section className="express-freight-estimate">
    {hosted ? <header className="express-panel-heading"><div className="express-panel-title"><FileCheck2 size={18} aria-hidden="true" /><h2>成本表预估快递费</h2></div></header> : <h1>成本表预估快递费</h1>}
    <div className="express-freight-head"><div><strong>连续重量段的典型省份报价预估</strong><span>每省先取当前合作报价中的最低价，优先选价格相差不超过 15%、覆盖超过半数省份的最大一组；从 6–7kg 重量段起若无法形成多数价格组，则剔除最高约 20% 的省份报价（孤立的最低价也剔除）后取均价。两种均价均上浮 10%；不足 3 个有报价省份时不自动估价。不含临时加收，手工金额优先。组合成本表刷新后采用，历史成本快照在下次重算时采用。</span></div><label>单包上限 <input aria-label="单包重量上限" type="number" min="1" max="100" step="1" value={limit} disabled={busy || !canEdit} onChange={e => setLimit(e.target.value)} /> kg · 总重至 1000kg</label>{canEdit && <button type="button" className="primary-button" disabled={busy} onClick={recalculate}><RefreshCw size={15} aria-hidden="true" />{busy ? '处理中…' : '重新计算'}</button>}</div>
    {error && <div className="express-freight-error" role="alert">{error} <button type="button" disabled={busy} onClick={() => void run(expressApi.estimates)}>重试读取</button></div>}
    {data?.calculatedAt && <div className="express-freight-notice">上次计算：{formatTime(data.calculatedAt)}。价格表或预估口径变化后请重新计算；保存手工金额不会改变自动报价来源。</div>}
    {data?.requiresRecalculation && <div className="express-freight-notice">发货范围或旧预估口径已变更，请重新计算。手工金额仍按已保存值使用。</div>}
    {!rows.length ? <div className="express-freight-empty"><strong>还没有成本表预估运费</strong><span>点击“重新计算”生成连续重量段；没有合作报价的段也可以填写手工运费。</span></div> : <>
      <div className="express-freight-scroll"><table className="express-freight-table"><thead><tr><th>重量段</th><th>预估运费</th><th>省份报价样本</th><th>手工运费（元）/ 拆包明细</th><th>最终采用</th><th>取值方式</th></tr></thead><tbody>{rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(row => {
        const draft = drafts[row.key] ?? '';
        const manual = draft.trim() !== '';
        const preview = manual ? yuanToCents(draft) : row.autoAmount;
        return <tr key={row.key}><td><strong>{range(row)}</strong><small>大于 {row.start}，不超过 {row.end}kg</small></td><td>{row.shippingUnavailable ? '发货范围已变更，请重新计算' : row.autoAmount == null ? '无可用自动估价' : <><b>{money(row.autoAmount)}</b><small>{row.parcels ? '各包运费合计' : `样本均价 ${money(row.baseAverage)} × 1.10`}</small></>}</td>
          <td>{row.parcels ? <details className="express-freight-samples"><summary>查看各包运费</summary>{row.parcels.map((part, i) => <p key={i}>{part.count} 包 × {part.weight}kg：每包 {part.amount == null ? '缺少报价' : money(part.amount)}{part.source === 'manual' ? '（手工价）' : ''}</p>)}</details> : row.sampleCount ? <details className="express-freight-samples"><summary>采纳 {row.includedCount}/{row.sampleCount} 省 · 查看明细</summary><div><p>采纳：{row.includedProvinces.join('、') || '无'}</p><p>剔除偏低：{row.excludedLowProvinces.join('、') || '无'}</p><p>剔除偏高：{row.excludedHighProvinces.join('、') || '无'}</p><ul>{row.provinceQuotes.map(quote => <li key={quote.province}>{quote.province} {money(quote.amount)} · {quote.carrierName} / {quote.branchName}</li>)}</ul></div></details> : '无省份报价'}</td>
          <td>{row.parcels ? <span>{row.parcels.map(part => `${part.count}包 × ${part.weight}kg`).join(' + ')}</span> : <input aria-label={`${row.start}至${row.end}公斤手工运费`} type="number" min="0" step="0.01" placeholder="留空用自动价" value={draft} disabled={busy || !canEdit} onChange={e => setDrafts(current => ({ ...current, [row.key]: e.target.value }))} />}</td><td><strong>{money(preview)}</strong></td><td>{row.parcels ? row.autoAmount == null ? '部分包裹缺少报价' : '拆包合计（含单包手工调整）' : manual ? '手工优先' : row.autoAmount == null ? '无可用自动估价' : row.method === 'provincial_upper_trimmed_mean_plus_10_percent' ? '高价尾部剔除均价 +10%' : '多数省份均价 +10%'}</td></tr>;
      })}</tbody></table></div>
      <div className="express-freight-actions"><span>共 {rows.length} 段 · 第 {page}/{pageCount} 页</span><div>{[['首页', 1], ['上一页', page - 1], ['下一页', page + 1], ['末页', pageCount]].map(([label, target], i) => <button type="button" key={label} disabled={i < 2 ? page <= 1 : page >= pageCount} onClick={() => setPage(Number(target))}>{label}</button>)}</div></div>
      <div className="express-freight-actions"><span>手工运费可填 0；清空后恢复自动预估价。未保存的输入不会进入成本表。</span>{canEdit && <button type="button" className="primary-button" disabled={busy} onClick={saveManual}>保存手工调整</button>}</div>
    </>}
  </section>;
}
