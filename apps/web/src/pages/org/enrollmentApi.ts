import type { EnrollmentTerms } from '@kudesi/shared';
import { api } from '../../api/client';

export interface EnrollmentInvite extends EnrollmentTerms { id: number; mode: 'general' | 'position'; positionId: number | null; positionName: string; expiresAt: string | null; createdAt: string; status: 'active' | 'revoked' | 'expired' }
export interface CreatedEnrollmentInvite extends EnrollmentTerms { id: number; token: string; mode: 'general' | 'position'; positionId: number | null; expiresAt: string | null }
export interface EnrollmentPreview extends EnrollmentTerms { companyName: string; mode: 'general' | 'position'; expiresAt: string | null; position: { id: number; name: string } | null; positions: Array<{ id: number; name: string; departmentName: string }> }
export const enrollmentApi = {
  list: () => api<EnrollmentInvite[]>('/org/enrollment-invites'),
  create: (body: { mode: 'general' | 'position'; positionId?: number; validDays?: number } & EnrollmentTerms) => api<CreatedEnrollmentInvite>('/org/enrollment-invites', { body }),
  revoke: (id: number) => api<{ ok: boolean }>(`/org/enrollment-invites/${id}/revoke`, { method: 'POST' }),
  preview: (token: string) => api<EnrollmentPreview>('/enrollment/preview', { body: { token } }),
  join: (body: { token: string; name: string; phone: string; password: string; positionId?: number }) => api<{ account: string; companyName: string; positionName: string }>('/enrollment/join', { body }),
};
