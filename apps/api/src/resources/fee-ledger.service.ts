import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  broadbandExpiry,
  createChecker,
  getResourceDef,
  monthlyEquivalentCents,
  nextRechargeDate,
  rechargeState,
  resourcePermission,
  restrictedFieldKeys,
  todayShanghai,
  type LedgerBroadbandRow,
  type LedgerFocus,
  type LedgerGroup,
  type LedgerPhoneRow,
  type LedgerResult,
  type LedgerSort,
  type LedgerSummary,
  type LedgerView,
} from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { ResourceRecord, User } from '../entities';
import { recordVersion } from './resources.service';

export interface LedgerQuery {
  view: LedgerView;
  q?: string;
  focus?: LedgerFocus;
  carrier?: string;
  user?: string;
  /** 宽带页签：按使用区域筛选（区域位置 id，包含它的下级区域） */
  location?: number;
  sort?: LedgerSort;
  dir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * 通信费用台账：只读聚合。数据不另存——手机号费用取自手机号资料，宽带费用取自宽带资料；
 * 公司只取自令牌，费用字段按字段权限在服务端去掉。写入由页面走资料的保存通道（带版本、审计）。
 * 手机号一般几百条，按公司整批读出后在内存里聚合、筛选、分页（与手机号派生信息的做法一致）。
 */
@Injectable()
export class FeeLedgerService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async ledger(user: AuthUser, q: LedgerQuery): Promise<LedgerResult> {
    const can = createChecker(user.permissions);
    const phoneDef = getResourceDef('phones')!;
    const bbDef = getResourceDef('broadband')!;
    const canSeeBroadband = can(resourcePermission('broadband', 'view'));
    const canSeeFees = !restrictedFieldKeys(phoneDef, can).has('monthlyFee');
    const canSeeBbFees = !restrictedFieldKeys(bbDef, can).has('amount');
    if (q.view === 'broadband' && !canSeeBroadband) throw new BadRequestException('没有查看宽带账号的权限');
    const today = todayShanghai();
    const em = this.ds.manager;
    const companyId = user.companyId;

    const [phoneRecords, bbRecords, locRecords] = await Promise.all([
      em.find(ResourceRecord, { where: { companyId, type: 'phones' } }),
      canSeeBroadband ? em.find(ResourceRecord, { where: { companyId, type: 'broadband' } }) : Promise.resolve([] as ResourceRecord[]),
      canSeeBroadband ? em.find(ResourceRecord, { where: { companyId, type: 'locations' }, select: ['id', 'title', 'data'] }) : Promise.resolve([] as ResourceRecord[]),
    ]);
    const userIds = new Set<number>();
    const partnerIds = new Set<number>();
    for (const r of phoneRecords) {
      for (const k of ['userId', 'keeperUserId']) { const n = num(r.data[k]); if (n) userIds.add(n); }
      const p = num(r.data.partnerId); if (p) partnerIds.add(p);
    }
    const userNames = new Map<number, string>();
    if (userIds.size) (await em.createQueryBuilder(User, 'u').select(['u.id', 'u.name']).where('u.companyId = :companyId AND u.id IN (:...ids)', { companyId, ids: [...userIds] }).getMany()).forEach((u) => userNames.set(u.id, u.name));
    const partnerNames = new Map<number, string>();
    if (partnerIds.size) (await em.createQueryBuilder(ResourceRecord, 'r').select(['r.id', 'r.title']).where('r.companyId = :companyId AND r.type = :t AND r.id IN (:...ids)', { companyId, t: 'partners', ids: [...partnerIds] }).getMany()).forEach((r) => partnerNames.set(r.id, r.title));

    const live = phoneRecords.filter((r) => !r.archivedAt && r.status !== 'inactive');
    const byId = new Map(phoneRecords.filter((r) => !r.archivedAt).map((r) => [r.id, r]));
    const childrenOf = new Map<number, ResourceRecord[]>();
    const orphanRecs: ResourceRecord[] = [];
    for (const r of live) {
      const pid = num(r.data.parentPhoneId);
      if (pid === null) continue;
      const parent = byId.get(pid);
      // 孤立子卡：主卡不存在/已归档/已停用，或者“主卡”本身又是子卡（超过两级）
      if (!parent || parent.status === 'inactive' || num(parent.data.parentPhoneId) !== null) orphanRecs.push(r);
      else childrenOf.set(pid, [...(childrenOf.get(pid) ?? []), r]);
    }

