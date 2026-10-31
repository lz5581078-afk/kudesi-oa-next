import { api } from '../../api/client';
import type { RunDetailDto } from '../flow/flowApi';

export interface Person { id: number; name: string }
export interface Option extends Person { detail: string; partTime?: boolean; live?: boolean; hasJstShop?: boolean }
export interface RoomOpt { id: number; name: string; shortName: string; big: boolean; path: string; side: 'north' | 'south' | 'none'; live: boolean }
export interface Options { rooms: RoomOpt[]; anchors: Option[]; controls: Option[]; operators: Option[]; douyinAccounts: Option[]; stores: Option[] }
export interface Product { id: number; code: string; name: string; spec: string }

export interface ScheduleRow {
  id: number; roomId: number; roomName: string; date: string; start: string; end: string; startTime: string; endTime: string; status: 'scheduled' | 'live' | 'finished' | 'cancelled'; statusLabel: string;
  anchor: Person; control: Person | null; operator: Person | null; douyinAccount: Person; store: Person | null; sessionId: number | null; note: string | null; cancelReason: string | null;
  canStart?: boolean; mineRole?: string;
}
export interface ScheduleList { from: string; to: string; rows: ScheduleRow[]; canManage: boolean }
export interface ScheduleBody { date: string; roomId: number; startTime: string; endTime: string; anchorId: number; controlId: number | null; operatorId: number | null; douyinAccountId: number; storeId: number | null; note?: string }

export interface SessionRow {
  id: number; scheduleId: number | null; roomId: number; roomName: string; date: string; startAt: string; endAt: string | null; plannedEnd: string | null; status: 'live' | 'pending_report' | 'submitted' | 'returned' | 'approved'; statusLabel: string;
  anchor: Person; control: Person | null; operator: Person | null; douyinAccount: Person; store: Person | null; finalSalesCents: number | null; finalSalesSource: string | null; finalSalesReason: string | null;
  returnReason: string | null; flowRunId: number | null; submittedAt: string | null; approvedAt: string | null; approverName: string | null; revision: number;
}
export interface RoleAmount { rateUnits: number; amountCents: number }
export interface Preview { available: boolean; reason: string; basisSalesCents?: number; adSpendCents?: number; roiScaled?: number | null; belowRoi?: boolean; anchor: RoleAmount | null; control: RoleAmount | null; operator: RoleAmount | null }
export interface ReportDto {
  role: 'anchor' | 'control' | 'operator'; roleLabel: string; reporter: Person; endAt: string; salesCents: number; adSpendCents: number | null; ordersTotalCents: number | null; orderCount: number; note: string;
  orders: Array<{ orderId: string; amountCents: number; payTime: string | null; status: string | null }>;
}
export interface SessionDetail extends SessionRow {
  products: Product[]; reports: ReportDto[];
  commissions: Array<{ userId: number; name: string; role: string; roleLabel: string; rateUnits: number; amountCents: number; roiScaled: number | null; belowRoi: boolean }>;
  wage: { userId: number; minutes: number; hourlyRateCents: number; amountCents: number; rateSource: string; note: string | null; startAt: string; endAt: string } | null;
  preview: Preview | null; me: { reportRoles: Array<'anchor' | 'control' | 'operator'>; canSubmit: boolean; isManager: boolean }; flow: RunDetailDto | null;
}
export interface SessionList { total: number; page: number; pageSize: number; rows: SessionRow[] }
export interface StartBody { scheduleId?: number | null; roomId?: number | null; anchorId?: number | null; controlId?: number | null; operatorId?: number | null; douyinAccountId?: number | null; storeId?: number | null; productIds: number[]; startAt?: string | null }
export interface OrderCandidate { orderId: string; innerId: string; payTime: string | null; paid: boolean; amountCents: number; status: string; statusLabel: string; cancelled: boolean }
export interface Candidates { available: boolean; reason: string; shopName?: string; orders: OrderCandidate[]; truncated: boolean; queriedAt?: string; startAt: string; endAt: string }
export interface ReportBody { role?: string; endAt: string; salesCents: number; adSpendCents?: number | null; orderIds?: string[]; note?: string }
export interface ReviewForm { finalSource?: string; finalSalesCents?: number; finalReason?: string; operatorUserId?: number; noOperator?: boolean; wageStartAt?: string; wageEndAt?: string; wageHourlyRateCents?: number; wageNote?: string }
export interface ReviewPreview {
  finalSource: string; finalSalesCents: number; adSpendCents: number; roiScaled: number | null; belowRoi: boolean; ruleVersion: { id: number; effectiveFrom: string };
  anchor: RoleAmount; control: RoleAmount | null; operator: RoleAmount | null; operatorUserId: number | null; operatorDoubledAsControl: boolean;
  wage: { startAt: string; endAt: string; minutes: number; hourlyRateCents: number; amountCents: number; rateSource: string; archiveHourlyRateCents: number | null };
}

