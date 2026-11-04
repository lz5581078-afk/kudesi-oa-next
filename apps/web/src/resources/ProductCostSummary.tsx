import { useState } from 'react';
import { COST_BUCKETS, unitYuanText, type ResourceDef } from '@kudesi/shared';
import type { ResourceDto } from './api';
import { currentProductPurchasePrice } from './productPurchasePrice';
import { useProductPurchaseHistory, purchasePriceStats, purchaseRecordedAt } from './ProductPurchaseHistory';

const yuan = (v: unknown) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : `¥${unitYuanText(Number(v))}`);
const bucketLabel = (v: unknown) => COST_BUCKETS.find((o) => o.value === v)?.label ?? String(v ?? '');

/** 商品档案详情顶部的成本汇总：采购价 + 运费 + 装卸费 = 总成本价，上次/近 3 个月平均采购价，最新档案成本。 */
export function ProductCostSummary({ def, record, reference = false }: { def: ResourceDef; record: ResourceDto; reference?: boolean }) {
  const [open, setOpen] = useState(false);
  const d = record.data;
  const hasCost = def.fields.some((f) => f.key === 'totalCost') && ('totalCost' in d || 'purchasePrice' in d || 'freight' in d);
  const { rows: history, error: historyError, retry } = useProductPurchaseHistory(record, hasCost);
  if (!hasCost) return null; // 没有成本查看权限时服务端不返回成本字段，这一块不显示

  const spec = String(d.purchaseSpec || [d.specQty, d.specUnit].filter(Boolean).join(' ') || '');
  const stats = purchasePriceStats(history ?? []);
  const priced = stats.rows, last = priced[0], avg = stats.average;
  const composed = ['self_made', 'oem_package'].includes(String(d.archiveType)) || d.supplyMode === 'supplier_oem';
  return (
    <section className="cost-summary" aria-label="成本汇总">
      <h2 className="section-title">{reference ? '总成本价（含运费、装卸费）' : `成本汇总${spec ? `（元/${spec}）` : ''}`}</h2>
      {reference && spec && <small className="muted">元/{spec}</small>}
      <div className="cost-summary-row">
        <div><small className="muted">{composed ? '总采购价（构成汇总）' : '采购价'}</small><strong>{yuan(currentProductPurchasePrice(record)) ?? '未维护'}</strong></div>
        <i aria-hidden>+</i>
        <div><small className="muted">运费</small><strong>{yuan(d.freight) ?? '未维护'}</strong></div>
        <i aria-hidden>+</i>
        <div><small className="muted">装卸费</small><strong>{yuan(d.handlingFee) ?? '未维护'}</strong></div>
        <i aria-hidden>=</i>
        <div className="is-total"><small className="muted">总成本价</small><strong>{yuan(d.totalCost) ?? '待补齐'}</strong></div>
      </div>
      <dl className="kv">
        <dt>最新档案成本</dt>
        <dd>{yuan(d.latestUnitCost) ? `${yuan(d.latestUnitCost)}（${bucketLabel(d.latestCostType)}${d.latestCostFrom ? ` · ${String(d.latestCostFrom)}生效` : ''}）` : <span className="muted">未维护，可在“档案成本记录”页签添加</span>}</dd>
        <dt>上次采购价</dt>
        <dd>{history === null ? '读取中…' : last ? yuan(last.data.purchasePrice) : <span className="muted">暂无</span>}</dd>
        <dt>3 个月平均采购价</dt>
        <dd>{history === null ? '读取中…' : avg === null ? <span className="muted">暂无</span> : `¥${unitYuanText(avg)}`}</dd>
      </dl>
      {(reference || priced.length > 0) && <button type="button" className="link-button" aria-expanded={open} onClick={() => setOpen((v) => !v)}>历史采购价（{priced.length}）</button>}
      {historyError && <p role="alert">历史采购价读取失败。<button type="button" onClick={retry}>重试</button></p>}
      {open && (
        <ul className="plain-list">
          {!historyError && history !== null && !priced.length && <li>暂无历史采购价</li>}
          {priced.map((h) => <li key={h.id}><strong>{yuan(h.data.purchasePrice)}</strong> <small className="muted">{new Date(purchaseRecordedAt(h)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</small></li>)}
        </ul>
      )}
    </section>
  );
}
