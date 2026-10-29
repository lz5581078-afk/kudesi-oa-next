import { SETTLE_BY_LABEL, type SettleBy } from '@kudesi/shared';
import { money } from '../common';
import type { OpenItem } from '../financeApi';

/** 收款单/付款单的结算方式：按金额、按单据、按商品（管家婆三种结算），后两种要分配到具体单据 */
export function SettleBySection(p: {
  type: string; settleBy: SettleBy; setSettleBy: (m: SettleBy) => void; hasParty: boolean; open: OpenItem[];
  alloc: Record<string, string>; setAlloc: (f: (a: Record<string, string>) => Record<string, string>) => void; clearAlloc: () => void;
  allocated: number; settleTotal: number; autoAlloc: () => void;
}) {
  const { type, settleBy, open, alloc, setAlloc } = p;
  return (
    <div className="settle-by">
      <div className="pay-modes" role="group" aria-label="结算方式选择">
        {(['amount', 'doc', 'product'] as SettleBy[]).map((m) => <button key={m} type="button" className={`mode-button${settleBy === m ? ' active' : ''}`} aria-pressed={settleBy === m} onClick={() => { p.setSettleBy(m); p.clearAlloc(); }}>{SETTLE_BY_LABEL[m]}</button>)}
      </div>
      {settleBy === 'amount' && <p className="muted">按金额结算：直接冲减这个往来对象的{type === 'receipt' ? '应收' : '应付'}余额，不指定单据。</p>}
      {settleBy !== 'amount' && (
        <>
          {!p.hasParty && <p className="muted">先选往来对象，才能列出他名下没结算完的单据。</p>}
          {p.hasParty && open.length === 0 && <p className="muted">这个往来对象名下没有需要结算的单据。</p>}
          {open.length > 0 && (
            <div className="table-scroll"><table className="data-table" aria-label="结算单据">
              <thead><tr><th>单据</th><th>日期</th>{settleBy === 'product' && <th>商品</th>}<th className="num">单据金额</th><th className="num">未结算</th><th className="num">本次结算（元）</th></tr></thead>
              <tbody>
                {open.flatMap((it) => settleBy === 'doc'
                  ? [<tr key={it.id}><td className="mono">{it.docNo} <span className="muted">{it.typeLabel}</span></td><td>{it.docDate}</td><td className="num">{money(it.amountCents)}</td><td className="num">{money(it.outstandingCents)}</td>
                      <td><input inputMode="decimal" aria-label={`结算 ${it.docNo}`} value={alloc[`${it.id}`] ?? ''} onChange={(e) => setAlloc((a) => ({ ...a, [`${it.id}`]: e.target.value }))} /></td></tr>]
                  : it.products.map((pr, i) => <tr key={`${it.id}:${pr.productId}`}><td className="mono">{i === 0 ? <>{it.docNo} <span className="muted">{it.typeLabel}</span></> : ''}</td><td>{i === 0 ? it.docDate : ''}</td><td>{pr.productName}</td><td className="num">{money(pr.amountCents)}</td><td className="num">{money(pr.outstandingCents)}</td>
                      <td><input inputMode="decimal" aria-label={`结算 ${it.docNo} ${pr.productName}`} value={alloc[`${it.id}:${pr.productId}`] ?? ''} onChange={(e) => setAlloc((a) => ({ ...a, [`${it.id}:${pr.productId}`]: e.target.value }))} /></td></tr>))}
              </tbody>
            </table></div>
          )}
          <div className="between">
            <span className={p.allocated === p.settleTotal && p.settleTotal > 0 ? 'ok-text' : 'bad-text'}>已分配 {money(p.allocated)} / 本次结算金额 {money(p.settleTotal)}（收付款金额加冲抵）</span>
            <button type="button" className="secondary-button small" onClick={p.autoAlloc} disabled={!open.length || p.settleTotal <= 0}>按业务发生先后自动分配</button>
          </div>
        </>
      )}
    </div>
  );
}
