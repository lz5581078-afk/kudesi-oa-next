import { api, ApiError, tokenStore } from '../../api/client';

export type SessionEngine = 'native' | 'legacy';
export type SessionId = number | string;
export type SessionWorkspace = 'finance_withdrawal' | 'company_store_maintenance';
export const sessionWorkspaceFor = (base: string): SessionWorkspace => base === '/store-maintenance' ? 'company_store_maintenance' : 'finance_withdrawal';

/** Engine decisions are tied to the current signed-in identity. A failed request
 * never silently switches a write operation to another implementation. */
export function makeSessionEngineResolver(base: string) {
  let identity: string | null | undefined;
  let pending: Promise<SessionEngine> | undefined;
  return async (): Promise<SessionEngine> => {
    const current = tokenStore.get();
    if (identity !== current || !pending) {
      identity = current;
      pending = api<{ engine: SessionEngine }>(`${base}/engine`).then(value => {
        if (!['native', 'legacy'].includes(value.engine)) throw new Error('登录管理服务配置无效，请刷新后重试');
        return value.engine;
      }).catch(error => {
        // Compatibility only for an older server which has no discovery route.
        if (error instanceof ApiError && error.status === 404) return 'native' as const;
        pending = undefined;
        throw error;
      });
    }
    const result = await pending;
    if (tokenStore.get() !== current) throw new Error('登录身份已变化，请刷新后重试');
    return result;
  };
}
