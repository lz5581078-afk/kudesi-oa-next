import { useCallback, useEffect, useMemo, useState } from 'react';
import { liveApi, type Candidates, type SessionDetail } from './liveApi';
import { errText, money, nowText, roleLabel, yuanCents, hm } from './liveFormat';
import { Modal } from './liveUi';

/** 报下播：只能本人报自己的角色；主播填销售额，中控填销售额和投流费用；主播、中控必须从聚水潭勾选本场订单。 */
export function ReportDialog({ session, onClose, onDone }: { session: SessionDetail; onClose: () => void; onDone: () => void }) {
  const roles = session.me.reportRoles;
  const [role, setRole] = useState<string>(roles[0] ?? 'anchor');
  const mine = session.reports.find((r) => r.role === role);
  const [endAt, setEndAt] = useState(mine ? mine.endAt.slice(0, 16) : nowText());
  const [sales, setSales] = useState(mine ? (mine.salesCents / 100).toFixed(2) : '');
  const [ad, setAd] = useState(mine?.adSpendCents != null ? (mine.adSpendCents / 100).toFixed(2) : '');
  const [note, setNote] = useState(mine?.note ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set(mine?.orders.map((o) => o.orderId) ?? []));
  const [cand, setCand] = useState<Candidates | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const needsOrders = role !== 'operator';

  const load = useCallback((refresh: boolean) => {
    if (!needsOrders) return;
    setLoading(true);
    liveApi.candidates(session.id, { endAt: endAt.length === 16 ? `${endAt}:00` : endAt, refresh }).then((c) => { setCand(c); setError(''); }).catch((e) => setError(errText(e, '读取订单失败'))).finally(() => setLoading(false));
  }, [session.id, endAt, needsOrders]);
  useEffect(() => { load(false); }, [role]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = useMemo(() => (cand?.orders ?? []).filter((o) => selected.has(o.orderId)).reduce((t, o) => t + o.amountCents, 0), [cand, selected]);
  const flip = (id: string) => setSelected((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  async function submit() {
    setError('');
    const s = yuanCents(sales);
    if (s === null || Number.isNaN(s)) return setError('请填写销售额（元，最多两位小数）');
    const a = yuanCents(ad);
    if (role === 'control' && (a === null || Number.isNaN(a))) return setError('中控请填写投流费用（没有投流填 0）');
    if (needsOrders && selected.size === 0) return setError('请从聚水潭勾选本场订单（至少 1 单）');
    setBusy(true);
    try {
      await liveApi.report(session.id, { role, endAt: endAt.length === 16 ? `${endAt}:00` : endAt, salesCents: s, adSpendCents: role === 'control' ? a : undefined, orderIds: needsOrders ? [...selected] : undefined, note: note.trim() || undefined });
      onDone();
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }

  return (
    <Modal title={`报下播（${roleLabel(role)}）`} onClose={onClose} foot={<>
      <button type="button" className="secondary-button" onClick={onClose}>取消</button>
      <button type="button" className="primary-button" disabled={busy} onClick={() => void submit()}>{busy ? '提交中…' : mine ? '保存修改' : '提交下播'}</button>
    </>}>
      {error && <div role="alert" className="notice error">{error}</div>}
      <p className="muted">{session.roomName} · 上播 {hm(session.startAt)}。只能本人填报自己的角色，管理人员不能代填。</p>
      <div className="live-fields">
        {roles.length > 1 && <label className="live-field">填报角色<select value={role} onChange={(e) => setRole(e.target.value)}>{roles.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}</select></label>}
        <label className="live-field">下播时间<input aria-label="下播时间" value={endAt} onChange={(e) => setEndAt(e.target.value)} placeholder="2026-03-01 23:30" /></label>
        <label className="live-field">销售额（元）<input aria-label="销售额" inputMode="decimal" value={sales} onChange={(e) => setSales(e.target.value)} /></label>
        {role === 'control' && <label className="live-field">投流费用（元）<input aria-label="投流费用" inputMode="decimal" value={ad} onChange={(e) => setAd(e.target.value)} /></label>}
        <label className="live-field wide">备注（可选）<textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></label>
      </div>
      {needsOrders && (
        <div className="live-field">
          <span className="between"><span>从聚水潭勾选本场订单（金额与付款时间以服务端重查为准）</span><button type="button" className="secondary-button small" disabled={loading} onClick={() => load(true)}>{loading ? '读取中…' : '刷新订单'}</button></span>
          {cand && !cand.available && <div className="notice warn" role="status">{cand.reason}</div>}
          {cand?.available && (
            <>
              <div className="live-orders" aria-label="订单列表">
                {cand.orders.length === 0 && <p className="muted pad">这个时间段内没有查到订单</p>}
                {cand.orders.map((o) => {
                  const off = !o.paid || o.cancelled;
                  return <label key={o.orderId} className={off ? 'off' : ''}><input type="checkbox" disabled={off} checked={selected.has(o.orderId)} onChange={() => flip(o.orderId)} />{o.orderId}<small className="muted">{o.payTime ? o.payTime.slice(5, 16) : '未付款'} · {o.statusLabel}</small><span className="amt">{money(o.amountCents)}</span></label>;
                })}
              </div>
              <p className="muted" role="status">已勾选 {selected.size} 单，合计 {money(total)}{cand.truncated ? '（订单较多，只显示了一部分，可缩小下播时间重查）' : ''}</p>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
