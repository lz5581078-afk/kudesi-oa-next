import { api } from '../../api/client';

export interface ExclusiveOption {
  id: number; code: string; name: string; categoryId: number | null; categoryName: string;
  exclusive: { ownerName: string; endsAt: string; mine: boolean } | null;
  pending: { runId: number; requesterName: string; mine: boolean } | null;
}
export interface ExclusiveOptions { total: number; free: number; capped: boolean; rows: ExclusiveOption[]; categories: Array<{ id: number; name: string; parentId: number | null }> }
export interface ExclusiveGrant {
  id: number; productName: string; ownerName: string; approverName: string; runId: number | null; startsAt: string; endsAt: string;
  status: 'active' | 'expired' | 'cancelled'; cancelReason: string; cancelledAt: string | null; canCancel: boolean;
}
const qs = (o: Record<string, string | number | boolean | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '' && v !== false) q.set(k, String(v));
  return q.toString() ? `?${q}` : '';
};
export const exclusiveApi = {
  options: (p: { keyword?: string; categoryId?: number; onlyFree?: boolean }) => api<ExclusiveOptions>(`/flow/exclusive/options${qs(p)}`),
  grants: () => api<{ rows: ExclusiveGrant[] }>('/flow/exclusive/grants'),
  cancel: (id: number, reason: string) => api<{ ok: true }>(`/flow/exclusive/grants/${id}/cancel`, { method: 'POST', body: { reason } }),
};