    const bbByPhone = new Map<number, Array<{ id: number; account: string }>>();
    const bbLive = bbRecords.filter((r) => !r.archivedAt && r.status !== 'cancelled');
    for (const b of bbLive) {
      const pid = num(b.data.phoneId);
      if (pid !== null) bbByPhone.set(pid, [...(bbByPhone.get(pid) ?? []), { id: b.id, account: b.title }]);
    }

    const toRow = (r: ResourceRecord): LedgerPhoneRow => {
      const parentId = num(r.data.parentPhoneId);
      const fee = num(r.data.monthlyFee);
      const feeCycle = str(r.data.feeCycle) ?? 'monthly';
      const next = nextRechargeDate({ lastRechargeAt: r.data.lastRechargeAt, rechargeCycleDays: r.data.rechargeCycleDays, nextRechargeAt: r.data.nextRechargeAt });
      const st = rechargeState(next, today);
      const kind = str(r.data.usageType);
      let who: string | null = null;
      let userKind: LedgerPhoneRow['userKind'] = null;
      if (kind === 'personal_used' && num(r.data.userId)) { who = userNames.get(num(r.data.userId)!) ?? null; userKind = 'use'; }
      else if (kind === 'external_used' && str(r.data.externalUser)) { who = str(r.data.externalUser); userKind = 'external'; }
      else if (kind === 'partner_used' && num(r.data.partnerId)) { who = partnerNames.get(num(r.data.partnerId)!) ?? null; userKind = 'partner'; }
      if (!who) {
        const keeper = num(r.data.keeperUserId) ? userNames.get(num(r.data.keeperUserId)!) ?? null : str(r.data.keeperName);
        if (keeper) { who = keeper; userKind = 'keeper'; }
      }
      const row: LedgerPhoneRow = {
        id: r.id,
        version: recordVersion(r),
        number: r.title,
        status: r.status,
        carrier: str(r.data.carrier),
        plan: str(r.data.plan),
        kind: parentId === null ? 'main' : 'sub',
        parentId,
        parentNumber: parentId !== null ? byId.get(parentId)?.title ?? null : null,
        feeCycle,
        cycleDays: num(r.data.rechargeCycleDays),
        rechargeDay: str(r.data.rechargeDay),
        lastRechargeAt: str(r.data.lastRechargeAt),
        nextRechargeAt: next,
        state: st.state,
        daysLeft: st.days,
        user: who,
        userKind,
        childCount: childrenOf.get(r.id)?.length ?? 0,
        broadband: bbByPhone.get(r.id) ?? [],
      };
      if (canSeeFees) { row.feeCents = fee; row.monthlyCents = monthlyEquivalentCents(fee, feeCycle); }
      return row;
    };

    const rows = live.map(toRow);
    const rowById = new Map(rows.map((r) => [r.id, r]));
    const orphanIds = new Set(orphanRecs.map((r) => r.id));
    const mains = rows.filter((r) => r.kind === 'main');
    const noFee = (r: LedgerPhoneRow) => canSeeFees && !(typeof r.feeCents === 'number' && r.feeCents > 0);

    // 位置路径（宽带使用区域：办公楼 / 楼层 / 房间）
    const locById = new Map(locRecords.map((l) => [l.id, l]));
    const pathOf = (id: number): string => {
      const parts: string[] = [];
      const seen = new Set<number>();
      for (let cur = locById.get(id); cur && !seen.has(cur.id); cur = num(cur.data.parentId) ? locById.get(num(cur.data.parentId)!) : undefined) { seen.add(cur.id); parts.unshift(cur.title); }
      return parts.join(' / ');
    };
    const underLocation = (id: number, root: number): boolean => {
      const seen = new Set<number>();
      for (let cur: number | null = id; cur !== null && !seen.has(cur); cur = num(locById.get(cur)?.data.parentId)) { if (cur === root) return true; seen.add(cur); }
      return false;
    };
    const bbRows: LedgerBroadbandRow[] = bbLive.map((b) => {
      const amount = num(b.data.amount);
      const cycle = str(b.data.cycle) ?? 'monthly';
      const ex = broadbandExpiry(str(b.data.expiresAt), today);
      const pid = num(b.data.phoneId);
      const lid = num(b.data.locationId);
      const row: LedgerBroadbandRow = {
        id: b.id,
        version: recordVersion(b),
        account: b.title,
        status: b.status,
        locationId: lid,
        location: lid ? pathOf(lid) || str(b.data.locationNote) : str(b.data.locationNote),
        bandwidth: str(b.data.bandwidth),
        cycle,
        expiresAt: str(b.data.expiresAt),
        state: ex.state,
        daysLeft: ex.days,
        phoneId: pid,
        phoneNumber: pid !== null ? byId.get(pid)?.title ?? null : null,
      };
      if (canSeeBbFees) { row.amountCents = amount; row.monthlyCents = monthlyEquivalentCents(amount, cycle); }
      return row;
    });

