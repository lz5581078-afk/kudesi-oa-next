import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import type { LedgerGroup, LedgerPhoneRow, LedgerSort } from '@kudesi/shared';
import { MainCardPick } from './pickers';
import { PHONE_CYCLE_LABEL, USER_KIND_LABEL, rechargeText, shortDate, yuan } from './format';

export interface PhoneActions {
  canEdit: boolean;
  canSeeFees: boolean;
  checked: Map<number, LedgerPhoneRow>;
  onCheck: (row: LedgerPhoneRow, on: boolean) => void;
  onEdit: (row: LedgerPhoneRow) => void;
  onRecharge: (row: LedgerPhoneRow) => void;
  onBind: (row: LedgerPhoneRow, parentId: number) => Promise<void>;
}

const Due = ({ row }: { row: LedgerPhoneRow }) => {
  const t = rechargeText(row.state, row.daysLeft);
  return (
    <span className="fee-due">
      <span className="fee-date">{row.nextRechargeAt ? row.nextRechargeAt.slice(5) : '—'}</span>
      <span className={`fee-flag ${t.tone}`}>{t.text}</span>
    </span>
  );
};

const Who = ({ row }: { row: LedgerPhoneRow }) => (row.user ? <span title={row.userKind ? USER_KIND_LABEL[row.userKind] : undefined}>{row.user}<em className="fee-kind">{row.userKind ? USER_KIND_LABEL[row.userKind] : ''}</em></span> : <span className="muted">—</span>);

const PhoneLink = ({ row }: { row: LedgerPhoneRow }) => (
  <Link className="fee-num" to={`/resource/phones?open=${row.id}`} title="打开手机号档案">{row.number}</Link>
);

function Fee({ row, canSeeFees }: { row: LedgerPhoneRow; canSeeFees: boolean }) {
  if (!canSeeFees) return <span className="muted">无权限</span>;
  if (!(typeof row.feeCents === 'number' && row.feeCents > 0)) return <span className="fee-flag warn">未设费用</span>;
  return (
    <span className="fee-money">
      <b>{yuan(row.feeCents)}</b>
      {row.feeCycle !== 'monthly' && <em>折合 {yuan(row.monthlyCents)}/月</em>}
    </span>
  );
}

function RowActions({ row, a }: { row: LedgerPhoneRow; a: PhoneActions }) {
  if (!a.canEdit) return null;
  return (
    <span className="fee-actions">
      <button type="button" className="res-btn sm" onClick={() => a.onEdit(row)} aria-label={`修改 ${row.number}`}>修改</button>
      <button type="button" className="res-btn sm" onClick={() => a.onRecharge(row)} aria-label={`记录充值 ${row.number}`} title="最后充值日记为今天，下次充值日按周期自动推算">记录充值</button>
    </span>
  );
}

function Cells({ row, a, role }: { row: LedgerPhoneRow; a: PhoneActions; role: 'main' | 'sub' | 'flat' }) {
  return (
    <>
      <td className="c-check"><input type="checkbox" aria-label={`勾选 ${row.number}`} checked={a.checked.has(row.id)} onChange={(e) => a.onCheck(row, e.target.checked)} /></td>
      <td className="c-num">
        <PhoneLink row={row} />
        {role === 'flat' && (row.kind === 'main' ? <span className="fee-tag main">主卡</span> : <span className="fee-tag sub">子卡{row.parentNumber ? ` · ${row.parentNumber}` : ''}</span>)}
        {role === 'main' && <span className="fee-tag main">主卡</span>}
        {role === 'sub' && <span className="fee-tag sub">子卡</span>}
        {row.broadband.map((b) => <Link key={b.id} className="fee-tag bb" to={`/resource/broadband?open=${b.id}`} title="这个号码绑定的宽带">宽带 {b.account}</Link>)}
      </td>
      <td className="c-plan"><span>{row.carrier ?? '—'}</span><em className="muted"> {row.plan ?? ''}</em></td>
      <td className="c-fee"><Fee row={row} canSeeFees={a.canSeeFees} /></td>
      <td>{PHONE_CYCLE_LABEL[row.feeCycle] ?? row.feeCycle}</td>
      <td className="c-cycle">{row.cycleDays ? `${row.cycleDays} 天` : '—'}{row.rechargeDay ? <em className="muted"> · 固定{row.rechargeDay}日</em> : null}</td>
      <td className="c-due"><Due row={row} /></td>
      <td className="c-who"><Who row={row} /></td>
      <td className="c-ops"><RowActions row={row} a={a} /></td>
    </>
  );
}

const HEAD = ['', '号码', '运营商 · 套餐', '费用', '周期', '充值周期', '下次充值', '使用人', ''];

