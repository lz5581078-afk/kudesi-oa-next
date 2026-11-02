import { api } from '../../api/client';

export interface EnrollmentInvite { id: number; mode: 'general' | 'position'; positionId: number | null; positionName: string; expiresAt: string; createdAt: string; status: 'active' | 'revoked' | 'expired' }
export interface CreatedEnrollmentInvite { id: number; token: string; mode: 'general' | 'position'; positionId: number | null; expiresAt: string }
export interface EnrollmentPreview { companyName: string; mode: 'general' | 'position'; expiresAt: string; position: { id: number; name: string } | null; positions: Array<{ id: number; name: string; departmentName: string }> }
export const enrollmentApi = {
  list: () => api<EnrollmentInvite[]>('/org/enrollment-invites'),
  create: (body: { mode: 'general' | 'position'; positionId?: number; validDays: number }) => api<CreatedEnrollmentInvite>('/org/enrollment-invites', { body }),
  revoke: (id: number) => api<{ ok: boolean }>(`/org/enrollment-invites/${id}/revoke`, { method: 'POST' }),
  preview: (token: string) => api<EnrollmentPreview>('/enrollment/preview', { body: { token } }),
  join: (body: { token: string; name: string; phone: string; password: string; positionId?: number }) => api<{ account: string; companyName: string; positionName: string }>('/enrollment/join', { body }),
};
