import { useCallback, useEffect, useState } from 'react';
import { ALLOCATION_LABEL, EXCEPTION_LABEL, FEE_TYPE_LABEL, PAYMENT_MODE_LABEL, batchStageLabel } from '@kudesi/shared';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { EvidenceLinks } from './PurchaseFields';
import { money, purchaseApi, type PurchaseViewDto } from './purchaseApi';

/** 采购详情里的进度面板：商品到货情况、发货批次、付款、费用、退款；申请人的“申请变更”和“终止未到货部分并退款”。价格和付款由服务端按权限返回。 */
export function PurchasePanel({ runId, refreshKey, onChanged }: { runId: number; refreshKey: number; onChanged: () => void }) {
  const { user } = useAuth();
  const [s, setS] = useState<PurchaseViewDto | null>(null);
  const [err, setErr] = useState('');
  const [ask, setAsk] = useState<null | 'amend' | 'cancel_remaining'>(null);
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { purchaseApi.state(runId).then((r) => { setS(r); setErr(''); }).catch((e) => setErr(e instanceof ApiError ? e.message : '加载失败')); }, [runId]);
  useEffect(load, [load, refreshKey]);
  if (err) return <div role="alert" className="notice error">{err}</div>;
  if (!s) return <p className="muted">加载进度…</p>;
  const mine = user?.id === s.requesterId;
  const running = s.status === 'running';
  const paid = s.paid;
  const nm = (id: number) => s.lines.find((l) => l.productId === id)?.name ?? `#${id}`;
  async function send() {
    if (!ask) return;
    setBusy(true);
    try { await purchaseApi.control(runId, { mode: ask, comment: why }); setAsk(null); setWhy(''); load(); onChanged(); } catch (e) { setErr(e instanceof ApiError ? e.message : '操作失败'); } finally { setBusy(false); }
  }
  return (
    <section className="purchase-panel" aria-label="采购进度">
      <h3 className="section-title">采购进度</h3>
      <dl className="kv-grid">
        <div><dt>供应商</dt><dd>{s.supplierName || '待定'}</dd></div>
        <div><dt>收货仓库</dt><dd>{s.warehouseName || '待定'}</dd></div>
        <div><dt>要求到货</dt><dd>{s.requestedArrivalAt || '—'}</dd></div>
        {s.paymentMode && <div><dt>货款方式</dt><dd>{PAYMENT_MODE_LABEL[s.paymentMode as keyof typeof PAYMENT_MODE_LABEL]}</dd></div>}
        {s.money && <div><dt>批准金额</dt><dd>{money(s.approvedCents)}</dd></div>}
        {s.money && s.prepay && <div><dt>预付款</dt><dd>已付 {money(s.prepay.paidCents)} · 占用 {money(s.prepay.claimedCents)} · 已冲抵 {money(s.prepay.offsetCents)} · 未用 {money(s.prepay.unusedCents)}</dd></div>}
      </dl>
      {s.cancelRequested && <p className="notice">已申请终止未到货部分并退款：{s.cancelRequestComment}</p>}
      {s.amendOpen && <p className="notice">申请人正在变更采购内容，变更后需重新核对方案并审批。</p>}
      {s.cancelledRemaining && <p className="muted">未到货部分已终止，已退款。</p>}
      <table className="data-table" aria-label="商品到货情况">
        <thead><tr><th>商品</th><th>采购</th><th>已入库</th><th>已终止</th><th>还要到</th>{s.money && <th>单价（元）</th>}</tr></thead>
        <tbody>
          {s.lines.map((l) => (
            <tr key={l.productId}>
              <td>{l.name}{l.aliasName ? `（${l.aliasName}）` : ''}</td><td>{l.qty}{l.unit}</td><td>{l.received}</td><td>{l.cancelled || '—'}</td><td>{l.remaining}</td>
              {s.money && <td>{l.unitPriceCents == null ? '—' : (l.unitPriceCents / 100).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      {s.batches.map((b, i) => (
        <details key={b.id} className="purchase-card" open={!b.posted}>
          <summary>第 {i + 1} 批 · {batchStageLabel(b as never)} · 物流 {b.logisticsNo || '—'} · 预计到货 {b.expectedArrivalAt || '—'}</summary>
          <p>发货：{b.shipment.map((q) => `${nm(q.productId)} ${q.qty}`).join('，')} <EvidenceLinks runId={runId} ids={b.dispatchFiles} /></p>
          {b.arrived && <p>已到货 <EvidenceLinks runId={runId} ids={b.arrivalFiles} /></p>}
          {b.received && <p>实收：{b.received.map((q) => `${nm(q.productId)} ${q.qty}`).join('，')} <EvidenceLinks runId={runId} ids={b.receiptFiles} />{b.difference && <> · 差异：{b.difference}</>}</p>}
          {b.accepted && <p>合格：{b.accepted.map((q) => `${nm(q.productId)} ${q.qty}`).join('，')} <EvidenceLinks runId={runId} ids={b.qualityFiles} />{b.qualityComment && <> · {b.qualityComment}</>}</p>}
          {b.resolution && <p>异常处置：{EXCEPTION_LABEL[b.resolution as keyof typeof EXCEPTION_LABEL] ?? b.resolution}{b.resolutionComment && `（${b.resolutionComment}）`} <EvidenceLinks runId={runId} ids={b.resolutionFiles} /></p>}
          {b.fees.length > 0 && (
            <ul>{b.fees.map((f) => <li key={f.id}>{FEE_TYPE_LABEL[f.type]}{s.money && ` ${money(f.amountCents)}`} · {f.paid ? `已付${f.paymentDocNo ? ` ${f.paymentDocNo}` : ''}` : '待付'} <EvidenceLinks runId={runId} ids={f.files} /></li>)}</ul>
          )}
          {b.zeroReason && <p className="muted">无费用：{b.zeroReason}</p>}
          {s.money && b.posted && <p>入库单 <span className="mono">{b.docNo}</span> · 货款 {money(b.goodsCents)} · 冲抵预付款 {money(b.offsetCents)}{b.allocationMethod && ` · 费用${ALLOCATION_LABEL[b.allocationMethod as keyof typeof ALLOCATION_LABEL]}分摊`}</p>}
        </details>
      ))}
      {s.money && !!s.payments?.length && (
        <div><h4>货款付款</h4><ul>{s.payments.map((p) => <li key={p.docId}><span className="mono">{p.docNo}</span> {money(p.amountCents)} · 流水 {p.reference} <EvidenceLinks runId={runId} ids={p.files} /></li>)}</ul></div>
      )}
      {s.money && !!s.refunds?.length && (
        <div><h4>退款</h4><ul>{s.refunds.map((r) => <li key={r.docId}><span className="mono">{r.docNo}</span> {money(r.amountCents)} · 流水 {r.reference} <EvidenceLinks runId={runId} ids={r.files} /></li>)}</ul></div>
      )}
      {s.followups.length > 0 && <div><h4>发货跟进</h4><ul>{s.followups.map((f, i) => <li key={i}>{f.byName}：供应商承诺 {f.promisedShipAt} 发货{f.comment ? `（${f.comment}）` : ''}</li>)}</ul></div>}
      {s.amendments.length > 0 && <div><h4>变更记录</h4><ul>{s.amendments.map((a, i) => <li key={i}>{a.byName}：{a.comment}</li>)}</ul></div>}
      {mine && running && paid && !s.cancelRequested && !s.amendOpen && (
        <div className="row-actions">
          <button type="button" className="secondary-button" onClick={() => setAsk('amend')}>申请变更采购内容</button>
          <button type="button" className="secondary-button" onClick={() => setAsk('cancel_remaining')}>申请终止未到货部分并退款</button>
        </div>
      )}
      {ask && (
        <div className="purchase-card">
          <label>{ask === 'amend' ? '变更原因' : '终止原因'}<textarea rows={2} maxLength={500} aria-label="操作原因" value={why} onChange={(e) => setWhy(e.target.value)} /></label>
          <div className="row-actions">
            <button type="button" className="primary-button" disabled={busy || !why.trim()} onClick={() => void send()}>{ask === 'amend' ? '提交变更申请' : '提交终止申请'}</button>
            <button type="button" className="secondary-button" onClick={() => setAsk(null)}>取消</button>
          </div>
        </div>
      )}
    </section>
  );
}
