import {DOC_LINE_ITEM_NAME_MAX_LENGTH} from '@kudesi/shared';
import { gridKeyDown } from './gridNav';
import { emptyMoney, MONEY_SUGGEST, type MoneyLine } from './types';
import {money} from '../common';

/** 金额类单据（收款/付款/预收/预付/转款）的多行金额明细：项目 + 金额 + 备注 */
export function MoneyGrid({ type, label, lines, setLines, gridRef,source=false,totalCents=0,totalLabel }: { type: string; label: string; lines: MoneyLine[]; setLines: (f: (ls: MoneyLine[]) => MoneyLine[]) => void; gridRef?: React.Ref<HTMLDivElement>;source?:boolean;totalCents?:number;totalLabel?:string }) {
  const set = (i: number, patch: Partial<MoneyLine>) => setLines((ls) => ls.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const del = (i: number) => setLines((ls) => (ls.length <= 1 ? [emptyMoney()] : ls.filter((_, k) => k !== i)));
  return (
    <div className={`table-scroll vc-grid${source?' reference-voucher-lines reference-voucher-money-lines':''}`} ref={gridRef} onKeyDown={(e) => gridKeyDown(e, { addRow: () => setLines((ls) => [...ls, emptyMoney()]), deleteRow: del })}>
      <table className="data-table doc-lines money-lines">
        <thead><tr>{!source&&<th>#</th>}<th>{label}{source?'':' *'}</th><th>{source?'金额':'金额（元）*'}</th><th>备注</th><th>{source?'操作':''}</th></tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i} data-row={i}>
              {!source&&<td data-cell="#" className="vc-no">{i + 1}</td>}
              <td data-cell={label}><input aria-label={`第${i + 1}行${label}`} list={source?undefined:`money-items-${type}`} autoComplete="off" maxLength={DOC_LINE_ITEM_NAME_MAX_LENGTH} value={l.item} onChange={(e) => set(i, { item: e.target.value })} placeholder={label} /></td>
              <td data-cell="金额（元）"><input type={source?'number':'text'} min={source?'0':undefined} step={source?'0.01':undefined} inputMode="decimal" aria-label={`第${i + 1}行金额`} value={l.amount} onChange={(e) => set(i, { amount: e.target.value })} placeholder="0.00" /></td>
              <td data-cell="备注"><input aria-label={`第${i + 1}行备注`} maxLength={200} value={l.memo} onChange={(e) => set(i, { memo: e.target.value })} placeholder="备注" /></td>
              <td><button type="button" className={source?'reference-voucher-delete':'link-button'} aria-label={`删除第${i + 1}行`} onClick={() => del(i)}>{source?'删':lines.length <= 1 ? '清空' : '删除'}</button></td>
            </tr>
          ))}
        </tbody>
        {source&&<tfoot><tr><td colSpan={4}><strong>{totalLabel}</strong><b>{money(totalCents)}</b></td></tr></tfoot>}
      </table>
      {!source&&MONEY_SUGGEST[type] && <datalist id={`money-items-${type}`}>{MONEY_SUGGEST[type].map((t) => <option key={t} value={t} />)}</datalist>}
    </div>
  );
}
