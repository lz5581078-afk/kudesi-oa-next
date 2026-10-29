import { SearchPick, centsToYuan, money, yuanToCents } from '../common';
import type { AcctState } from './types';

const sumAcct = (l: AcctState[]) => l.reduce((s, a) => s + (yuanToCents(a.amount) || 0), 0);

/**
 * 多账户收付款（管家婆“多账户选择”）：一笔钱分几个账户收/付，每个账户一行（账户 + 金额）。
 * expected 是必须对上的金额：有商品明细的单据是“还应收/应付的总额”只作提示（实收实付取各行合计），
 * 收款单、付款单这类没有挂账的单据是单据金额，合计必须相等。
 */
export function PayAccounts({ role, accounts, setAccounts, expected, strict, balances, onSingle }: {
  role: 'in' | 'out'; accounts: AcctState[]; setAccounts: (l: AcctState[]) => void; expected: number; strict: boolean; balances: Map<number, number>; onSingle: () => void;
}) {
  const verb = role === 'in' ? '收' : '付';
  const total = sumAcct(accounts);
  const diff = expected - total;
  const ok = strict ? diff === 0 && total > 0 : total > 0;
  return (
    <div className="pay-accts" aria-label={`分账户${verb}款`}>
      <div className="between">
        <strong>分多个账户{verb}款</strong>
        <button type="button" className="link-button" onClick={onSingle}>改回单个账户</button>
      </div>
      <SearchPick ariaLabel={`添加${verb}款账户`} type="bank-accounts" value={null} label="" placeholder={`搜索并添加${verb}款账户`}
        onChange={(id, name) => { if (id && !accounts.some((a) => a.id === id)) setAccounts([...accounts, { id, name, amount: '' }]); }} />
      <ul className="transfer-list">
        {accounts.map((a, k) => {
          const amt = yuanToCents(a.amount) || 0;
          const bal = balances.get(a.id);
          return (
            <li key={a.id}>
              <span>{a.name}{bal !== undefined && <small className="muted">　余额 {money(bal)}{amt > 0 && <> → <b className={bal + (role === 'in' ? amt : -amt) < 0 ? 'neg' : ''}>{money(bal + (role === 'in' ? amt : -amt))}</b></>}</small>}</span>
              <input inputMode="decimal" aria-label={`${a.name}${verb}款金额`} placeholder="金额（元）" value={a.amount} onChange={(e) => setAccounts(accounts.map((x, j) => (j === k ? { ...x, amount: e.target.value } : x)))} />
              <button type="button" className="link-button" onClick={() => setAccounts(accounts.filter((_, j) => j !== k))}>移除</button>
            </li>
          );
        })}
        {accounts.length === 0 && <li className="muted">还没有选{verb}款账户</li>}
      </ul>
      <div className={`transfer-diff${ok ? ' ok' : ' bad'}`} role="status" aria-label="分账户合计">
        各账户合计 {money(total)}
        {strict ? (diff === 0 && total > 0 ? '，和单据金额一致' : `，和单据金额 ${money(expected)} 相差 ${money(Math.abs(diff))}，必须相等`) : total > 0 ? `（即本单${verb}到/付出的金额）` : `，请至少填一个账户的金额`}
        {accounts.length > 0 && diff !== 0 && expected > 0 && (
          <button type="button" className="link-button" onClick={() => { const last = accounts[accounts.length - 1]; const cur = yuanToCents(last.amount) || 0; setAccounts(accounts.map((x) => (x === last ? { ...x, amount: centsToYuan(Math.max(0, cur + diff)) } : x))); }}>　差额 {money(Math.abs(diff))} 填入最后一行</button>
        )}
      </div>
    </div>
  );
}