    const sumMonthly = (list: Array<{ monthlyCents?: number | null }>) => list.reduce((s, r) => s + (r.monthlyCents ?? 0), 0);
    const summary: LedgerSummary = {
      mainCount: mains.length,
      subCount: rows.length - mains.length,
      soonCount: rows.filter((r) => r.state === 'soon').length,
      overdueCount: rows.filter((r) => r.state === 'overdue').length,
      noFeeCount: canSeeFees ? rows.filter(noFee).length : 0,
      orphanCount: orphanRecs.length,
      broadbandCount: canSeeBroadband ? bbRows.length : null,
      broadbandExpiringCount: canSeeBroadband ? bbRows.filter((b) => b.state === 'soon').length : null,
      broadbandExpiredCount: canSeeBroadband ? bbRows.filter((b) => b.state === 'expired').length : null,
      broadbandUnboundCount: canSeeBroadband ? bbRows.filter((b) => b.phoneId === null || !byId.has(b.phoneId)).length : null,
      broadbandNoAreaCount: canSeeBroadband ? bbRows.filter((b) => b.locationId === null).length : null,
    };
    if (canSeeFees) {
      summary.phoneMonthlyCents = sumMonthly(rows);
      if (canSeeBroadband && canSeeBbFees) summary.broadbandMonthlyCents = sumMonthly(bbRows);
      summary.monthlyCents = summary.phoneMonthlyCents + (summary.broadbandMonthlyCents ?? 0);
    }

    const keyword = (q.q ?? '').trim().toLowerCase();
    const phoneMatch = (r: LedgerPhoneRow): boolean => {
      if (keyword && ![r.number, r.plan, r.carrier, r.user, r.parentNumber, ...r.broadband.map((b) => b.account)].some((t) => t && t.toLowerCase().includes(keyword))) return false;
      if (q.carrier && r.carrier !== q.carrier) return false;
      if (q.user && r.user !== q.user) return false;
      switch (q.focus) {
        case 'main': return r.kind === 'main';
        case 'sub': return r.kind === 'sub';
        case 'standalone': return r.kind === 'main' && r.childCount === 0;
        case 'soon': return r.state === 'soon';
        case 'overdue': return r.state === 'overdue';
        case 'nofee': return noFee(r);
        default: return true;
      }
    };
    const dir = q.dir === 'desc' ? -1 : 1;
    const cmpNull = (a: number | string | null | undefined, b: number | string | null | undefined) => (a == null ? (b == null ? 0 : 1) : b == null ? -1 : a < b ? -1 : a > b ? 1 : 0);
    const sortKey = q.sort ?? (q.view === 'all' ? 'next' : 'number');
    const sorter = (a: LedgerPhoneRow, b: LedgerPhoneRow): number => {
      // 空值永远排最后，不随升降序翻转
      const pick = (r: LedgerPhoneRow) => (sortKey === 'monthly' ? r.monthlyCents ?? null : sortKey === 'next' ? r.nextRechargeAt : sortKey === 'carrier' ? r.carrier : r.number);
      const x = pick(a), y = pick(b);
      if (x == null || y == null) return cmpNull(x, y);
      return cmpNull(x, y) * dir || a.number.localeCompare(b.number);
    };

    const pageSize = Math.min(Math.max(q.pageSize ?? 20, 1), 100);
    const page = Math.max(q.page ?? 1, 1);
    const slice = <T,>(list: T[]) => list.slice((page - 1) * pageSize, page * pageSize);
    const result: LedgerResult = {
      today,
      view: q.view,
      canSeeFees,
      canSeeBroadband,
      summary,
      total: 0,
      page,
      pageSize,
      carriers: [...new Set(rows.map((r) => r.carrier).filter((x): x is string => Boolean(x)))].sort((a, b) => a.localeCompare(b, 'zh')),
      users: [...new Set(rows.map((r) => r.user).filter((x): x is string => Boolean(x)))].sort((a, b) => a.localeCompare(b, 'zh')),
    };