export interface TimelineItem { kind: 'schedule' | 'adhoc'; id: number; start: string; end: string; plannedEnd: string; anchorName: string; controlName: string | null; operatorName: string | null; douyinName: string; state: 'live' | 'done' | 'missed' | 'due' | 'upcoming'; sessionId: number | null }
export interface RoomTile extends Omit<RoomOpt, 'live'> {
  status: 'live' | 'finished' | 'idle'; statusLabel: string; next: TimelineItem | null; timeline: TimelineItem[];
  live: { id: number; startAt: string; plannedEnd: string | null; anchor: Person; control: Person | null; operator: Person | null; douyinAccount: Person } | null;
}
export interface Overview { date: string; now: string; groups: { north: RoomTile[]; south: RoomTile[]; none: RoomTile[] }; corridorFound: boolean; totals: { rooms: number; live: number; scheduled: number; pendingReview: number } }
export interface RoomDay { room: RoomOpt; date: string; schedules: ScheduleRow[]; sessions: Array<{ id: number; scheduleId: number | null; status: string; startAt: string; endAt: string | null; anchor: Person; control: Person | null; douyinAccount: Person; anchorSalesCents: number | null; controlSalesCents: number | null; finalSalesCents: number | null }> }

export interface Workbench {
  today: string; month: string; identity: { isAnchor: boolean; isControl: boolean; canManage: boolean }; active: SessionRow[]; schedules: ScheduleRow[]; recent: SessionRow[];
  monthCommissionCents: number; monthWageCents: number; monthWageMinutes: number;
  commissionRows: Array<{ id: number; sessionId: number; date: string; roomName: string; role: string; roleLabel: string; finalSalesCents: number; rateUnits: number; amountCents: number }>;
  wageRows: Array<{ id: number; sessionId: number; date: string; roomName: string; minutes: number; hourlyRateCents: number; amountCents: number }>;
}
export interface Period { sessions: number; minutes: number; commissionCents: number; wageCents: number; wageMinutes: number }
export interface History { mode: string; month: string; total: number; page: number; pageSize: number; rows: Array<SessionRow & { myRoles: string[]; commissionCents: number | null; wageCents: number | null }>; summary: { all: Period; thisMonth: Period; lastMonth: Period } }

export interface CommissionRow { id: number; sessionId: number; userId: number; userName: string; role: string; roleLabel: string; date: string; roomName: string; startAt: string; douyinName: string; finalSalesCents: number; adSpendCents: number; roiScaled: number | null; belowRoi: boolean; rateUnits: number; amountCents: number; ruleVersionId: number }
export interface Commissions { month: string; scope: 'all' | 'mine'; totalCents: number; summary: Array<{ userId: number; name: string; role: string; roleLabel: string; sessions: number; salesCents: number; amountCents: number }>; rows: CommissionRow[] }
export interface WageRow { id: number; sessionId: number; userId: number; userName: string; date: string; roomName: string; startAt: string; endAt: string; minutes: number; hourlyRateCents: number; rateSource: string; amountCents: number; note: string }
export interface Wages { month: string; scope: 'all' | 'mine'; totalCents: number; summary: Array<{ userId: number; name: string; sessions: number; minutes: number; amountCents: number }>; rows: WageRow[] }

export interface RulesForm { boundary: string; roiThreshold: string; belowRoiAnchorDeduct: string; belowRoiControlDeduct: string; operatorRate: string; tiers: Array<{ min: string; max: string; anchorRate: string; controlRate: string }> }
export interface RuleVersion { id: number; effectiveFrom: string; note: string | null; createdAt: string; creatorName: string | null; usedCount: number; form: RulesForm }
export interface RuleList { canManage: boolean; currentId: number | null; versions: RuleVersion[] }
export interface Trial { tierIndex: number; roiScaled: number | null; belowRoi: boolean; anchor: RoleAmount; control: RoleAmount; operator: RoleAmount }

