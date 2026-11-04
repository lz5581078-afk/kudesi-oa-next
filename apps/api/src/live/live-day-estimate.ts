import { EntityManager } from 'typeorm';
import { liveArchiveHourlyRate, liveComputeWage, livePlatformCommissions, liveRulesFromStored, liveVersionFor, type LiveRules } from '@kudesi/shared';
import { type LiveAccess, commissionOnlyControlIds } from './live-access';
import { primaryReport } from './live-checkin-core';
import { channelStores, channelsOf, linesOf } from './live-platforms';
import { type Row } from './live-core';

export interface Inputs {
  snapshots: Row[]; reports: Row[]; checkins: Row[]; profiles: Row[]; wages: Row[]; commissions: Row[];
  versions: Array<{id:number;effectiveFrom:string;rules:LiveRules}>; commissionOnly: Set<number>;
}
const amount = (v: unknown): number | null => v != null && Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : null;
const json = (v: unknown) => typeof v === 'string' ? JSON.parse(v) : v;

/** 投流是场次/平台的费用，不能累加各角色提成记录中的重复快照。 */
function sessionAdSpend(session:Row, reports:Row[], commissions:Row[]):number|null {
  if (session.status === 'approved' && commissions.length) {
    const platforms = new Map<string,number>();
    for (const row of commissions) {
      const cents = amount(row.ad_spend_cents), key = String(row.platform || '');
      if (cents === null || (platforms.has(key) && platforms.get(key) !== cents)) return null;
      platforms.set(key,cents);
    }
    return [...platforms.values()].reduce((n,cents)=>n+cents,0);
  }
  // 中控逐店填报时服务端已经校验总投流=逐店合计；只取这一份总额。
  return amount(reports.find(r=>r.role==='control')?.ad_spend_cents);
}

/** Read-only estimate; approved sessions use ledger amounts, never ledger + estimate. */
export function computeDayEstimate(sessions: Row[], now: string, input: Inputs, canViewCosts: boolean, anchorOnly = false) {
  sessions = sessions.filter(s => s.start_text <= now);
  let turnoverCents = 0, wageCents = 0, commissionCents = 0, adSpendCents = 0;
  const missingSales = new Set<number>(), missingCosts = new Set<number>(), missingAdSpend = new Set<number>();
  for (const s of sessions) {
    const id = Number(s.id), reports = input.reports.filter(r => Number(r.session_id) === id);
    const base = primaryReport(reports);
    const control = reports.find(r => r.role === 'control');
    const snapRow = input.snapshots.find(r => Number(r.session_id) === id);
    const snap = json(snapRow?.payload_json) as Row | undefined;
    // While broadcasting use only the shared live snapshot. Ended sessions can fall
    // back to the primary report; multiple roles' reports never add together.
    let sales: number | null = null;
    let lines: Array<{platform:string;salesCents:number;adSpendCents:number|null}> = [];
    if (s.status === 'approved' && amount(s.final_sales_cents) !== null) sales = amount(s.final_sales_cents);
    else if (snap?.available && amount(snap.turnoverCents) !== null) {
      sales = amount(snap.turnoverCents);
      const stores = Array.isArray(snap.stores) ? snap.stores : [];
      const seen = new Set<number>();
      for (const store of stores) {
        if (seen.has(Number(store.storeId))) continue;
        seen.add(Number(store.storeId));
        if (!store.available || amount(store.turnoverCents) === null) continue;
        const ad = control ? linesOf(control).find(l => l.storeId === Number(store.storeId))?.adSpendCents : null;
        lines.push({platform:store.platform || 'douyin',salesCents:Number(store.turnoverCents),adSpendCents:amount(ad)});
      }
      // Legacy single-platform snapshots may not contain a store breakdown.
      if (!lines.length && new Set(channelsOf(s).map(c => c.platform)).size <= 1) {
        lines = [{platform:channelsOf(s)[0]?.platform || 'douyin',salesCents:sales!,adSpendCents:amount(control?.ad_spend_cents)}];
      }
    } else if (s.status !== 'live' && base && amount(base.sales_cents) !== null) {
      sales = amount(base.sales_cents);
      const seen = new Set<number>();
      lines = linesOf(base).filter(l => {
        if (seen.has(l.storeId)) return false;
        seen.add(l.storeId); return true;
      }).map(l => ({platform:l.platform,salesCents:l.salesCents,adSpendCents:amount(control ? linesOf(control).find(c => c.storeId === l.storeId)?.adSpendCents : null)}));
      if (!lines.length && !channelStores(channelsOf(s)).length) lines = [{platform:'douyin',salesCents:sales!,adSpendCents:amount(control?.ad_spend_cents)}];
    }
    if (sales === null) missingSales.add(id); else turnoverCents += sales;
    if (!canViewCosts) continue;
    const ads = sessionAdSpend(s,reports,input.commissions.filter(r=>Number(r.session_id)===id));
    if (ads === null) missingAdSpend.add(id); else adSpendCents += ads;
    if (s.status === 'approved') {
      if (!anchorOnly) wageCents += input.wages.filter(r => Number(r.session_id) === id && ['anchor','control'].includes(r.role)).reduce((n,r) => n + Number(r.amount_cents),0);
      commissionCents += input.commissions.filter(r => Number(r.session_id) === id && (!anchorOnly || (r.role === 'anchor' && Number(r.user_id) === Number(s.anchor_user_id)))).reduce((n,r) => n + Number(r.amount_cents),0);
      continue;
    }
    if (!anchorOnly) for (const role of ['anchor','control'] as const) {
      const userId = Number(s[role + '_user_id']);
      if (!userId || (role === 'control' && input.commissionOnly.has(userId))) continue;
      const clock = input.checkins.find(c => Number(c.session_id) === id && c.role === role && Number(c.user_id) === userId);
      const report = reports.find(r => r.role === role);
      // Missing personal clock-ins have no reliable worked duration. Never turn a
      // scheduled assignment into earned wages. Manual HR reports retain legacy times.
      if (s.checkin_mode && !clock && !report?.manual_actor_id) { missingCosts.add(id); continue; }
      const start = clock?.start_text || s.start_text;
      const end = [clock?.end_text || report?.end_text, s.end_text, now].filter(Boolean).sort()[0];
      if (!start || start > end) { missingCosts.add(id); continue; }
      const minutes = Math.round((Date.parse(end.replace(' ','T') + '+08:00') - Date.parse(start.replace(' ','T') + '+08:00')) / 60000);
      if (minutes === 0) continue;
      const p = input.profiles.find(p => Number(p.id) === userId);
      const archiveRate = liveArchiveHourlyRate(p ? {payType:p.pay_type,hourlyRate:p.hourly_rate == null ? null : Number(p.hourly_rate)} : null);
      const rate = role === 'anchor' ? amount(s.scheduled_trial_rate) ?? (Number(s.trial_proxy) ? null : archiveRate) : archiveRate;
      if (rate === null || rate <= 0) { missingCosts.add(id); continue; }
      try { wageCents += liveComputeWage({startAt:start,endAt:end,hourlyRateCents:rate}).amountCents; }
      catch { missingCosts.add(id); }
    }
    const version = liveVersionFor(input.versions,s.session_day);
    if (sales === null || !version || !lines.length || lines.reduce((n,l)=>n+l.salesCents,0) !== sales) { missingCosts.add(id); continue; }
    try {
      for (const r of livePlatformCommissions(version.rules,lines)) {
        const attended = (role:'anchor'|'control') => !s.checkin_mode || input.checkins.some(c => Number(c.session_id) === id && c.role === role && Number(c.user_id) === Number(s[role+'_user_id'])) || reports.some(p => p.role === role && p.manual_actor_id);
        if (attended('anchor')) commissionCents += r.anchor.amountCents;
        if (!anchorOnly && s.control_user_id && attended('control')) commissionCents += r.control.amountCents;
        if (!anchorOnly && s.operator_user_id && Number(s.operator_user_id) !== Number(s.control_user_id)) commissionCents += r.operator.amountCents;
      }
    } catch { missingCosts.add(id); }
  }
  return { sessions:sessions.length,turnoverCents,missingSalesSessions:missingSales.size,
    adSpend:canViewCosts ? {totalCents:adSpendCents,missingSessions:missingAdSpend.size} : null,
    costs:canViewCosts ? {wageCents,commissionCents,totalCents:wageCents+commissionCents,missingSessions:missingCosts.size} : null };
}