/** 按主卡：每张主卡一行，可展开看全部子卡和小计；没有子卡的主卡也在这里；底部是孤立子卡 */
export function MainCardView({ groups, orphans, a, expanded, onToggle, onBindOrphan }: {
  groups: LedgerGroup[]; orphans: LedgerPhoneRow[]; a: PhoneActions; expanded: Set<number>; onToggle: (id: number) => void; onBindOrphan: PhoneActions['onBind'];
}) {
  return (
    <>
      <table className="fee-table" aria-label="按主卡">
        <thead><tr>{HEAD.map((h, i) => <th key={i} scope="col">{h}</th>)}</tr></thead>
        {groups.map((g) => {
          const open = expanded.has(g.main.id);
          const subs = g.children.length;
          return (
            <tbody key={g.main.id} className={open ? 'fee-family open' : 'fee-family'}>
              <tr className="fee-main">
                <Cells row={g.main} a={a} role="main" />
              </tr>
              <tr className="fee-fold">
                <td />
                <td colSpan={8}>
                  {subs > 0 ? (
                    <button type="button" className="fee-fold-btn" aria-expanded={open} aria-label={`${g.main.number} 的子卡`} onClick={() => onToggle(g.main.id)}>
                      <span aria-hidden="true">{open ? '▾' : '▸'}</span> {subs} 张子卡
                      {a.canSeeFees && <em>主子合计折合 {yuan(g.monthlyCents)}/月{g.unpriced ? `（${g.unpriced} 张未设费用）` : ''}</em>}
                    </button>
                  ) : <span className="muted">无子卡</span>}
                </td>
              </tr>
              {open && g.children.map((c) => (
                <tr key={c.id} className="fee-sub"><Cells row={c} a={a} role="sub" /></tr>
              ))}
              {open && a.canSeeFees && subs > 0 && (
                <tr className="fee-subtotal">
                  <td /><td colSpan={8}>小计：主卡 + {subs} 张子卡，折合月均 <b>{yuan(g.monthlyCents)}</b>{g.unpriced ? <span className="fee-flag warn">{g.unpriced} 张未设费用</span> : null}</td>
                </tr>
              )}
            </tbody>
          );
        })}
        {groups.length === 0 && <tbody><tr><td colSpan={9} className="fee-empty">没有符合条件的号码。</td></tr></tbody>}
      </table>
      {orphans.length > 0 && (
        <section className="fee-orphans" aria-label="孤立子卡">
          <h3>孤立子卡 · {orphans.length}</h3>
          <p>这些号码标成了子卡，但没挂在正常的主卡下（主卡不存在、已停用，或主卡本身又是子卡）。就地补绑主卡：</p>
          <ul>
            {orphans.map((o) => <OrphanRow key={o.id} row={o} canEdit={a.canEdit} onBind={onBindOrphan} />)}
          </ul>
        </section>
      )}
    </>
  );
}

function OrphanRow({ row, canEdit, onBind }: { row: LedgerPhoneRow; canEdit: boolean; onBind: PhoneActions['onBind'] }) {
  const [pick, setPick] = useState<{ id: number | null; label: string }>({ id: null, label: '' });
  const [busy, setBusy] = useState(false);
  return (
    <li>
      <span><PhoneLink row={row} /><em className="muted"> 原主卡：{row.parentNumber ?? '已不存在'}</em></span>
      {canEdit && (
        <span className="fee-orphan-bind">
          <MainCardPick value={pick.id} label={pick.label} excludeId={row.id} onChange={(id, label) => setPick({ id, label })} />
          <button type="button" className="res-btn sm" disabled={pick.id === null || busy} aria-label={`绑定主卡 ${row.number}`} onClick={async () => { setBusy(true); try { await onBind(row, pick.id!); } finally { setBusy(false); } }}>绑定主卡</button>
        </span>
      )}
    </li>
  );
}

const SORTABLE: Array<{ key: LedgerSort | null; label: string }> = [
  { key: null, label: '' }, { key: 'number', label: '号码' }, { key: 'carrier', label: '运营商 · 套餐' }, { key: 'monthly', label: '费用' },
  { key: null, label: '周期' }, { key: null, label: '充值周期' }, { key: 'next', label: '下次充值' }, { key: null, label: '使用人' }, { key: null, label: '' },
];

/** 全部号码：平铺，可按号码/运营商/费用/下次充值日排序 */
export function AllNumbersView({ rows, a, sort, dir, onSort }: { rows: LedgerPhoneRow[]; a: PhoneActions; sort: LedgerSort; dir: 'asc' | 'desc'; onSort: (k: LedgerSort) => void }) {
  return (
    <table className="fee-table" aria-label="全部号码">
      <thead>
        <tr>
          {SORTABLE.map((h, i) => (
            <th key={i} scope="col" aria-sort={h.key && h.key === sort ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
              {h.key ? <button type="button" className="fee-sort" onClick={() => onSort(h.key!)}>{h.label}{h.key === sort ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}</button> : h.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <Fragment key={r.id}><tr className={r.state === 'overdue' ? 'fee-flat overdue' : 'fee-flat'}><Cells row={r} a={a} role="flat" /></tr></Fragment>
        ))}
        {rows.length === 0 && <tr><td colSpan={9} className="fee-empty">没有符合条件的号码。</td></tr>}
      </tbody>
    </table>
  );
}
