import type { BossDashboard, DailyBusiness, DeskCatalog, DeskPosition, PersonalTaskList, SummaryCard } from '@kudesi/shared';
import { api } from '../../api/client';

export interface DeskDto { position: DeskPosition; title: string; focus: string; pending: string[]; cards: SummaryCard[] }

export const workspaceApi = {
  catalog: () => api<DeskCatalog>('/workspace/catalog'),
  desk: (positionId: number) => api<DeskDto>(`/workspace/desk/${positionId}`),
  tasks: (p: { view: string; page?: number; pageSize?: number }) => api<PersonalTaskList>(`/workspace/tasks?view=${p.view}&page=${p.page ?? 1}&pageSize=${p.pageSize ?? 8}`),
  startTask: (id: number) => api<{ ok: true }>(`/workspace/tasks/${id}/start`, { method: 'POST', body: {} }),
  submitTask: (id: number, note?: string) => api<{ ok: true }>(`/workspace/tasks/${id}/submit`, { method: 'POST', body: { note } }),
  reviewTask: (id: number, approve: boolean, note?: string) => api<{ ok: true }>(`/workspace/tasks/${id}/review`, { method: 'POST', body: { approve, note } }),
  daily: (date?: string) => api<DailyBusiness>(`/workspace/daily${date ? `?date=${date}` : ''}`),
  boss: () => api<BossDashboard>('/workspace/boss'),
};