/** Bounded by the selected company/day; no external order requests or per-session reads. */
export async function loadEstimateInputs(em:EntityManager,a:LiveAccess,sessions:Row[],now:string,anchorOnly=false):Promise<Inputs> {
  sessions = sessions.filter(s => s.start_text <= now);
  const input:Inputs={snapshots:[],reports:[],checkins:[],profiles:[],wages:[],commissions:[],versions:[],commissionOnly:new Set()};
  if (!sessions.length) return input;
  const ids=sessions.map(s=>Number(s.id));
  const read=(table:string,fields='*')=>em.query(`SELECT ${fields} FROM ${table} WHERE company_id=? AND session_id IN (?)`,[a.companyId,ids]) as Promise<Row[]>;
  [input.snapshots,input.reports]=await Promise.all([
    read('live_turnover_snapshots','session_id,payload_json'),
    read('live_session_reports',"*,DATE_FORMAT(end_at,'%Y-%m-%d %H:%i:%s') end_text"),
  ]);
  if (a.canViewAll) {
    const people=[...new Set(sessions.flatMap(s=>[s.anchor_user_id,s.control_user_id]).filter(Boolean).map(Number))];
    const [checkins,profiles,wages,commissions,versions,commissionOnly]=await Promise.all([
      read('live_session_checkins',"*,DATE_FORMAT(start_at,'%Y-%m-%d %H:%i:%s') start_text,DATE_FORMAT(end_at,'%Y-%m-%d %H:%i:%s') end_text"),
      anchorOnly ? Promise.resolve([]) : em.query('SELECT id,pay_type,hourly_rate FROM users WHERE company_id=? AND id IN (?)',[a.companyId,people]),
      anchorOnly ? Promise.resolve([]) : read('live_wage_records','session_id,role,amount_cents'),read('live_commission_records','session_id,user_id,role,platform,ad_spend_cents,amount_cents'),
      em.query("SELECT id,DATE_FORMAT(effective_from,'%Y-%m-%d') effective_from,rules_json FROM live_commission_rule_versions WHERE company_id=?",[a.companyId]),
      anchorOnly ? Promise.resolve(new Set<number>()) : commissionOnlyControlIds(em,a.companyId),
    ]);
    Object.assign(input,{checkins,profiles,wages,commissions,commissionOnly,versions:versions.map((v:Row)=>({id:Number(v.id),effectiveFrom:v.effective_from,rules:liveRulesFromStored(v.rules_json)}))});
  }
  if (anchorOnly && !a.canViewAll) input.checkins = await read('live_session_checkins',"*,DATE_FORMAT(start_at,'%Y-%m-%d %H:%i:%s') start_text,DATE_FORMAT(end_at,'%Y-%m-%d %H:%i:%s') end_text");
  return input;
}

export async function dayEstimate(em:EntityManager,a:LiveAccess,sessions:Row[],now:string) {
  return computeDayEstimate(sessions,now,await loadEstimateInputs(em,a,sessions,now),a.canViewAll);
}
