import { gridKeyDown } from './gridNav';
import { emptyMoney, MONEY_SUGGEST, type MoneyLine } from './types';

/** 金额类单据（收款/付款/预收/预付/转款）的多行金额明细：项目 + 金额 + 备注 */
export function MoneyGrid({ type, label, lines, setLines, gridRef }: { type: string; label: string; lines: MoneyLine[]; setLines: (f: (ls: MoneyLine[]) => MoneyLine[]) => void; gridRef?: React.Ref<HTMLDivElement> }) {
  const set = (i: number, patch: Partial<MoneyLine>) => setLines((ls) => ls.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const del = (i: number) => setLines((ls) => (ls.length <= 1 ? [emptyMoney()] : ls.filter((_, k) => k !== i)));
  return (
    <div className="table-scroll vc-grid" ref={gridRef} onKeyDown={(e) => gridKeyDown(e, { addRow: () => setLines((ls) => [...ls, emptyMoney()]), deleteRow: del })}>
      <table className="data-table doc-lines money-lines">
        <thead><tr><th>#</th><th>{label} *</th><th>金额（元）*</th><th>备注</th><th /></tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i} data-row={i}>
              <td data-cell="#" className="vc-no">{i + 1}</td>
              <td data-cell={label}><input aria-label={`第${i + 1}行${label}`} list={`money-items-${type}`} autoComplete="off" maxLength={100} value={l.item} onChange={(e) => set(i, { item: e.target.value })} placeholder={label} /></td>
              <td data-cell="金额（元）"><input inputMode="decimal" aria-label={`第${i + 1}行金额`} value={l.amount} onChange={(e) => set(i, { amount: e.target.value })} placeholder="0.00" /></td>
              <td data-cell="备注"><input aria-label={`第${i + 1}行备注`} maxLength={200} value={l.memo} onChange={(e) => set(i, { memo: e.target.value })} placeholder="备注" /></td>
              <td><button type="button" className="link-button" aria-label={`删除第${i + 1}行`} onClick={() => del(i)}>{lines.length <= 1 ? '清空' : '删除'}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {MONEY_SUGGEST[type] && <datalist id={`money-items-${type}`}>{MONEY_SUGGEST[type].map((t) => <option key={t} value={t} />)}</datalist>}
    </div>
  );
}
