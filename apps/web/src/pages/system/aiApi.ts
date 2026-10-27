import { api } from '../../api/client';

export interface AiProvider { id: number; providerKey: string; name: string; baseUrl: string; modelName: string | null; status: 'active' | 'testing' | 'inactive'; lastSyncedAt: string | null; lastSyncError: string | null; modelCount: number; apiKeyConfigured: boolean }
export interface AiModel { modelId: string; ownedBy: string | null; endpointType: string; capabilities: string[]; syncedAt: string }
export interface AiDefaults { scopes: Array<{ key: string; label: string; current: { providerId: number; modelId: string } | null }>; providers: Array<{ id: number; name: string; status: string; models: string[] }> }
export type AiProviderBody = { name: string; baseUrl: string; apiKey?: string; modelName?: string; status?: string };

export const aiApi = {
  overview: () => api<{ syncEnabled: boolean; providers: AiProvider[] }>('/settings/ai'),
  create: (b: AiProviderBody) => api<{ id: number }>('/settings/ai/providers', { method: 'POST', body: b }),
  update: (id: number, b: AiProviderBody) => api<{ id: number }>(`/settings/ai/providers/${id}`, { method: 'PUT', body: b }),
  remove: (id: number) => api<{ ok: true }>(`/settings/ai/providers/${id}`, { method: 'DELETE' }),
  models: (id: number) => api<AiModel[]>(`/settings/ai/providers/${id}/models`),
  sync: (id: number) => api<{ synced: number }>(`/settings/ai/providers/${id}/sync-models`, { method: 'POST', body: {} }),
  setSwitch: (enabled: boolean) => api<{ syncEnabled: boolean }>('/settings/ai/sync-switch', { method: 'PUT', body: { enabled } }),
  defaults: () => api<AiDefaults>('/settings/ai/defaults'),
  setDefault: (scope: string, providerId: number | null, modelId?: string) => api<{ ok: true }>(`/settings/ai/defaults/${scope}`, { method: 'PUT', body: { providerId, modelId } }),
};
