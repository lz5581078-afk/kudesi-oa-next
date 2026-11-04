import { randomUUID } from 'node:crypto';
import { loadLegacySessionModule } from './legacy-runtime/snapshot';

const remote = loadLegacySessionModule('remote-assistance-service');
const ids = { remote: randomUUID(), browser: randomUUID(), device: randomUUID(), profile: randomUUID() };
const actor = { companyId: 11, workspaceId: 22, userId: 33, sessionId: ids.remote };
const device = { companyId: actor.companyId, workspaceId: actor.workspaceId, id: ids.device };

function fixture(overrides: Record<string, unknown> = {}) {
  const row = { id: ids.remote, company_id: actor.companyId, workspace_id: actor.workspaceId, user_id: actor.userId,
    shop_id: 44, device_id: ids.device, browser_session_id: ids.browser, local_profile_id: ids.profile,
    remote_status: 'closed', browser_status: 'open', device_status: 'active', ...overrides };
  const tx = { query: jest.fn(async (_sql: string, _params?: unknown[]) => [row]), execute: jest.fn(async (_sql: string, _params?: unknown[]) => ({ affectedRows: 1 })) };
  return { row, tx, withTransaction: async (work: (sql: typeof tx) => Promise<unknown>) => work(tx) };
}

describe('兼容安全关闭区分媒体终止与浏览器确认关闭', () => {
  it('历史 ended + open 不得伪报已关闭，必须建立真实精确关闭任务', async () => {
    const f = fixture({ remote_status: 'ended' });
    expect(await remote.requestRemoteBrowserClose({ ...actor, withTransaction: f.withTransaction }))
      .toMatchObject({ status: 'closing', browserStatus: 'closing', browserSessionId: ids.browser });
    const browserWrite = f.tx.execute.mock.calls.find(([sql]) => /UPDATE managed_browser_sessions/.test(sql));
    expect(browserWrite?.[1]).toEqual([ids.browser, actor.companyId, actor.workspaceId, ids.device, 44, ids.profile]);
    expect(f.tx.execute.mock.calls.some(([sql]) => /SET status = 'closing', close_stage = 'stopping_remote'/.test(sql))).toBe(true);
  });

  it.each(['requested', 'connected', 'closed', 'expired', 'error'])('正常及媒体%s后仍可请求关闭，不把传输终态当成功', async remote_status => {
    const f = fixture({ remote_status });
    expect(await remote.requestRemoteBrowserClose({ ...actor, withTransaction: f.withTransaction }))
      .toMatchObject({ status: 'closing', browserStatus: 'closing' });
  });

  it('浏览器确认为closed才幂等返回成功，不重复通知设备', async () => {
    const f = fixture({ remote_status: 'ended', browser_status: 'closed' });
    expect(await remote.requestRemoteBrowserClose({ ...actor, withTransaction: f.withTransaction }))
      .toMatchObject({ status: 'ended', browserStatus: 'closed' });
    expect(f.tx.execute.mock.calls.some(([sql]) => /UPDATE managed_browser_sessions/.test(sql))).toBe(false);
  });

  it.each(['company_id', 'workspace_id', 'user_id'])('错误%s拒绝关闭，不改变浏览器', async key => {
    const f = fixture({ [key]: 999 });
    await expect(remote.requestRemoteBrowserClose({ ...actor, withTransaction: f.withTransaction })).rejects.toMatchObject({ statusCode: 403 });
    expect(f.tx.execute.mock.calls.some(([sql]) => /UPDATE managed_browser_sessions/.test(sql))).toBe(false);
  });

  it.each([{ device_status: 'revoked' }, { browser_status: 'error' }])('不能确认的设备或浏览器状态%j不能假成功', async state => {
    const f = fixture({ remote_status: 'ended', ...state });
    await expect(remote.requestRemoteBrowserClose({ ...actor, withTransaction: f.withTransaction })).rejects.toMatchObject({ statusCode: 409 });
  });

  const acknowledgement = { device, sessionId: ids.remote, browserSessionId: ids.browser, shopId: 44, localProfileId: ids.profile };
  it.each([
    { device: { ...device, companyId: 999 } }, { device: { ...device, workspaceId: 999 } },
    { device: { ...device, id: randomUUID() } }, { browserSessionId: randomUUID() },
    { shopId: 45 }, { localProfileId: randomUUID() },
  ])('设备确认目标不匹配%j拒绝，不能写closed', async mismatch => {
    const f = fixture({ remote_status: 'closing', browser_status: 'closing' });
    await expect(remote.completeRemoteBrowserClose({ ...acknowledgement, ...mismatch, withTransaction: f.withTransaction })).rejects.toMatchObject({ statusCode: 403 });
    expect(f.tx.execute).not.toHaveBeenCalled();
  });

  it.each([
    { remote_status: 'closing', browser_status: 'closing' },
    { remote_status: 'error', browser_status: 'closing', close_stage: 'close_failed', close_requested_at: new Date() },
  ])('精确设备确认正常或超时后的实际关闭%j可完成', async state => {
    const f = fixture(state);
    expect(await remote.completeRemoteBrowserClose({ ...acknowledgement, withTransaction: f.withTransaction }))
      .toMatchObject({ status: 'ended', browserStatus: 'closed' });
    expect(f.tx.execute.mock.calls.some(([sql]) => /close_stage = 'safe_closed'/.test(sql))).toBe(true);
  });
});
