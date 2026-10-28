import { companyConnectionsSummary } from './company-connections';

describe('company API credential summaries', () => {
  it('returns only configured flags and permitted metadata, including inherited channel credentials', () => {
    const out = companyConnectionsSummary({ accounts: [{ name: 'ERP', authStatus: 'configured', accessToken: 'PRIVATE-TOKEN', refreshToken: 'PRIVATE-REFRESH', nested: { password: 'PRIVATE-PASSWORD' } }] }, { appId: 'PRIVATE-ID', appSecret: 'PRIVATE-SECRET', tenantKey: 'PRIVATE-TENANT', channels: [{ key: 'flow', inheritsMainApp: true, recipientUserIds: [1, 2], appSecret: 'PRIVATE-CHANNEL-SECRET' }] });
    expect(out.jushuitan.accounts[0].tokenConfigured).toBe(true);
    expect(out.feishu.channels[0]).toEqual({ key: 'flow', credentialConfigured: true, recipientCount: 2 });
    expect(JSON.stringify(out)).not.toContain('PRIVATE-');
  });
  it('handles absent configuration without claiming credentials exist', () => {
    const out = companyConnectionsSummary(null, null);
    expect(out.jushuitan.configured).toBe(false);
    expect(out.feishu.configured).toBe(false);
    expect(out.feishu.channels).toEqual([]);
  });
});
