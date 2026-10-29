import type { PartyBalance } from '../financeApi';
import { money } from '../common';

/** 往来对象余额条（管家婆“往来单位详情 / 信用额度查询”）：选了对象就显示他现在欠我们、我们欠他、预收预付各多少；赊销额度超了给提醒（只提醒，不拦单）。 */
export function PartyBalanceBar({ balance, extraReceivable = 0 }: { balance: PartyBalance | null; extraReceivable?: number }) {
  if (!balance) return null;
  const items: Array<[string, number, boolean]> = [['应收', balance.receivableCents, balance.receivableCents > 0], ['应付', balance.payableCents, balance.payableCents > 0], ['预收款', balance.advanceReceiptCents, balance.advanceReceiptCents > 0], ['预付款', balance.prepaymentCents, balance.prepaymentCents > 0]];
  const shown = items.filter(([, v, on]) => on || v !== 0);
  const after = balance.receivableCents + extraReceivable;
  const over = balance.creditLimitCents !== null && after > balance.creditLimitCents;
  return (
    <div className="vc-balance" aria-label="往来余额">
      <span className="vc-balance-name">{balance.name}</span>
      {shown.length === 0 && <span className="muted">暂无往来余额</span>}
      {shown.map(([label, v]) => <span key={label} className="vc-chip">{label} <b>{money(v)}</b></span>)}
      {balance.creditLimitCents !== null && <span className="vc-chip">赊销额度 <b>{money(balance.creditLimitCents)}</b></span>}
      {over && <span className="vc-warn" role="alert">本单挂账后应收约 {money(after)}，超过赊销额度 {money(balance.creditLimitCents)}（仅提醒，请确认是否继续）</span>}
    </div>
  );
}
