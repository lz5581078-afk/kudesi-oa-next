import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './AuthContext';
import { api, tokenStore } from '../api/client';
const user = { id: 1, companyId: 1, name: '旧员工', account: 'manual', companyName: '公司', positionName: null, mustChangePassword: false, permissions: { isCompanyAdmin: false, allow: [], deny: [] } };
function Probe() { const { user, loading } = useAuth(); return <><p>{loading ? '加载' : user?.feishuBindingPending ? '必须绑定' : '已进入业务'}</p><button onClick={() => void api('/business').catch(() => {})}>请求业务</button></>; }
beforeEach(() => { tokenStore.set('existing-session'); });
afterEach(() => { cleanup(); tokenStore.clear(); vi.unstubAllGlobals(); });
it.each([['FEISHU_BINDING_REQUIRED', true], [undefined, false]])('旧会话收到绑定拦截才切回绑定页；普通403保留原状态：%s', async (code, gated) => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/auth/me' ? user : { message: '被拒绝', code }), { status: url === '/api/auth/me' ? 200 : 403, headers: { 'Content-Type': 'application/json' } })));
  render(<AuthProvider><Probe /></AuthProvider>);
  await screen.findByText('已进入业务'); fireEvent.click(screen.getByRole('button', { name: '请求业务' }));
  if (gated) await screen.findByText('必须绑定');
  else await waitFor(() => expect(screen.getByText('已进入业务')).toBeTruthy());
  expect(tokenStore.get()).toBe('existing-session');
});
