/** Explicit allowlist: imported authorization objects must never be returned to clients. */
export function companyConnectionsSummary(jst: Record<string, any> | null, feishu: Record<string, any> | null) {
  const accounts = Array.isArray(jst?.accounts) ? jst.accounts : [];
  const channels = Array.isArray(feishu?.channels) ? feishu.channels : [];
  return {
    jushuitan: {
      configured: accounts.length > 0,
      accounts: accounts.map(a => ({ name: String(a.name ?? '').slice(0, 100), status: String(a.authStatus ?? ''), tokenConfigured: Boolean(a.accessToken), refreshTokenConfigured: Boolean(a.refreshToken), expiresAt: a.tokenExpiresAt ? String(a.tokenExpiresAt) : null })),
    },
    feishu: {
      configured: Boolean(feishu?.appId && feishu?.appSecret),
      channels: channels.map(c => ({ key: String(c.key ?? '').slice(0, 32), credentialConfigured: Boolean((c.inheritsMainApp ? feishu?.appSecret : c.appSecret)), recipientCount: Array.isArray(c.recipientUserIds) ? c.recipientUserIds.length : 0 })),
    },
  };
}
