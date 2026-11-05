import type { RecruitForm } from '@kudesi/shared';
import { api } from '../../api/client';

export interface RecruitInvite { id: number; label: string; channel: string | null; creatorName: string; applicationCount: number; revokedAt: string | null; createdAt: string; token: string | null }
export interface RecruitRow {
  id: number; name: string; gender: string; education: string; school: string | null; expectedSalary: string | null; phone: string; sourceChannel: string; sourceMode: 'manual' | 'image';
  status: string; statusLabel: string; handlerId: number | null; handlerName: string | null; handledAt: string | null; createdAt: string; samePhoneCount: number; openingTitle: string;
}
export interface RecruitOpening { id: number; positionId: number | null; title: string; departmentName: string; headcount: number | null; requirements: string; status: 'open' | 'closed'; applicationCount: number }
export interface PositionCandidate { id: number; name: string; departmentName: string; imported: boolean }
export interface PublicOpening { id: number; title: string; departmentName: string; requirements: string }
export interface RecruitEvent { id: number; type: string; actorName: string; detail: Record<string, unknown> | null; createdAt: string }
export interface RecruitDetail {
  id: number; status: string; statusLabel: string; sourceMode: 'manual' | 'image'; openingTitle: string; inviteLabel: string; handlerId: number | null; handlerName: string | null; handledAt: string | null;
  createdAt: string; canViewId: boolean; form: RecruitForm; events: RecruitEvent[];
}
export interface RecruitStats { total: number; unclaimed: number; handlers: Array<{ id: number; name: string; claimed: number; printed: number }> }

export const recruitApi = {
  invites: () => api<RecruitInvite[]>('/recruit/invites'),
  createInvite: (body: { label: string; channel?: string }) => api<{ id: number; token: string }>('/recruit/invites', { body }),
  revokeInvite: (id: number) => api<{ ok: boolean }>(`/recruit/invites/${id}/revoke`, { method: 'POST' }),
  openings: () => api<RecruitOpening[]>('/recruit/openings'),
  positionCandidates: () => api<PositionCandidate[]>('/recruit/position-candidates'),
  importOpenings: (positionIds: number[]) => api<{ added: number; reopened: number; skipped: number }>('/recruit/openings/import', { body: { positionIds } }),
  createOpening: (body: { title: string; headcount?: number; requirements?: string }) => api<{ id: number }>('/recruit/openings', { body }),
  updateOpening: (id: number, body: { headcount?: number; requirements?: string; status?: 'open' | 'closed' }) => api<{ ok: boolean }>(`/recruit/openings/${id}`, { method: 'PUT', body }),
  list: (q: { keyword?: string; handler?: string; page?: number }) => {
    const p = new URLSearchParams();
    if (q.keyword) p.set('keyword', q.keyword);
    if (q.handler && q.handler !== 'any') p.set('handler', q.handler);
    if (q.page && q.page > 1) p.set('page', String(q.page));
    return api<{ total: number; page: number; pageSize: number; rows: RecruitRow[] }>(`/recruit/applications${p.size ? `?${p}` : ''}`);
  },
  stats: () => api<RecruitStats>('/recruit/stats'),
  get: (id: number) => api<RecruitDetail>(`/recruit/applications/${id}`),
  claim: (id: number) => api<{ ok: boolean }>(`/recruit/applications/${id}/claim`, { method: 'POST' }),
  recordPrint: (id: number, withId: boolean) => api<{ ok: boolean }>(`/recruit/applications/${id}/print`, { body: { withId } }),
  revealId: (id: number, purpose: 'view' | 'print') => api<{ idNo: string }>(`/recruit/applications/${id}/reveal-id`, { body: { purpose } }),
};

export const recruitApplyApi = {
  preview: (token: string) => api<{ companyName: string; channel: string; openings: PublicOpening[] }>('/recruit-apply/preview', { body: { token } }),
  recognize: (token: string, file: File) => {
    const form = new FormData(); form.append('token', token); form.append('file', file);
    return api<{ form: RecruitForm; filled: number }>('/recruit-apply/recognize', { form });
  },
  submit: (body: { token: string; requestKey: string; sourceMode: 'manual' | 'image'; form: RecruitForm; openingId?: number }) => api<{ ok: boolean; id: number }>('/recruit-apply/submit', { body }),
};
