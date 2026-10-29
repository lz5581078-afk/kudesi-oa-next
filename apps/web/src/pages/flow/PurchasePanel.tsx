import { useCallback, useEffect, useState } from 'react';
import { PAYMENT_MODES, unitYuanText } from '@kudesi/shared';
import { ApiError } from '../../api/client';
import { RefSelect } from '../../resources/RecordForm';
import { purchaseApi, yuan, type PurchaseSummary } from './purchaseApi';
import './purchase.css';

/** 单价（分，最多 4 位小数）显示成元，至少两位小数 */
const unitYuan = (cents: number) => { const t = unitYuanText(cents); return `¥${/\.\d$/.test(t) ? `${t}0` : t.includes('.') ? t : `${t}.00`}`; };

const WAREHOUSE_FIELD = { key: 'warehouseId', label: '入库仓库', type: 'ref', ref: 'finance-warehouses', group: '' } as const;

/** 流程详情里的“采购摘要”：商品明细、验收进度、付款、入库单草稿。金额类只有成本查看权限的人才收得到。 */
export function PurchasePanel({ runId, refreshKey, onChanged }: { runId: number; refreshKey: number; onChanged: () => void }) {
  const [sum, setSum] = useState<PurchaseSummary | null>(null);
  const [error, setError] = useState('');
  const [warehouse, setWarehouse] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const load = useCallback(() => { purchaseApi.summary(runId).then((s) => { setSum(s); setError(''); }).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败')); }, [runId]);
  useEffect(load, [load, refreshKey]);

  async function makeDraft() {
    if (!warehouse) return setError('请先选择入库仓库');
    setBusy(true);
    setError('');
    try {
      const r = await purchaseApi.inboundDraft(runId, { warehouseId: warehouse });
      setMsg(`已生成采购入库单草稿 ${r.docNo}（只是草稿，没有开立和过账；到“财务 → 草稿中心”核对后由财务处理）`);
      load();
      onChanged();
    } catch (e) { setError(e instanceof ApiError ? e.message : '生成失败'); } finally { setBusy(false); }
  }

  if (error && !sum) return <div role="alert" className="notice error">{error}</div>;
  if (!sum) return null;
  const received = sum.lines.some((l) => l.received !== null);
  return (
    <section className="pur-sum" aria-label="采购摘要">
      <h3 className="section-title">采购摘要</h3>
      <dl className="pur-sum-meta">
        <div><dt>供应商</dt><dd>{sum.supplier?.name ?? '尚未确定'}</dd></div>
        <div><dt>订单号</dt><dd>{sum.orderNo ?? '—'}</dd></div>
        <div><dt>付款方式</dt><dd>{PAYMENT_MODES.find((m) => m.value === sum.paymentMode)?.label.replace(/（.*/, '') ?? '—'}</dd></div>
        <div><dt>承诺到货日</dt><dd>{sum.promisedArrivalDate ?? '—'}</dd></div>
        {sum.canSeeMoney && <div><dt>采购金额</dt><dd>{yuan(sum.totalCents)}</dd></div>}
        {sum.canSeeMoney && <div><dt>已登记付款</dt><dd>{yuan(sum.paidCents)}</dd></div>}
      </dl>
      {!sum.canSeeMoney && <p className="muted">单价、金额和付款只有“成本查看”权限的人能看到。</p>}
      <table className="pur-table">
        <thead><tr><th>商品</th><th className="num">申请数量</th>{sum.canSeeMoney && <th className="num">单价</th>}{received && <th className="num">累计到货</th>}{received && <th className="num">累计合格</th>}</tr></thead>
        <tbody>
          {sum.lines.map((l) => (
            <tr key={l.productId}>
              <td data-label="商品"><strong>{l.name}</strong>{l.code && <small className="muted"> {l.code}</small>}{l.note && <div className="muted">{l.note}</div>}</td>
              <td className="num" data-label="申请数量">{l.qty}{l.unit}</td>
              {sum.canSeeMoney && <td className="num" data-label="单价">{l.unitPriceCents === undefined ? '—' : unitYuan(l.unitPriceCents)}</td>}
              {received && <td className="num" data-label="累计到货">{l.received ?? 0}</td>}
              {received && <td className="num" data-label="累计合格">{l.accepted ?? 0}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      {sum.inbound && <p>已生成采购入库单草稿 <span className="mono">{sum.inbound.docNo}</span>（在“财务 → 草稿中心”查看，流程不会自动过账）。</p>}
      {msg && <div role="status" className="notice ok-notice">{msg}</div>}
      {error && <div role="alert" className="notice error">{error}</div>}
      {sum.canGenerateDraft && (
        <div className="pur-draft">
          <span>合格的 {sum.acceptedCount} 个商品可以生成采购入库单草稿：</span>
          <RefSelect field={WAREHOUSE_FIELD as never} value={warehouse} onChange={setWarehouse} />
          <button type="button" className="primary-button" disabled={busy || !warehouse} onClick={() => void makeDraft()}>{busy ? '生成中…' : '生成采购入库单草稿'}</button>
        </div>
      )}
    </section>
  );
}