export interface SettlementHead { id: number; month: string; status: 'draft' | 'submitted' | 'returned' | 'approved'; statusLabel: string; recordCount: number; commissionTotalCents: number; refundTotalCents: number; deductionTotalCents: number; payableTotalCents: number; refundsCheckedAt: string | null; note: string; returnReason: string | null; flowRunId: number | null; creatorName: string; submittedAt: string | null; approvedAt: string | null; revision: number }
export interface SettlementDetail extends SettlementHead {
  canManage: boolean; byPerson: Array<{ userId: number; name: string; role: string; roleLabel: string; commissionCents: number; deductionCents: number; payableCents: number; sessions: number }>;
  lines: Array<{ id: number; sessionId: number; userId: number; userName: string; role: string; roleLabel: string; date: string; roomName: string; startTime: string; finalSalesCents: number; rateUnits: number; commissionCents: number; orderCount: number; ordersTotalCents: number; refundCents: number; deductionCents: number; payableCents: number }>;
  refunds: Array<{ sessionId: number; orderId: string; orderAmountCents: number; refundCents: number; source: string; details: unknown; checkedAt: string }>;
}

const qs = (p: Record<string, unknown>) => {
  const q = Object.entries(p).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
  return q ? `?${q}` : '';
};
const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });

export interface SourceStatus { ready: boolean; code: 'ready' | 'unconfigured' | 'unauthorized' | 'expired' | 'error'; message: string }
export const liveApi = {
  integrationStatus: () => api<SourceStatus>('/live/integration-status'),
  commissionPreview: (id: number, b: { sales: string; adSpend?: string }) => post<Preview | null>(`/live/sessions/${id}/commission-preview`, b),
  options: () => api<Options>('/live/options'),
  products: (keyword: string) => api<Product[]>(`/live/products${qs({ keyword })}`),
  overview: (date?: string) => api<Overview>(`/live/overview${qs({ date })}`),
  roomDay: (id: number, date?: string) => api<RoomDay>(`/live/rooms/${id}/day${qs({ date })}`),
  schedules: (p: { from?: string; to?: string } = {}) => api<ScheduleList>(`/live/schedules${qs(p)}`),
  createSchedule: (b: ScheduleBody) => post<{ id: number }>('/live/schedules', b),
  updateSchedule: (id: number, b: ScheduleBody) => api<{ ok: true }>(`/live/schedules/${id}`, { method: 'PUT', body: b }),
  cancelSchedule: (id: number, reason: string) => post<{ ok: true }>(`/live/schedules/${id}/cancel`, { reason }),
  start: (b: StartBody) => post<{ id: number }>('/live/sessions', b),
  sessions: (p: Record<string, unknown> = {}) => api<SessionList>(`/live/sessions${qs(p)}`),
  session: (id: number) => api<SessionDetail>(`/live/sessions/${id}`),
  candidates: (id: number, p: { endAt?: string; refresh?: boolean }) => api<Candidates>(`/live/sessions/${id}/order-candidates${qs({ endAt: p.endAt, refresh: p.refresh ? '1' : undefined })}`),
  report: (id: number, b: ReportBody) => post<{ ok: true }>(`/live/sessions/${id}/report`, b),
  submit: (id: number) => post<{ runId: number }>(`/live/sessions/${id}/submit`),
  reviewPreview: (id: number, b: ReviewForm) => post<ReviewPreview>(`/live/sessions/${id}/review-preview`, b),
  workbench: () => api<Workbench>('/live/workbench'),
  history: (p: Record<string, unknown>) => api<History>(`/live/workbench/history${qs(p)}`),
  commissions: (p: Record<string, unknown>) => api<Commissions>(`/live/commissions${qs(p)}`),
  wages: (p: Record<string, unknown>) => api<Wages>(`/live/wages${qs(p)}`),
  people: () => api<Person[]>('/live/people'),
  rules: () => api<RuleList>('/live/rules'),
  createRule: (b: { effectiveFrom: string; note?: string; rules: RulesForm }) => post<{ id: number }>('/live/rules', b),
  trial: (b: { rules: RulesForm; sales: string; adSpend?: string }) => post<Trial>('/live/rules/trial', b),
  settlements: () => api<{ canManage: boolean; defaultMonth: string; rows: SettlementHead[] }>('/live/settlements'),
  settlement: (id: number) => api<SettlementDetail>(`/live/settlements/${id}`),
  generateSettlement: (month: string, note?: string) => post<{ id: number }>('/live/settlements', { month, note }),
  submitSettlement: (id: number) => post<{ runId: number }>(`/live/settlements/${id}/submit`),
};
