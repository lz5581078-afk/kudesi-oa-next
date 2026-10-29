import { Link } from 'react-router-dom';
import type { LedgerBroadbandRow, LedgerSort } from '@kudesi/shared';
import { BB_CYCLE_LABEL, expiryText, yuan } from './format';

export interface BroadbandActions {
  canEdit: boolean;
  canSeeFees: boolean;
  checked: Map<number, LedgerBroadbandRow>;
  onCheck: (row: LedgerBroadbandRow, on: boolean) => void;
  onEdit: (row: LedgerBroadbandRow) => void;
}

/** 宽带费用：单独一张表，不混进手机费用；没绑手机号的标红，没指定区域的标出 */
export function BroadbandView({ rows, a, sort, dir, onSort }: { rows: LedgerBroadbandRow[]; a: BroadbandActions; sort: LedgerSort; dir: 'asc' | 'desc'; onSort: (k: LedgerSort) => void }) {
  const head = (key: LedgerSort | null, label: string) => (
    <th scope="col" aria-sort={key && key === sort ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      {key ? <button type="button" className="fee-sort" onClick={() => onSort(key)}>{label}{key === sort ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}</button> : label}
    </th>
  );
  return (
    <table className="fee-table fee-t-bb" aria-label="宽带费用">
      <thead>
        <tr>
          <th scope="col" />
          {head('number', '宽带账号')}{head('carrier', '使用区域')}{head(null, '带宽')}{head(null, '周期')}{head('monthly', '金额')}{head('next', '到期日')}{head(null, '绑定手机号')}<th scope="col" />
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const ex = expiryText(r.state, r.daysLeft);
          const unbound = r.phoneId === null || r.phoneNumber === null;
          return (
            <tr key={r.id} className={unbound ? 'fee-flat unbound' : 'fee-flat'}>
              <td className="c-check"><input type="checkbox" aria-label={`勾选 ${r.account}`} checked={a.checked.has(r.id)} onChange={(e) => a.onCheck(r, e.target.checked)} /></td>
              <td className="c-num"><Link className="fee-num" to={`/resource/broadband?open=${r.id}`} title="打开宽带档案">{r.account}</Link>{r.status === 'suspended' && <span className="fee-tag sub">停机</span>}</td>
              <td className="c-area">{r.location ? <span title={r.location}>{r.location}</span> : <span className="fee-flag warn">未指定区域</span>}</td>
              <td>{r.bandwidth ?? '—'}</td>
              <td>{BB_CYCLE_LABEL[r.cycle] ?? r.cycle}</td>
              <td className="c-fee">
                {!a.canSeeFees ? <span className="muted">无权限</span> : typeof r.amountCents === 'number' && r.amountCents > 0 ? (
                  <span className="fee-money"><b>{yuan(r.amountCents)}</b>{r.cycle !== 'monthly' && <em>折合 {yuan(r.monthlyCents)}/月</em>}</span>
                ) : <span className="fee-flag warn">未设费用</span>}
              </td>
              <td className="c-due"><span className="fee-due"><span className="fee-date">{r.expiresAt ?? '—'}</span><span className={`fee-flag ${ex.tone}`}>{ex.text}</span></span></td>
              <td className="c-bind">
                {unbound
                  ? <span className="fee-flag bad">未绑定手机号</span>
                  : <Link className="fee-num" to={`/resource/phones?open=${r.phoneId}`} title="打开手机号详情">{r.phoneNumber}</Link>}
              </td>
              <td className="c-ops">
                <span className="fee-actions">
                  {a.canEdit && <button type="button" className="res-btn sm" onClick={() => a.onEdit(r)} aria-label={unbound ? `绑定手机号 ${r.account}` : `修改 ${r.account}`}>{unbound ? '绑定手机号' : '修改'}</button>}
                  <Link className="res-btn sm" to={`/resource/broadband?open=${r.id}`}>打开宽带档案</Link>
                </span>
              </td>
            </tr>
          );
        })}
        {rows.length === 0 && <tr><td colSpan={9} className="fee-empty">没有符合条件的宽带。</td></tr>}
      </tbody>
    </table>
  );
}
