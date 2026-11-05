export const TOKEN_KEY = 'kudesi.token';

/** 同源扫码窗口共享有效令牌；有效期仍由服务端校验，退出/401清除两种存储。 */
export const tokenStore = {
  get: (): string | null => {
    try {
      const saved = localStorage.getItem(TOKEN_KEY);
      if (saved) return saved;
    } catch { /* 隐私模式可能禁用持久存储，继续使用本窗口。 */ }
    let legacy: string | null = null;
    try { legacy = sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
    if (legacy) tokenStore.set(legacy); // 兼容升级前已登录的窗口。
    return legacy;
  },
  set: (token: string) => {
    try {
      localStorage.setItem(TOKEN_KEY, token);
      try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* 已持久保存。 */ }
      return;
    } catch { /* 存储受限时保留本窗口登录能力。 */ }
    sessionStorage.setItem(TOKEN_KEY, token);
  },
  clear: () => {
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* 尽力清除两处，互不阻塞。 */ }
    try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* 无可用会话存储。 */ }
  },
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

let onFeishuBindingRequired: (() => void) | null = null;
export function setFeishuBindingRequiredHandler(handler: () => void) { onFeishuBindingRequired = handler; }

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler;
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const token = tokenStore.get();
  const response = await fetch(`/api${path}`, {
    method: init.method ?? (init.body === undefined && !init.form ? 'GET' : 'POST'),
    headers: {
      // 上传文件时不能手动设 content-type，浏览器要自己带上 multipart 边界
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: init.form ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
  });

  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    let code: string | undefined;
    try {
      const data = (await response.json()) as { message?: string | string[]; code?: string };
      code = data.code;
      if (data.message) message = Array.isArray(data.message) ? data.message.join('；') : data.message;
    } catch {
      /* 响应不是 JSON，保留默认提示 */
    }
    // 登录接口自己的 401 是“账号或密码错”，不触发全局登出
    if (response.status === 401 && !['/auth/login', '/auth/feishu/desktop/poll', '/auth/feishu/desktop/relay'].includes(path)) {
      tokenStore.clear();
      onUnauthorized?.();
    }
    if (response.status === 403 && code === 'FEISHU_BINDING_REQUIRED') onFeishuBindingRequired?.();
    throw new ApiError(response.status, message, code);
  }
  return (await response.json()) as T;
}
