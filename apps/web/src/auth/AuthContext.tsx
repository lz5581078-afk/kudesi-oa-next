import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { createChecker, CurrentUserDto, LoginRequest, LoginResponse, PermissionChecker } from '@kudesi/shared';
import { api, setUnauthorizedHandler, tokenStore } from '../api/client';

interface AuthState {
  user: CurrentUserDto | null;
  /** 正在用已保存的令牌恢复登录状态 */
  loading: boolean;
  can: PermissionChecker;
  login: (request: LoginRequest) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUserDto | null>(null);
  const [loading, setLoading] = useState<boolean>(() => tokenStore.get() !== null);

  const logout = useCallback(() => {
    tokenStore.clear();
    setUser(null);
  }, []);

  const refresh = useCallback(async () => {
    setUser(await api<CurrentUserDto>('/auth/me'));
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    if (!tokenStore.get()) return;
    refresh()
      .catch(() => logout())
      .finally(() => setLoading(false));
  }, [logout, refresh]);

  const login = useCallback(async (request: LoginRequest) => {
    const result = await api<LoginResponse>('/auth/login', { method: 'POST', body: request });
    tokenStore.set(result.accessToken);
    setUser(result.user);
  }, []);

  const can = useMemo<PermissionChecker>(
    () => (user ? createChecker(user.permissions) : () => false),
    [user],
  );

  const value = useMemo(() => ({ user, loading, can, login, logout, refresh }), [user, loading, can, login, logout, refresh]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return value;
}
