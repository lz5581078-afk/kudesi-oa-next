import { StrictMode } from 'react';
import { cleanup, render, screen, act } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './AuthContext';
import { tokenStore } from '../api/client';

function Probe() { const { user, loading } = useAuth(); return <p>{loading ? '恢复登录中' : user?.name ?? '需要登录'}</p>; }
const user = { id: 1, companyId: 1, name: '扫码员工', account: 'staff', permissions: { isCompanyAdmin: false, allow: [], deny: [] } };
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });
it('关闭原窗口再扫码（空sessionStorage）仍校验和恢复有效OA身份', async () => {
  tokenStore.set('valid-oa-token');
  sessionStorage.clear();
  const fetcher = vi.fn(async () => new Response(JSON.stringify(user), { status: 200 }));
  vi.stubGlobal('fetch', fetcher);
  render(<StrictMode><AuthProvider><Probe /></AuthProvider></StrictMode>);
  expect(await screen.findByText('扫码员工')).toBeTruthy();
  expect(fetcher).toHaveBeenCalledWith('/api/auth/me', expect.objectContaining({ headers: { authorization: 'Bearer valid-oa-token' } }));
});
it('升级前的session令牌迁移后，新扫码窗口也可以使用', () => {
  sessionStorage.setItem('kudesi.token', 'legacy');
  expect(tokenStore.get()).toBe('legacy');
  sessionStorage.clear(); expect(tokenStore.get()).toBe('legacy');
});
it('服务器判定过期或停用时清除持久令牌，不凭本地缓存放行', async () => {
  tokenStore.set('expired');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: '登录已过期' }), { status: 401 })));
  render(<AuthProvider><Probe /></AuthProvider>);
  await screen.findByText('需要登录');
  expect(tokenStore.get()).toBeNull(); expect(localStorage.getItem('kudesi.token')).toBeNull();
});
it('手动退出清除新旧存储，不能在下一次扫码恢复旧身份', () => {
  tokenStore.set('current'); sessionStorage.setItem('kudesi.token', 'old'); tokenStore.clear();
  expect(tokenStore.get()).toBeNull(); expect(sessionStorage.getItem('kudesi.token')).toBeNull();
});
it('持久存储受限时仍可在当前窗口登录及退出', () => {
  const original = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function(this: Storage, key, value) {
    if (this === localStorage) throw new DOMException('blocked', 'SecurityError');
    original.call(this, key, value);
  });
  tokenStore.set('fallback'); expect(tokenStore.get()).toBe('fallback'); tokenStore.clear(); expect(tokenStore.get()).toBeNull();
});

it('另一个扫码窗口退出时，本窗口同步退出', async () => {
  tokenStore.set('shared');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(user), { status: 200 })));
  render(<AuthProvider><Probe /></AuthProvider>); await screen.findByText('扫码员工');
  localStorage.removeItem('kudesi.token');
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'kudesi.token', newValue: null, storageArea: localStorage })));
  expect(await screen.findByText('需要登录')).toBeTruthy();
});
it('另一窗口换账号时重新验证身份，不能沿用上一员工权限', async () => {
  tokenStore.set('first');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(tokenStore.get()==='second' ? {...user,name:'第二位员工'} : user), { status: 200 })));
  render(<AuthProvider><Probe /></AuthProvider>); await screen.findByText('扫码员工');
  localStorage.setItem('kudesi.token','second');
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'kudesi.token', newValue: 'second', storageArea: localStorage })));
  expect(await screen.findByText('第二位员工')).toBeTruthy();
});
