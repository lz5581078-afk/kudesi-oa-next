import type { LedgerFocus, LedgerSummary, LedgerView } from '@kudesi/shared';
import { yuan } from './format';

export interface Pick { view: LedgerView; focus: LedgerFocus | '' }

interface Cell { key: string; label: string; value: string; sub?: string; tone?: 'bad' | 'warn'; target?: Pick; active?: boolean; hidden?: boolean }

/** 顶部一行汇总：每格可点，点了就把下面的列表切到对应的范围 */
export function SummaryBar({ s, canSeeFees, current, onPick }: { s: LedgerSummary; canSeeFees: boolean; current: Pick; onPick: (p: Pick) => void }) {
  const is = (view: LedgerView, focus: LedgerFocus | '') => current.view === view && current.focus === focus;
  const bbExpire = (s.broadbandExpiringCount ?? 0) + (s.broadbandExpiredCount ?? 0);
  const tidy = s.orphanCount + (s.broadbandUnboundCount ?? 0);
  const cells: Cell[] = [
    { key: 'money', label: '月均通信费', value: yuan(s.monthlyCents), sub: s.broadbandMonthlyCents !== undefined ? `手机 ${yuan(s.phoneMonthlyCents)} · 宽带 ${yuan(s.broadbandMonthlyCents)}` : s.phoneMonthlyCents !== undefined ? `手机 ${yuan(s.phoneMonthlyCents)}` : undefined, hidden: !canSeeFees, target: { view: 'main', focus: '' }, active: false },
    { key: 'main', label: '主卡', value: String(s.mainCount), sub: `子卡 ${s.subCount} 张`, target: { view: 'all', focus: 'main' }, active: is('all', 'main') },
    { key: 'soon', label: '7 天内要充', value: String(s.soonCount), tone: s.soonCount ? 'warn' : undefined, target: { view: 'all', focus: 'soon' }, active: is('all', 'soon') },
    { key: 'overdue', label: '已逾期未充', value: String(s.overdueCount), tone: s.overdueCount ? 'bad' : undefined, target: { view: 'all', focus: 'overdue' }, active: is('all', 'overdue') },
    { key: 'bb', label: '宽带 30 天内到期', value: s.broadbandCount === null ? '—' : String(bbExpire), sub: s.broadbandCount === null ? '无宽带查看权限' : s.broadbandExpiredCount ? `其中已到期 ${s.broadbandExpiredCount}` : `共 ${s.broadbandCount} 条宽带`, tone: bbExpire ? 'warn' : undefined, hidden: s.broadbandCount === null, target: { view: 'broadband', focus: s.broadbandExpiredCount && !s.broadbandExpiringCount ? 'expired' : 'expiring' }, active: current.view === 'broadband' && (current.focus === 'expiring' || current.focus === 'expired') },
    { key: 'nofee', label: '未设费用', value: String(s.noFeeCount), sub: '号码', tone: s.noFeeCount ? 'warn' : undefined, hidden: !canSeeFees, target: { view: 'all', focus: 'nofee' }, active: is('all', 'nofee') },
    { key: 'tidy', label: '待整理', value: String(tidy), sub: `孤立子卡 ${s.orphanCount} · 宽带未绑号 ${s.broadbandUnboundCount ?? 0}`, tone: tidy ? 'bad' : undefined, target: s.orphanCount || s.broadbandUnboundCount === null ? { view: 'main', focus: '' } : { view: 'broadband', focus: 'unbound' }, active: false },
  ];
  return (
    <div className="fee-sum" role="group" aria-label="费用汇总">
      {cells.filter((c) => !c.hidden).map((c) => (
        <button key={c.key} type="button" className={`fee-sum-cell${c.tone ? ` ${c.tone}` : ''}${c.active ? ' on' : ''}`} aria-pressed={c.active} onClick={() => c.target && onPick(c.target)}>
          <span className="fee-sum-label">{c.label}</span>
          <strong className="fee-sum-value">{c.value}</strong>
          {c.sub && <span className="fee-sum-sub">{c.sub}</span>}
        </button>
      ))}
    </div>
  );
}