    if (q.view === 'all') {
      const list = rows.filter(phoneMatch).sort(sorter);
      result.total = list.length;
      if (canSeeFees) result.filteredMonthlyCents = sumMonthly(list);
      result.rows = slice(list);
    } else if (q.view === 'main') {
      // 按主卡：主卡（含没有子卡的独立号码）一行，子卡挂在下面；组里任何一张卡符合条件，整组都显示
      const groups: LedgerGroup[] = mains.map((m) => {
        const children = (childrenOf.get(m.id) ?? []).map((c) => rowById.get(c.id)!).sort((a, b) => a.number.localeCompare(b.number));
        const members = [m, ...children];
        const group: LedgerGroup = { main: m, children, unpriced: canSeeFees ? members.filter(noFee).length : 0 };
        if (canSeeFees) group.monthlyCents = sumMonthly(members);
        return group;
      }).filter((g) => [g.main, ...g.children].some(phoneMatch));
      const groupSort = (a: LedgerGroup, b: LedgerGroup) => {
        if (sortKey === 'monthly') return cmpNull(a.monthlyCents ?? null, b.monthlyCents ?? null) * dir || a.main.number.localeCompare(b.main.number);
        if (sortKey === 'next') {
          const earliest = (g: LedgerGroup) => [g.main, ...g.children].map((r) => r.nextRechargeAt).filter((x): x is string => Boolean(x)).sort()[0] ?? null;
          const x = earliest(a), y = earliest(b);
          return x == null || y == null ? cmpNull(x, y) : cmpNull(x, y) * dir || a.main.number.localeCompare(b.main.number);
        }
        return sorter(a.main, b.main);
      };
      groups.sort(groupSort);
      result.total = groups.length;
      if (canSeeFees) result.filteredMonthlyCents = groups.reduce((n, g) => n + (g.monthlyCents ?? 0), 0);
      result.groups = slice(groups);
      result.orphans = orphanRecs.map((r) => rowById.get(r.id)!).filter(phoneMatch).sort((a, b) => a.number.localeCompare(b.number)).slice(0, 100);
    } else {
      const bbMatch = (b: LedgerBroadbandRow): boolean => {
        if (keyword && ![b.account, b.location, b.phoneNumber, b.bandwidth].some((t) => t && t.toLowerCase().includes(keyword))) return false;
        if (q.location !== undefined && !(b.locationId !== null && underLocation(b.locationId, q.location))) return false;
        switch (q.focus) {
          case 'unbound': return b.phoneId === null || !byId.has(b.phoneId);
          case 'expiring': return b.state === 'soon';
          case 'expired': return b.state === 'expired';
          case 'nofee': return canSeeBbFees && !(typeof b.amountCents === 'number' && b.amountCents > 0);
          default: return true;
        }
      };
      const bbSort = (a: LedgerBroadbandRow, b: LedgerBroadbandRow) => {
        const pick = (r: LedgerBroadbandRow) => (sortKey === 'monthly' ? r.monthlyCents ?? null : sortKey === 'next' ? r.expiresAt : sortKey === 'carrier' ? r.location : r.account);
        const x = pick(a), y = pick(b);
        if (x == null || y == null) return cmpNull(x, y);
        return cmpNull(x, y) * dir || a.account.localeCompare(b.account);
      };
      const list = bbRows.filter(bbMatch).sort(q.sort ? bbSort : (a, b) => (a.location ?? '￿').localeCompare(b.location ?? '￿', 'zh') || a.account.localeCompare(b.account));
      result.total = list.length;
      if (canSeeBbFees) result.filteredMonthlyCents = sumMonthly(list);
      result.broadband = slice(list);
      const used = new Map<number, number>();
      for (const b of bbRows) if (b.locationId !== null) used.set(b.locationId, (used.get(b.locationId) ?? 0) + 1);
      result.areas = [...used.entries()].map(([id, count]) => ({ id, path: pathOf(id) || `#${id}`, count })).sort((a, b) => a.path.localeCompare(b.path, 'zh'));
    }
    return result;
  }
}
