const TOKEN_KEY = 'kudesi.token';

/** 令牌放 sessionStorage：关闭标签页即失效，比 localStorage 更保守。 */
export const tokenStore = {
  get: () => sessionStorage.getItem(TOKEN_KEY),
  set: (token: string) => sessionStorage.setItem(TOKEN_KEY, token),
  clear: () => sessionStorage.removeItem(TOKEN_KEY),
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

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
    try {
      const data = (await response.json()) as { message?: string | string[] };
      if (data.message) message = Array.isArray(data.message) ? data.message.join('；') : data.message;
    } catch {
      /* 响应不是 JSON，保留默认提示 */
    }
    // 登录接口自己的 401 是“账号或密码错”，不触发全局登出
    if (response.status === 401 && path !== '/auth/login') {
      tokenStore.clear();
      onUnauthorized?.();
    }
    throw new ApiError(response.status, message);
  }
  return (await response.json()) as T;
}
