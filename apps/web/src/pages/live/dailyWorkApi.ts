import { api } from '../../api/client';
export interface DailyWorkRow {
  id: number;
  userId: number;
  name: string;
  role: 'anchor' | 'control';
  date: string;
  content: string;
  status: string;
  statusLabel: string;
  plannedStart: string;
  plannedEnd: string;
  startAt: string | null;
  endAt: string | null;
  report: string | null;
  returnReason: string | null;
  flowRunId: number | null;
  elapsedMinutes?: number;
  minutes: number | null;
  actualMinutes: number | null;
  reviewNote: string | null;
  hourlyRateCents: number | null;
  amountCents: number | null;
  canStart: boolean;
  overdue: boolean;
}
export interface DailyWorkList {
  monthTotal?: { month: string; amountCents: number; minutes: number };
  now: string;
  canManage: boolean;
  rows: DailyWorkRow[];
}
export interface DailyWorkInput {
  userId: number;
  role: 'anchor' | 'control';
  startAt: string;
  endAt: string;
  content: string;
}
export interface DailyPerson {
  id: number;
  name: string;
  hourlyRateCents: number;
  roles: Array<'anchor' | 'control'>;
}
export interface DailyWorkLedger {
  page: number; total: number; month: string;
  summary: { amountCents: number; minutes: number } | null;
  rows: DailyWorkRow[];
}
export const dailyWorkApi = {
  ledger: (mode: 'review' | 'wages', month: string, page: number) => api<DailyWorkLedger>(`/live/daily-work/${mode}?month=${encodeURIComponent(month)}&page=${page}`),
  options: () => api<DailyPerson[]>('/live/daily-work/options'),
  list: (date: string) =>
    api<DailyWorkList>(`/live/daily-work?date=${encodeURIComponent(date)}`),
  mine: (date: string, token?: string, company?: string) =>
    api<DailyWorkList>(
      `/live/daily-work/mine?date=${encodeURIComponent(date)}${token !== undefined ? `&token=${encodeURIComponent(token)}&company=${encodeURIComponent(company ?? '')}` : ''}`,
    ),
  schedule: (input: DailyWorkInput) =>
    api<{ id: number }>('/live/daily-work', { method: 'POST', body: input }),
  start: (id: number) =>
    api<{ ok: true }>(`/live/daily-work/${id}/start`, { method: 'POST' }),
  finish: (id: number, report: string) =>
    api<{ ok: true }>(`/live/daily-work/${id}/finish`, {
      method: 'POST',
      body: { report },
    }),
  report: (id: number, report: string) =>
    api<{ ok: true }>(`/live/daily-work/${id}/report`, {
      method: 'PATCH',
      body: { report },
    }),
  submit: (id: number) =>
    api<{ runId: number }>(`/live/daily-work/${id}/submit`, { method: 'POST' }),
  cancel: (id: number, reason: string) =>
    api<{ ok: true }>(`/live/daily-work/${id}/cancel`, {
      method: 'POST',
      body: { reason },
    }),
};
