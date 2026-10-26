/** 助手升级包发布 / 下载 / 升级进度的真实数据库测试。RESOURCE_DB_TEST=1 TEST_DB_NAME=kudesi_oa_test_g npx jest agent-release */
import 'reflect-metadata';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { alignSessionTimeZone, buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { buildServices } from '../test-support';
import { SessionService } from './session.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

/** 和 apps/agent/src/bundle.ts 同格式的升级包 */
function pack(version: string, tweak?: (m: { files: Array<{ path: string; data: string }> }) => void): Buffer {
  const mk = (path: string, c: string) => { const data = Buffer.from(c); return { path, size: data.length, sha256: sha(data), data: data.toString('base64') }; };
  const m = { format: 'kudesi-assistant-package', formatVersion: 1, version, dependencies: {}, files: [mk('package.json', '{}'), mk('dist/cli.js', `//${version}`), mk('dist/main.js', 'm')] };
  tweak?.(m);
  return zlib.gzipSync(Buffer.from(JSON.stringify(m)));
}

d('助手升级包（真实数据库）', () => {
  let ds: DataSource, svc: SessionService;
  let boss: AuthUser, viewer: AuthUser, outsider: AuthUser;
  const oldEnv = process.env.KUDESI_AGENT_LATEST_VERSION;

  beforeAll(async () => {
    delete process.env.KUDESI_AGENT_LATEST_VERSION;
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    await alignSessionTimeZone(ds);
    const s = buildServices(ds);
    svc = new SessionService(ds, s.crypto, s.files);
    const mk = async (code: string) => {
      const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `${code}${crypto.randomBytes(5).toString('hex')}`, name: '升级测试', status: 'active' }));
      const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: 'admin', passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
      return { id: u.id, companyId: c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } } as AuthUser;
    };
    boss = await mk('ur'); outsider = await mk('uo');
    viewer = { ...boss, permissions: { isCompanyAdmin: false, allow: ['finance.doc-withdrawal.view'], deny: [] } };
  });
  afterAll(async () => { if (oldEnv !== undefined) process.env.KUDESI_AGENT_LATEST_VERSION = oldEnv; await ds?.destroy(); });

  const pair = async (user: AuthUser, version = '1.1.0') => {
    const { code } = await svc.createBindCode(user);
    return svc.agentRegister({ code, name: '电脑', os: 'Windows 11', agentVersion: version });
  };

  it('只有管理权限能看/传/撤回；文件和哈希被篡改、版本不符、非升级包都拒绝', async () => {
    const good = pack('1.2.0');
    await expect(svc.publishRelease(viewer, { buffer: good }, {})).rejects.toThrow(/权限/);
    await expect(svc.listReleases(viewer)).rejects.toThrow(/权限/);
    await expect(svc.withdrawRelease(viewer, 1)).rejects.toThrow(/权限/);
    await expect(svc.publishRelease(boss, undefined, {})).rejects.toThrow(/选择升级包/);
    await expect(svc.publishRelease(boss, { buffer: Buffer.from('hello') }, {})).rejects.toThrow(/不是有效的助手升级包/);
    // 管理员填的 SHA-256 来自原始文件，上传内容被换成别的 → 拒绝
    const tampered = Buffer.from(good); tampered[tampered.length - 12] ^= 0xff;
    await expect(svc.publishRelease(boss, { buffer: tampered }, { sha256: sha(good) })).rejects.toThrow(/SHA-256 与上传的文件不一致/);
    await expect(svc.publishRelease(boss, { buffer: good }, { sha256: 'xyz' })).rejects.toThrow(/64 位/);
    // 包内文件内容被改（sha 对不上）/ 含越界路径 / 缺主程序
    await expect(svc.publishRelease(boss, { buffer: pack('1.2.0', (m) => { m.files[1].data = Buffer.from('evil').toString('base64'); }) }, {})).rejects.toThrow(/校验失败/);
    await expect(svc.publishRelease(boss, { buffer: pack('1.2.0', (m) => { m.files[1].path = '../evil.js'; }) }, {})).rejects.toThrow(/不允许的文件/);
    await expect(svc.publishRelease(boss, { buffer: pack('1.2.0', (m) => { m.files.pop(); }) }, {})).rejects.toThrow(/缺少助手主程序/);
    await expect(svc.publishRelease(boss, { buffer: good }, { version: '9.9.9' })).rejects.toThrow(/不一致/);
    expect(await svc.listReleases(boss)).toEqual([]);
  });

  it('发布 → 版本只能递增、不能覆盖；按公司隔离；撤回后最新版回落', async () => {
    const r = await svc.publishRelease(boss, { buffer: pack('1.2.0') }, { version: '1.2.0', sha256: sha(pack('1.2.0')).toUpperCase(), notes: '修复登录' });
    expect(r).toMatchObject({ version: '1.2.0' });
    await expect(svc.publishRelease(boss, { buffer: pack('1.2.0') }, {})).rejects.toThrow(/已经发布过/);
    await expect(svc.publishRelease(boss, { buffer: pack('1.1.5') }, {})).rejects.toThrow(/必须高于/);
    expect(await svc.listReleases(outsider).catch((e) => e)).toEqual([]); // 别的公司看不到
    await svc.publishRelease(boss, { buffer: pack('1.10.0') }, {}); // 1.10.0 > 1.2.0（数字比较）
    let rows = await svc.listReleases(boss);
    expect(rows.map((x) => [x.version, x.isLatest])).toEqual([['1.10.0', true], ['1.2.0', false]]);
    expect(JSON.stringify(rows)).not.toContain('package"');
    await svc.withdrawRelease(boss, rows[0].id);
    await expect(svc.withdrawRelease(boss, rows[0].id)).rejects.toThrow(/不存在或已撤回/);
    await expect(svc.withdrawRelease(outsider, rows[1].id)).rejects.toThrow(/不存在或已撤回/);
    rows = await svc.listReleases(boss);
    expect(rows.find((x) => x.isLatest)?.version).toBe('1.2.0');
  });

  it('调度用最新已发布版本；心跳带 sha256/size；下载只发给被安排的设备；进度回报；升到目标版本自动成功', async () => {
    const dev = await pair(boss);
    const other = await pair(boss);
    const alien = await pair(outsider);
    const rel = (await svc.listReleases(boss)).find((x) => x.isLatest)!;
    expect(await svc.requestDeviceUpdate(boss, dev.deviceId)).toMatchObject({ queued: true, target: '1.2.0' });
    expect((await svc.devices(boss)).find((x) => x.id === dev.deviceId)).toMatchObject({ outdated: true, latestVersion: '1.2.0' });
    const hb = await svc.agentHeartbeat(dev.token, { agentVersion: '1.1.0' });
    expect(hb.update).toEqual({ targetVersion: '1.2.0', sha256: rel.sha256, size: rel.size });
    // 没被安排升级的设备、别的公司设备、错误版本、无令牌：都不能下载
    await expect(svc.agentReleaseDownload(other.token, '1.2.0')).rejects.toThrow(/没有升级/);
    await expect(svc.agentReleaseDownload(alien.token, '1.2.0')).rejects.toThrow(/没有升级/);
    await expect(svc.agentReleaseDownload(dev.token, '1.10.0')).rejects.toThrow(/没有升级/);
    await expect(svc.agentReleaseDownload(undefined, '1.2.0')).rejects.toThrow(/未授权/);
    await expect(svc.agentReleaseDownload('0'.repeat(64), '1.2.0')).rejects.toThrow(/未授权/);
    const dl = await svc.agentReleaseDownload(dev.token, '1.2.0');
    expect(sha(dl.buf)).toBe(rel.sha256);
    expect(dl.sha256).toBe(rel.sha256);
    // 进度回报
    await expect(svc.agentUpdateReport(other.token, { version: '1.2.0', status: 'downloading' })).rejects.toThrow(/没有对应的升级安排/);
    await expect(svc.agentUpdateReport(dev.token, { version: '1.2.0', status: 'succeeded' })).rejects.toThrow(/升级状态不对/); // 成功不接受自报
    await expect(svc.agentUpdateReport(dev.token, { version: '1.9.9', status: 'downloading' })).rejects.toThrow(/没有对应的升级安排/);
    await svc.agentUpdateReport(dev.token, { version: '1.2.0', status: 'downloading' });
    expect((await svc.devices(boss)).find((x) => x.id === dev.deviceId)!.update).toMatchObject({ status: 'downloading', error: null });
    // 进行中仍会收到升级目标（助手中途重启可接着升级）
    expect((await svc.agentHeartbeat(dev.token, { agentVersion: '1.1.0' })).update).toMatchObject({ targetVersion: '1.2.0' });
    await svc.agentUpdateReport(dev.token, { version: '1.2.0', status: 'restarting' });
    expect((await svc.agentHeartbeat(dev.token, { agentVersion: '1.2.0' })).update).toBeNull();
    expect((await svc.devices(boss)).find((x) => x.id === dev.deviceId)).toMatchObject({ outdated: false, update: { status: 'succeeded', target: '1.2.0' } });
    await expect(svc.agentUpdateReport(dev.token, { version: '1.2.0', status: 'failed' })).rejects.toThrow(/没有对应的升级安排/); // 已结束
  });

  it('失败 / 已回退：记录原因，不再下发；重新安排后可再试；全部升级跳过进行中的', async () => {
    const dev = await pair(boss);
    await svc.requestDeviceUpdate(boss, dev.deviceId);
    await svc.agentUpdateReport(dev.token, { version: '1.2.0', status: 'rolled_back', errorText: '新版本启动失败，已回退到 1.1.0' });
    let row = (await svc.devices(boss)).find((x) => x.id === dev.deviceId)!;
    expect(row.update).toMatchObject({ status: 'rolled_back', error: expect.stringContaining('已回退') });
    expect((await svc.agentHeartbeat(dev.token, { agentVersion: '1.1.0' })).update).toBeNull();
    const all = await svc.requestUpdateAll(boss); // 终态的设备会被重新安排
    expect(all.queued).toBeGreaterThanOrEqual(1);
    row = (await svc.devices(boss)).find((x) => x.id === dev.deviceId)!;
    expect(row.update).toMatchObject({ status: 'queued', error: null });
    expect((await svc.requestUpdateAll(boss)).queued).toBe(0); // 都已在进行中
    await svc.agentUpdateReport(dev.token, { version: '1.2.0', status: 'failed', errorText: 'x'.repeat(500) });
    expect((await svc.devices(boss)).find((x) => x.id === dev.deviceId)!.update!.error).toHaveLength(300);
    const log = await ds.query("SELECT summary FROM session_audit_logs WHERE company_id = ? AND event_type IN ('agent_update_failed','agent_update_rolled_back')", [boss.companyId]);
    expect(log.length).toBeGreaterThanOrEqual(2);
  });

  it('库里的包被改动（哈希对不上）→ 拒绝发放；包被撤回 → 下发中的设备标记失败且不能下载', async () => {
    const dev = await pair(boss);
    await svc.publishRelease(boss, { buffer: pack('1.11.0') }, {});
    expect(await svc.requestDeviceUpdate(boss, dev.deviceId)).toMatchObject({ target: '1.11.0' });
    await ds.query("UPDATE agent_releases SET package = ? WHERE company_id = ? AND version = '1.11.0'", [Buffer.from('tampered'), boss.companyId]);
    await expect(svc.agentReleaseDownload(dev.token, '1.11.0')).rejects.toThrow(/校验失败/);
    const rel = (await svc.listReleases(boss)).find((x) => x.version === '1.11.0')!;
    await svc.withdrawRelease(boss, rel.id);
    await expect(svc.agentReleaseDownload(dev.token, '1.11.0')).rejects.toThrow(/不存在或已撤回/);
    expect((await svc.agentHeartbeat(dev.token, { agentVersion: '1.1.0' })).update).toBeNull();
    expect((await svc.devices(boss)).find((x) => x.id === dev.deviceId)!.update).toMatchObject({ status: 'failed', error: expect.stringContaining('撤回') });
  });
});
