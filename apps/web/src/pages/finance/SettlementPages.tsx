import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { DocDetail } from './DocDetail';
import { money } from './common';
import { financeApi, type SettlementRow, type UnsettledRow } from './financeApi';

function Filters({ from, to, docType, setFrom, setTo, setDocType }: { from: string; to: string; docType: string; setFrom: (v: string) => void; setTo: (v: string) => void; setDocType: (v: string) => void }) {
  return (
    <div className="toolbar">
      <input type="date" aria-label="开始日期" value={from} onChange={(e) => setFrom(e.target.value)} /><span className="muted">至</span><input type="date" aria-label="结束日期" value={to} onChange={(e) => setTo(e.target.value)} />
      <select aria-label="单据类型" value={docType} onChange={(e) => setDocType(e.target.value)}><option value="">收款单和付款单</option><option value="receipt">收款单</option><option value="payment">付款单</option></select>
    </div>
  );
}

/** 收付款结算明细表：每张收付款单把钱分给了哪几张单据（哪个商品）。 */
export function SettlementDetailPage() {
  const [rows, setRows] = useState<SettlementRow[] | null>(null);
  const [error, setError] = useState('');
  const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [docType, setDocType] = useState('');
  const [docId, setDocId] = useState<number | null>(null);
  useEffect(() => { financeApi.settlementDetail({ from: from || undefined, to: to || undefined, docType: docType || undefined }).then(setRows).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败')); }, [from, to, docType]);
  const total = (rows ?? []).reduce((s, r) => s + r.amountCents, 0);
  return (
    <div className={docId ? 'split' : undefined}>
      <div className="split-main">
        <div className="page-head between"><h1>收付款结算明细表</h1><Filters {...{ from, to, docType, setFrom, setTo, setDocType }} /></div>
        {error && <div role="alert" className="notice error">{error}</div>}
        <div className="table-scroll"><table className="data-table">
          <thead><tr><th>日期</th><th>收付款单</th><th>往来对象</th><th>结算方式</th><th>被结算单据</th><th>商品</th><th className="num">结算金额</th></tr></thead>
          <tbody>
            {rows?.length === 0 && <tr><td colSpan={7} className="empty-state muted">这段时间没有按单据/按商品结算的收付款单</td></tr>}
            {rows?.map((r) => (
              <tr key={r.id}><td>{r.docDate}</td><td className="mono"><button type="button" className="link-button" onClick={() => setDocId(r.docId)}>{r.docNo}</button> <span className="muted">{r.typeLabel}</span></td><td>{r.partyName}</td><td>{r.settleByLabel}</td>
                <td className="mono"><button type="button" className="link-button" onClick={() => setDocId(r.sourceDocId)}>{r.sourceDocNo}</button> <span className="muted">{r.sourceTypeLabel}</span></td><td>{r.productName}</td><td className="num">{money(r.amountCents)}</td></tr>
            ))}
          </tbody>
          {rows && rows.length > 0 && <tfoot><tr><th colSpan={6}>合计</th><th className="num">{money(total)}</th></tr></tfoot>}
        </table></div>
      </div>
      {docId && <DocDetail key={docId} id={docId} onClose={() => setDocId(null)} onChanged={() => undefined} />}
    </div>
  );
}

/** 未完全结算收付款单查询：已过账的收款单/付款单里，还有钱没分给具体单据的。按金额结算的整张都算没分配。 */
export function UnsettledReceiptsPage() {
  const [rows, setRows] = useState<UnsettledRow[] | null>(null);
  const [error, setError] = useState('');
  const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [docType, setDocType] = useState('');
  const [docId, setDocId] = useState<number | null>(null);
  useEffect(() => { financeApi.unsettledReceipts({ from: from || undefined, to: to || undefined, docType: docType || undefined }).then(setRows).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败')); }, [from, to, docType]);
  const total = (rows ?? []).reduce((s, r) => s + r.unallocatedCents, 0);
  return (
    <div className={docId ? 'split' : undefined}>
      <div className="split-main">
        <div className="page-head between"><h1>未完全结算收付款单</h1><Filters {...{ from, to, docType, setFrom, setTo, setDocType }} /></div>
        <p className="muted">收到的钱（或付出的钱）还有一部分没有对应到具体的销售单/采购单。可以新开一张按单据结算的收付款单把它们对上，也可以保持按金额结算。</p>
        {error && <div role="alert" className="notice error">{error}</div>}
        <div className="table-scroll"><table className="data-table">
          <thead><tr><th>日期</th><th>单号</th><th>往来对象</th><th>结算方式</th><th className="num">本次结算金额</th><th className="num">已分配到单据</th><th className="num">未分配</th></tr></thead>
          <tbody>
            {rows?.length === 0 && <tr><td colSpan={7} className="empty-state muted">没有未完全结算的收付款单</td></tr>}
            {rows?.map((r) => (
              <tr key={r.id}><td>{r.docDate}</td><td className="mono"><button type="button" className="link-button" onClick={() => setDocId(r.id)}>{r.docNo}</button> <span className="muted">{r.typeLabel}</span></td><td>{r.partyName}</td><td>{r.settleByLabel}</td>
                <td className="num">{money(r.totalCents)}</td><td className="num">{money(r.allocatedCents)}</td><td className="num strong">{money(r.unallocatedCents)}</td></tr>
            ))}
          </tbody>
          {rows && rows.length > 0 && <tfoot><tr><th colSpan={6}>合计未分配</th><th className="num">{money(total)}</th></tr></tfoot>}
        </table></div>
      </div>
      {docId && <DocDetail key={docId} id={docId} onClose={() => setDocId(null)} onChanged={() => undefined} />}
    </div>
  );
}
