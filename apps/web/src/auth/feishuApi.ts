import { api } from '../api/client';
export interface FeishuBindingStatus { configured: boolean; bound: boolean; allNotificationsEnabled: boolean; notificationsEnabled: boolean }
export const feishuApi = {
  status: () => api<FeishuBindingStatus>('/auth/feishu/binding'),
  start: () => api<{ authorizationUrl: string }>('/auth/feishu/bind/start', { body: {} }),
  complete: (code: string, state: string) => api<{ bound: boolean; allNotificationsEnabled?: boolean }>('/auth/feishu/bind/complete', { body: { code, state } }),
  redirect: (url: string) => window.location.assign(url),
};
