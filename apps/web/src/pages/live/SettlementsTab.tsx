import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { downloadText, toCsv } from '../../resources/csv';
import { liveApi, type SettlementDetail, type SettlementHead } from './liveApi';
import { errText, money, ratePct, yuanText } from './liveFormat';
import { Modal } from './liveUi';

const TONE: Record<string, string> = { draft: '', submitted: 'warn', returned: 'bad', approved: 'ok' };

function DetailDialog({ id, canManage, onClose, onChanged, onOpenSession }: { id: number; canManage: boolean; onClose: () => void; onChanged: () => void; onOpenSession: (sessionId: number) => void }) {
  const [d, setD] = useState<SettlementDetail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { liveApi.settlement(id).then((x) => { setD(x); setError(''); }).catch((e) => setError(errText(e, '读取失败'))); }, [id]);
  useEffect(load, [load]);
  async function act(kind: 'recheck' | 'submit') {
    if (!d) return;
    setBusy(true); setError('');
    try { if (kind === 'recheck') await liveApi.generateSettlement(d.month, d.note || undefined); else await liveApi.submitSettlement(d.id); load(); onChanged(); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }
  const editable = canManage && d && (d.status === 'draft' || d.status === 'returned');
  return (
    <Modal title={d ? `${d.month} 直播提成月结` : '直播提成月结'} size="wide" onClose={onClose} foot={d && <>
      <button type="button" className="secondary-button" onClick={() => downloadText(`直播提成月结-${d.month}.csv`, toCsv([['日期', '直播间', '人员', '角色', '最终销售额', '比例', '原提成', '订单数', '退款', '扣减', '应发', '场次编号'], ...d.lines.map((l) => [l.date, l.roomName, l.userName, l.roleLabel, yuanText(l.finalSalesCents), ratePct(l.rateUnits), yuanText(l.commissionCents), String(l.orderCount), yuanText(l.refundCents), yuanText(l.deductionCents), yuanText(l.payableCents), String(l.sessionId)])]))}>导出 CSV</button>
      {editable && <button type="button" className="secondary-button" disabled={busy} onClick={() => void act('recheck')}>重新核对退款</button>}
      {editable && <button type="button" className="primary-button" disabled={busy} onClick={() => void act('submit')}>{d.status === 'returned' ? '重新提交审批' : '提交审批'}</button>}
    </>}>
      {error && <div role="alert" className="notice error">{error}</div>}
      {!d && !error && <p className="muted" role="status">正在读取…</p>}
      {d && (
        <>
          <div className="live-cards">
            <div className="card live-stat"><span>原提成合计</span><strong>{money(d.commissionTotalCents)}</strong></div>
            <div className="card live-stat"><span>退款合计</span><strong>{money(d.refundTotalCents)}</strong></div>
            <div className="card live-stat"><span>扣减合计</span><strong>{money(d.deductionTotalCents)}</strong></div>
            <div className="card live-stat"><span>应发合计</span><strong>{money(d.payableTotalCents)}</strong></div>
          </div>
          <p className="muted"><span className={`pill ${TONE[d.status]}`}>{d.statusLabel}</span> 共 {d.recordCount} 条提成 · 退款核对于 {d.refundsCheckedAt ?? '—'}（聚水潭只读）{d.flowRunId ? <> · <Link to="/flow/overview">查看审批流程</Link></> : ''}</p>
          {d.status === 'returned' && d.returnReason && <div className="notice warn">已退回：{d.returnReason}。请重新核对后再提交。</div>}
          <strong>按人员</strong>
          <div className="live-scroll"><table className="data-table" aria-label="按人员汇总"><thead><tr><th>人员</th><th>角色</th><th className="num">场次</th><th className="num">原提成</th><th className="num">扣减</th><th className="num">应发</th></tr></thead>
            <tbody>{d.byPerson.map((p) => <tr key={`${p.userId}${p.role}`}><td>{p.name}</td><td>{p.roleLabel}</td><td className="num">{p.sessions}</td><td className="num">{money(p.commissionCents)}</td><td className="num">{money(p.deductionCents)}</td><td className="num">{money(p.payableCents)}</td></tr>)}</tbody></table></div>
          <strong>明细（点场次查看）</strong>
          <div className="live-scroll"><table className="data-table" aria-label="结算明细"><thead><tr><th>日期</th><th>直播间</th><th>人员</th><th>角色</th><th className="num">比例</th><th className="num">原提成</th><th className="num">退款</th><th className="num">扣减</th><th className="num">应发</th><th /></tr></thead>
            <tbody>{d.lines.map((l) => <tr key={l.id}><td>{l.date}</td><td>{l.roomName}</td><td>{l.userName}</td><td>{l.roleLabel}</td><td className="num">{ratePct(l.rateUnits)}</td><td className="num">{money(l.commissionCents)}</td><td className="num">{money(l.refundCents)}</td><td className="num">{money(l.deductionCents)}</td><td className="num">{money(l.payableCents)}</td><td><button type="button" className="link-button" onClick={() => onOpenSession(l.sessionId)}>场次</button></td></tr>)}</tbody></table></div>
          <strong>退款依据（{d.refunds.length} 单有退款）</strong>
          {d.refunds.length === 0 ? <p className="muted">本月没有查到退款。</p> : (
            <div className="live-scroll"><table className="data-table" aria-label="退款依据"><thead><tr><th>场次</th><th>订单号</th><th className="num">订单金额</th><th className="num">退款</th><th>依据</th></tr></thead>
              <tbody>{d.refunds.map((r) => <tr key={`${r.sessionId}${r.orderId}`}><td>#{r.sessionId}</td><td>{r.orderId}</td><td className="num">{money(r.orderAmountCents)}</td><td className="num">{money(r.refundCents)}</td><td>{r.source === 'cancelled' ? '订单已取消' : '已完成的售后单'}</td></tr>)}</tbody></table></div>
          )}
        </>
      )}
    </Modal>
  );
}

/** 提成月结：人事按月生成（只读核对聚水潭退款）、提交审批；月初 10 天默认上月。 */
export function SettlementsTab({ onOpenSession }: { onOpenSession: (id: number) => void }) {
  const [d, setD] = useState<{ canManage: boolean; defaultMonth: string; rows: SettlementHead[] } | null>(null);
  const [month, setMonth] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const load = useCallback(() => { liveApi.settlements().then((x) => { setD(x); setMonth((m) => m || x.defaultMonth); setError(''); }).catch((e) => setError(errText(e, '读取失败'))); }, []);
  useEffect(load, [load]);
  async function generate() {
    setBusy(true); setError('');
    try { const r = await liveApi.generateSettlement(month, note.trim() || undefined); load(); setOpen(r.id); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }
  return (
    <div className="live-page">
      {d?.canManage && (
        <section className="card live-section" aria-label="生成结算单">
          <div className="live-filter">
            <label className="live-field">结算月份<input aria-label="结算月份" type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></label>
            <label className="live-field">备注（可选）<input aria-label="结算备注" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></label>
            <button type="button" className="primary-button" disabled={busy || !month} onClick={() => void generate()}>{busy ? '核对退款中…' : '生成 / 重新核对'}</button>
          </div>
          <p className="muted pad">所有场次必须已审核；每条提成按本场保存的订单只读核对聚水潭退款，扣减 = 退款 × 原比例（不超过原提成）。任一店铺查不到退款就不会生成。</p>
        </section>
      )}
      {error && <div role="alert" className="notice error toast-line"><span>{error}</span><button type="button" className="link-button" onClick={load}>重试</button></div>}
      <section className="card live-section" aria-label="历史结算">
        <h2>历史结算</h2>
        {d && d.rows.length === 0 && <p className="muted pad" role="status">还没有生成过结算单。</p>}
        <ul className="live-list">{d?.rows.map((r) => (
          <li key={r.id}>
            <div className="main"><strong>{r.month}</strong><small>{r.recordCount} 条提成 · 原提成 {money(r.commissionTotalCents)} · 扣减 {money(r.deductionTotalCents)} · 应发 {money(r.payableTotalCents)}</small></div>
            <span className={`pill ${TONE[r.status]}`}>{r.statusLabel}</span>
            <button type="button" className="secondary-button small" onClick={() => setOpen(r.id)}>查看</button>
          </li>
        ))}</ul>
      </section>
      {open !== null && d && <DetailDialog id={open} canManage={d.canManage} onClose={() => setOpen(null)} onChanged={load} onOpenSession={onOpenSession} />}
    </div>
  );
}
