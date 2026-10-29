import { SearchPick, centsToYuan, money, yuanToCents } from '../common';
import type { AcctState } from './types';

const sumAcct = (l: AcctState[]) => l.reduce((s, a) => s + (yuanToCents(a.amount) || 0), 0);

/** 转款单：多个转出账户、多个转入账户，两边合计必须相等；显示每个账户转前转后余额 */
export function TransferPanel({ outs, ins, setOuts, setIns, balances }: { outs: AcctState[]; ins: AcctState[]; setOuts: (l: AcctState[]) => void; setIns: (l: AcctState[]) => void; balances: Map<number, number> }) {
  const equal = sumAcct(outs) === sumAcct(ins) && sumAcct(outs) > 0;
  return (
    <section className="transfer-grid">
      {([['out', '转出账户', outs, setOuts], ['in', '转入账户', ins, setIns]] as const).map(([role, label, list, setList]) => (
        <div key={role} className="transfer-side">
          <h3 className="section-title">{label} *</h3>
          <SearchPick ariaLabel={`添加${label}`} type="bank-accounts" value={null} label="" placeholder={`搜索并添加${label}`}
            onChange={(id, name) => { if (id && !list.some((a) => a.id === id)) setList([...list, { id, name, amount: '' }]); }} />
          <ul className="transfer-list">
            {list.map((a, k) => (
              <li key={a.id}>
                <span>{a.name}</span>
                <input inputMode="decimal" aria-label={`${label}${a.name}金额`} placeholder="金额（元）" value={a.amount} onChange={(e) => setList(list.map((x, j) => (j === k ? { ...x, amount: e.target.value } : x)))} />
                <button type="button" className="link-button" onClick={() => setList(list.filter((_, j) => j !== k))}>移除</button>
              </li>
            ))}
            {list.length === 0 && <li className="muted">还没有选{label}</li>}
          </ul>
          <div className="muted">{label.slice(0, 2)}合计：{money(sumAcct(list))}</div>
          {list.some((x) => balances.has(x.id)) && <ul className="transfer-list muted">{list.filter((x) => balances.has(x.id)).map((x) => { const bal = balances.get(x.id) ?? 0; const amt = yuanToCents(x.amount) || 0; const after = bal + (role === 'out' ? -amt : amt); return <li key={x.id}><span>{x.name}：余额 {money(bal)}{amt > 0 && <> → {role === 'out' ? '转出' : '转入'}后 <b className={after < 0 ? 'neg' : ''}>{money(after)}</b></>}</span></li>; })}</ul>}
          {(() => { const other = sumAcct(role === 'out' ? ins : outs); const mine = sumAcct(list); return other > 0 && other !== mine && list.length > 0 ? <button type="button" className="link-button" onClick={() => { const rest = other - mine; const last = list[list.length - 1]; const cur = yuanToCents(last.amount) || 0; setList(list.map((x) => (x === last ? { ...x, amount: centsToYuan(Math.max(0, cur + rest)) } : x))); }}>按另一边填入差额 {money(Math.abs(other - mine))}</button> : null; })()}
        </div>
      ))}
      <button type="button" className="secondary-button small" disabled={!outs.length && !ins.length} title="转出与转入账户互换" onClick={() => { const o = outs; setOuts(ins); setIns(o); }}>⇄ 互换转出/转入</button>
      <div className={`transfer-diff${equal ? ' ok' : ' bad'}`}>
        {equal ? `转款 ${money(sumAcct(outs))}，两边相等` : `转出与转入相差 ${money(Math.abs(sumAcct(outs) - sumAcct(ins)))}，两边必须相等`}
      </div>
    </section>
  );
}
