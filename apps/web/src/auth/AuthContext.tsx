import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { createChecker, CurrentUserDto, LoginRequest, LoginResponse, PermissionChecker, PlatformAdminDto } from '@kudesi/shared';
import { api, setFeishuBindingRequiredHandler, setUnauthorizedHandler, tokenStore, TOKEN_KEY } from '../api/client';
import { resetCategoryOptions } from '../resources/categoryOptions';

interface AuthState {
  user: CurrentUserDto | null;
  /** 平台管理员登录时有值（此时 user 为空）：进入平台后台而不是公司界面 */
  platformAdmin: PlatformAdminDto | null;
  /** 正在用已保存的令牌恢复登录状态 */
  loading: boolean;
  can: PermissionChecker;
  login: (request: LoginRequest) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/** 令牌里的类型只用来决定先问哪个“我是谁”接口；真正的权限校验全在服务端。 */
function tokenIsPlatform(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { typ?: string };
    return payload.typ === 'platform';
  } catch {
    return false;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUserDto | null>(null);
  const [platformAdmin, setPlatformAdmin] = useState<PlatformAdminDto | null>(null);
  const [loading, setLoading] = useState<boolean>(() => tokenStore.get() !== null);

  const logout = useCallback(() => {
    tokenStore.clear();
    resetCategoryOptions(); // 换账号后不沿用上一家公司的分类缓存
    setUser(null);
    setPlatformAdmin(null);
  }, []);

  const refresh = useCallback(async () => {
    const token = tokenStore.get();
    if (token && tokenIsPlatform(token)) {
      const result = await api<PlatformAdminDto>('/platform/me');
      if (tokenStore.get() === token) setPlatformAdmin(result);
    } else {
      const result = await api<CurrentUserDto>('/auth/me');
      if (tokenStore.get() === token) setUser(result);
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    setFeishuBindingRequiredHandler(() => setUser(current => current ? { ...current, feishuBindingPending: true } : current));
    if (!tokenStore.get()) return;
    refresh()
      .catch(() => logout())
      .finally(() => setLoading(false));
  }, [logout, refresh]);

  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.storageArea !== localStorage || (event.key !== TOKEN_KEY && event.key !== null)) return;
      // 另一窗口退出或换账号时，立即移除旧身份及公司缓存，重新向服务端取权限。
      resetCategoryOptions();
      setUser(null); setPlatformAdmin(null);
      if (!event.newValue) { logout(); setLoading(false); return; }
      setLoading(true);
      refresh().catch(logout).finally(() => setLoading(false));
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [logout, refresh]);

  const login = useCallback(async (request: LoginRequest) => {
    const result = await api<LoginResponse>('/auth/login', { method: 'POST', body: request });
    tokenStore.set(result.accessToken);
    resetCategoryOptions();
    if (result.type === 'platform') setPlatformAdmin(result.admin);
    else setUser(result.user);
  }, []);

  const can = useMemo<PermissionChecker>(
    () => (user ? createChecker(user.permissions) : () => false),
    [user],
  );

  const value = useMemo(() => ({ user, platformAdmin, loading, can, login, logout, refresh }), [user, platformAdmin, loading, can, login, logout, refresh]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return value;
}
