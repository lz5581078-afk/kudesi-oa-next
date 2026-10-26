/** 远程协助：权限、电脑同意、时限、审计、信令信箱的真实数据库测试。RESOURCE_DB_TEST=1 TEST_DB_NAME=kudesi_oa_test_f npx jest remote */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { alignSessionTimeZone, buildDataSourceOptions } from '../database/data-source';
import { Company, SessionAuditLog, SessionRemoteSession, SessionRemoteSignal, User } from '../entities';
import { buildServices } from '../test-support';
import { buildIceServers, RemoteAssistService } from './remote.service';
import { SessionService } from './session.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
const MIN = 60_000;

d('远程协助（真实数据库）', () => {
  let ds: DataSource, sess: SessionService, remote: RemoteAssistService, res: ReturnType<typeof buildServices>['resources'];
  let boss: AuthUser, operator: AuthUser, operator2: AuthUser, viewerOnly: AuthUser, other: AuthUser;
  let storeA = 0, storeB = 0, offset = 0;
  const perm = (u: User, allow: string[]): AuthUser => ({ id: u.id, companyId: u.companyId, name: u.name, permissions: { isCompanyAdmin: false, allow, deny: [] } });
  const mkUser = async (companyId: number, account: string, name: string, admin = false) =>
    ds.manager.save(User, ds.manager.create(User, { companyId, account, passwordHash: 'x', name, isCompanyAdmin: admin, status: 'active', mustChangePassword: false }));
  const audits = async (type?: string) => (await ds.manager.find(SessionAuditLog, { where: { companyId: boss.companyId }, order: { id: 'ASC' } })).filter((a) => !type || a.eventType === type);

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test_f' }), migrationsRun: true } as never);
    await ds.initialize();
    await alignSessionTimeZone(ds);
    const s = buildServices(ds);
    res = s.resources;
    sess = new SessionService(ds, s.crypto, s.files);
    remote = new RemoteAssistService(ds);
    remote.clock = () => new Date(Date.now() + offset);
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `r${crypto.randomBytes(5).toString('hex')}`, name: '远程测试', status: 'active' }));
    const c2 = await ds.manager.save(Company, ds.manager.create(Company, { code: `r${crypto.randomBytes(5).toString('hex')}`, name: '别家公司', status: 'active' }));
    const ub = await mkUser(c.id, 'boss', '老板', true);
    boss = { id: ub.id, companyId: c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    operator = perm(await mkUser(c.id, 'op1', '小王'), ['finance.doc-withdrawal.view', 'finance.session.remote']);
    operator2 = perm(await mkUser(c.id, 'op2', '小李'), ['finance.doc-withdrawal.view', 'finance.session.remote']);
    viewerOnly = perm(await mkUser(c.id, 'v1', '只看的人'), ['finance.doc-withdrawal.view']);
    const uo = await mkUser(c2.id, 'x1', '外人');
    other = perm(uo, ['finance.doc-withdrawal.view', 'finance.session.remote', 'finance.session.manage']);
    storeA = (await res.create(boss, 'stores', { platform: 'pdd', name: '远程店A' })).id;
    storeB = (await res.create(boss, 'stores', { platform: 'pdd', name: '远程店B' })).id;
  });
  afterAll(async () => { await ds?.destroy(); });
  afterEach(async () => {
    offset = 0; delete process.env.KUDESI_REMOTE_ASSIST_DISABLED;
    for (const sh of (await sess.overview(boss)).shops) await sess.removeShop(boss, sh.id).catch(() => undefined);
  });

  /** 新绑定一台在线电脑 + 一家店铺（可选开启远程协助） */
  const setup = async (store: number, opts: { enable?: boolean; control?: boolean; minutes?: number } = { enable: true, control: true }) => {
    const { code } = await sess.createBindCode(boss);
    const dev = await sess.agentRegister({ code, name: `电脑${crypto.randomBytes(2).toString('hex')}`, agentVersion: '1.0.0' });
    await sess.agentHeartbeat(dev.token, {});
    await sess.addShops(boss, { storeIds: [store], deviceId: dev.deviceId });
    const shop = (await sess.overview(boss)).shops.find((x) => x.storeId === store)!;
    if (opts.enable) await remote.setDevice(boss, dev.deviceId, { enabled: true, allowControl: !!opts.control, maxMinutes: opts.minutes ?? 15 });
    return { dev, shop };
  };
  /** 时间往前走 ms，期间助手和网页每 20 秒各联系一次（两边都在线） */
  const advance = async (dev: { token: string }, id: number, ms: number) => {
    const target = offset + ms;
    while (offset < target) { offset = Math.min(target, offset + 20_000); await remote.agentExchange(dev.token, id, {}); await remote.poll(operator, id, 0); }
  };
  const teardown = async (shopId: number) => { await sess.removeShop(boss, shopId).catch(() => undefined); };

  it('默认全部关闭：没开启的电脑不能申请，助手领取也是空的', async () => {
    const { dev, shop } = await setup(storeA, {});
    await expect(remote.request(operator, shop.id, { mode: 'view', reason: '看看提现页' })).rejects.toThrow(/没有开启远程协助/);
    expect(await remote.agentClaim(dev.token)).toEqual({ enabled: false, session: null });
    const st = (await remote.shopStates(operator)).shops.find((x) => x.shopId === shop.id)!;
    expect(st).toMatchObject({ remoteEnabled: false, live: null });
    expect((await remote.devices(boss)).devices.find((x) => x.deviceId === dev.deviceId)).toMatchObject({ enabled: false, allowControl: false });
    await teardown(shop.id);
  });

  it('权限：没有远程协助权限的人不能申请/看/发信令；只有管理权限的人才能开关电脑、紧急停止', async () => {
    const { dev, shop } = await setup(storeA);
    await expect(remote.request(viewerOnly, shop.id, { mode: 'view', reason: '想看看' })).rejects.toThrow(/没有发起远程协助的权限/);
    await expect(remote.setDevice(operator, dev.deviceId, { enabled: false })).rejects.toThrow(/权限/);
    await expect(remote.stopAll(operator)).rejects.toThrow(/权限/);
    await expect(remote.history(viewerOnly)).rejects.toThrow(/权限/);
    const r = await remote.request(operator, shop.id, { mode: 'view', reason: '帮忙看一下验证码' });
    await expect(remote.get(viewerOnly, r.id)).rejects.toThrow(/权限/);
    // 别的运营（有申请权限）不是申请人：不能看、不能收发信令、不能结束
    await expect(remote.get(operator2, r.id)).rejects.toThrow(/不是你发起/);
    await expect(remote.poll(operator2, r.id, 0)).rejects.toThrow(/不是你发起/);
    await expect(remote.signal(operator2, r.id, { kind: 'join' })).rejects.toThrow(/不是你发起/);
    await expect(remote.end(operator2, r.id)).rejects.toThrow(/不是你发起/);
    // 别的公司的人什么也看不到
    await expect(remote.get(other, r.id)).rejects.toThrow(/不存在/);
    await expect(remote.end(other, r.id)).rejects.toThrow(/不存在/);
    await expect(remote.request(other, shop.id, { mode: 'view', reason: '串公司' })).rejects.toThrow(/不在列表/);
    await expect(remote.setDevice(other, dev.deviceId, { enabled: true })).rejects.toThrow(/不存在/);
    expect((await remote.shopStates(other)).shops).toHaveLength(0);
    expect(await remote.history(other)).toHaveLength(0);
    // 管理者能结束别人的
    await remote.end(boss, r.id);
    expect((await remote.history(boss))[0]).toMatchObject({ endReason: 'ended_by_admin', status: 'ended' });
    await teardown(shop.id);
  });

  it('事由必填、模式必须合法；只观看的电脑不允许申请“可操作”；一家店铺/一台电脑同时只有一场', async () => {
    const { dev, shop } = await setup(storeA, { enable: true, control: false });
    await expect(remote.request(operator, shop.id, { mode: 'view', reason: ' ' })).rejects.toThrow(/事由/);
    await expect(remote.request(operator, shop.id, { mode: 'god', reason: '随便写写' })).rejects.toThrow(/模式/);
    await expect(remote.request(operator, shop.id, { mode: 'control', reason: '想操作一下' })).rejects.toThrow(/只允许观看/);
    const r = await remote.request(operator, shop.id, { mode: 'view', reason: '只看' });
    await expect(remote.request(operator2, shop.id, { mode: 'view', reason: '我也想看' })).rejects.toThrow(/已经有一场/);
    const claim = (await remote.agentClaim(dev.token)).session!;
    expect(claim).toMatchObject({ id: r.id, mode: 'view', reason: '只看', requestedByName: '小王', store: { name: '远程店A', platform: 'pdd' } });
    await remote.end(operator, r.id);
    await teardown(shop.id);
  });

  it('完整流程：申请 → 助手领取 → 本机同意 → 信令往返 → 延长 → 结束；记录有时长，日志有全程', async () => {
    const { dev, shop } = await setup(storeA, { enable: true, control: true, minutes: 20 });
    const before = (await audits()).length;
    const r = await remote.request(operator, shop.id, { mode: 'control', reason: '拼多多提现要滑块验证' });
    expect((await remote.get(operator, r.id)).status).toBe('requested');
    await expect(remote.signal(operator, r.id, { kind: 'join' })).rejects.toThrow(/还没有同意/); // 电脑同意之前不能发信令
    const claim = (await remote.agentClaim(dev.token)).session!;
    expect(claim.maxMinutes).toBe(20);
    await expect(remote.agentAccept('0'.repeat(64), r.id)).rejects.toThrow(/未授权/);
    const acc = await remote.agentAccept(dev.token, r.id);
    expect(acc.mode).toBe('control');
    expect(new Date(acc.expiresAt).getTime() - Date.now()).toBeGreaterThan(19 * MIN);
    await expect(remote.agentAccept(dev.token, r.id)).rejects.toThrow(/已经开始/);
    const v = await remote.get(operator, r.id);
    expect(v).toMatchObject({ status: 'active', mine: true, storeName: '远程店A', requestedByName: '小王' });
    // 信令往返
    await remote.signal(operator, r.id, { kind: 'join' });
    const ex1 = await remote.agentExchange(dev.token, r.id, { send: [{ kind: 'offer', payload: { sdp: 'v=0 offer' } }, { kind: 'ice', payload: { candidate: null } }], after: 0 });
    expect(ex1.status).toBe('active');
    expect(ex1.signals.map((x) => x.kind)).toEqual(['join']);
    const p1 = await remote.poll(operator, r.id, 0);
    expect(p1.signals.map((x) => x.kind)).toEqual(['offer', 'ice']);
    expect(p1.signals[0].payload).toEqual({ sdp: 'v=0 offer' });
    await remote.signal(operator, r.id, { kind: 'answer', payload: { sdp: 'v=0 answer' } });
    const ex2 = await remote.agentExchange(dev.token, r.id, { after: ex1.signals[0].id, inputs: 7 });
    expect(ex2.signals.map((x) => x.kind)).toEqual(['answer']);
    expect((await remote.poll(operator, r.id, p1.signals[1].id)).signals).toHaveLength(0); // 游标：不重复领取
    // 方向、类型、大小限制
    await expect(remote.signal(operator, r.id, { kind: 'offer', payload: { sdp: 'x' } })).rejects.toThrow(/信令类型/); // 网页不能冒充助手
    await expect(remote.signal(operator, r.id, { kind: 'input', payload: {} })).rejects.toThrow(/信令类型/);
    await expect(remote.signal(operator, r.id, { kind: 'answer', payload: { sdp: 'x'.repeat(70_000) } })).rejects.toThrow(/过大|SDP/);
    expect((await remote.agentExchange(dev.token, r.id, { send: [{ kind: 'answer', payload: { sdp: 'v=0' } }] })).rejected).toBe(1); // 助手也不能发网页的类型
    // 另一台电脑的令牌碰不到这场协助
    const other2 = await setup(storeB);
    await expect(remote.agentExchange(other2.dev.token, r.id, {})).rejects.toThrow(/不存在/);
    await expect(remote.agentEnd(other2.dev.token, r.id, {})).rejects.toThrow(/不存在/);
    await teardown(other2.shop.id);
    // 延长
    const e1 = await remote.extend(operator, r.id);
    expect(e1.secondsLeft).toBeGreaterThan(29 * 60);
    await expect(remote.extend(operator2, r.id)).rejects.toThrow(/不是你发起/);
    // 5 分钟后结束
    await advance(dev, r.id, 5 * MIN + 12_000);
    await remote.end(operator, r.id);
    const hist = (await remote.history(operator))[0];
    expect(hist).toMatchObject({ id: r.id, status: 'ended', endReason: 'completed', mode: 'control', reason: '拼多多提现要滑块验证', storeName: '远程店A', requestedByName: '小王', inputCount: 7, extendCount: 1 });
    expect(hist.durationSeconds).toBeGreaterThanOrEqual(5 * 60 + 11);
    expect(hist.durationSeconds).toBeLessThan(5 * 60 + 40);
    // 结束后：信箱清空、不能再发信令、助手收到 ended
    expect(await ds.manager.count(SessionRemoteSignal, { where: { sessionId: r.id } })).toBe(0);
    await expect(remote.signal(operator, r.id, { kind: 'join' })).rejects.toThrow(/已经结束/);
    expect((await remote.agentExchange(dev.token, r.id, {})).status).toBe('ended');
    await remote.end(operator, r.id); // 重复结束不报错也不重复记日志
    const log = (await audits()).slice(before).map((a) => a.eventType).filter((t) => t.startsWith('remote_') && t !== 'remote_device_enabled');
    expect(log).toEqual(['remote_requested', 'remote_started', 'remote_extended', 'remote_ended']);
    const ended = (await audits('remote_ended')).pop()!;
    expect(ended.summary).toMatch(/小王/);
    expect(ended.summary).toMatch(/远程店A/);
    expect(ended.summary).toMatch(/5分\d+秒/);
    expect(ended.summary).toMatch(/正常结束/);
    expect(ended).toMatchObject({ actorId: operator.id, deviceId: dev.deviceId, storeId: storeA });
    await teardown(shop.id);
  });

  it('时限：到点自动结束；延长不能超过 60 分钟总上限', async () => {
    const { dev, shop } = await setup(storeA, { enable: true, control: false, minutes: 55 });
    const r = await remote.request(operator, shop.id, { mode: 'view', reason: '看看' });
    await remote.agentClaim(dev.token); await remote.agentAccept(dev.token, r.id);
    await remote.extend(operator, r.id); // 55 -> 60（封顶）
    await expect(remote.extend(operator, r.id)).rejects.toThrow(/最长 60 分钟/);
    await advance(dev, r.id, 59 * MIN);
    expect((await remote.get(operator, r.id)).status).toBe('active');
    await advance(dev, r.id, MIN - 20_000);
    expect((await remote.get(operator, r.id)).status).toBe('active'); // 差 20 秒到点
    offset += 60_000;
    const g = await remote.get(operator, r.id);
    expect(g).toMatchObject({ status: 'ended', endReason: 'expired' });
    expect((await audits('remote_ended')).pop()!.summary).toMatch(/到达时限/);
    await teardown(shop.id);
  });

  it('电脑没有响应 / 助手掉线 / 网页掉线 都会自动结束并记录原因', async () => {
    const a = await setup(storeA);
    const r1 = await remote.request(operator, a.shop.id, { mode: 'view', reason: '没人理我' });
    offset = 61_000;
    expect((await remote.get(operator, r1.id)).endReason).toBe('no_response');
    offset = 0;
    const r2 = await remote.request(operator, a.shop.id, { mode: 'view', reason: '助手会掉线' });
    await remote.agentClaim(a.dev.token); await remote.agentAccept(a.dev.token, r2.id);
    offset = 31_000;
    await remote.poll(operator, r2.id, 0); // 网页还在，助手不在了
    expect((await remote.get(operator, r2.id)).endReason).toBe('agent_lost');
    offset = 0;
    const r3 = await remote.request(operator, a.shop.id, { mode: 'view', reason: '网页会掉线' });
    await remote.agentClaim(a.dev.token); await remote.agentAccept(a.dev.token, r3.id);
    offset = 20_000; await remote.agentExchange(a.dev.token, r3.id, {}); offset = 40_000; await remote.agentExchange(a.dev.token, r3.id, {}); // 助手一直在，网页 40 秒没动
    expect((await remote.get(operator, r3.id)).status).toBe('active');
    offset = 52_000; await remote.agentExchange(a.dev.token, r3.id, {});
    expect((await remote.get(operator, r3.id)).endReason).toBe('viewer_lost');
    expect((await remote.agentExchange(a.dev.token, r3.id, {})).status).toBe('ended');
    await teardown(a.shop.id);
  });

  it('电脑一方可以拒绝；关闭电脑的远程协助、撤销电脑、店铺改绑/移除都会立即结束进行中的协助', async () => {
    const a = await setup(storeA);
    const r1 = await remote.request(operator, a.shop.id, { mode: 'view', reason: '被拒绝' });
    await remote.agentDecline(a.dev.token, r1.id, '电脑主人在忙');
    expect(await remote.get(operator, r1.id)).toMatchObject({ endReason: 'declined', status: 'ended' });
    // 关闭开关
    const r2 = await remote.request(operator, a.shop.id, { mode: 'view', reason: '关开关测试' });
    await remote.agentClaim(a.dev.token); await remote.agentAccept(a.dev.token, r2.id);
    await remote.setDevice(boss, a.dev.deviceId, { enabled: false });
    expect((await remote.get(operator, r2.id)).endReason).toBe('device_disabled');
    expect(await remote.agentClaim(a.dev.token)).toEqual({ enabled: false, session: null });
    await expect(remote.request(operator, a.shop.id, { mode: 'view', reason: '又来了' })).rejects.toThrow(/没有开启/);
    // 撤销电脑
    await remote.setDevice(boss, a.dev.deviceId, { enabled: true, allowControl: true });
    const r3 = await remote.request(operator, a.shop.id, { mode: 'control', reason: '撤销测试' });
    await remote.agentClaim(a.dev.token); await remote.agentAccept(a.dev.token, r3.id);
    await sess.setDeviceStatus(boss, a.dev.deviceId, 'revoked');
    expect((await remote.get(operator, r3.id)).endReason).toBe('device_revoked');
    await expect(remote.agentClaim(a.dev.token)).rejects.toThrow(/未授权/);
    await expect(remote.setDevice(boss, a.dev.deviceId, { enabled: true })).rejects.toThrow(/已撤销/);
    await teardown(a.shop.id);
    // 店铺移除
    const b = await setup(storeA);
    const r4 = await remote.request(operator, b.shop.id, { mode: 'view', reason: '移除店铺测试' });
    await remote.agentClaim(b.dev.token); await remote.agentAccept(b.dev.token, r4.id);
    await sess.removeShop(boss, b.shop.id);
    expect((await remote.get(operator, r4.id)).endReason).toBe('shop_changed');
  });

  it('紧急停止：结束所有进行中的协助并关闭全部电脑；环境变量总开关立刻拒绝新申请并结束进行中的', async () => {
    const a = await setup(storeA);
    const b = await setup(storeB);
    const ra = await remote.request(operator, a.shop.id, { mode: 'view', reason: '停止测试A' });
    const rb = await remote.request(operator2, b.shop.id, { mode: 'view', reason: '停止测试B' });
    await remote.agentClaim(a.dev.token); await remote.agentAccept(a.dev.token, ra.id);
    const out = await remote.stopAll(boss);
    expect(out.ended).toBe(2);
    expect(out.disabledDevices).toBeGreaterThanOrEqual(2);
    expect((await remote.get(operator, ra.id)).endReason).toBe('killed');
    expect((await remote.get(operator2, rb.id)).endReason).toBe('killed');
    expect((await remote.devices(boss)).devices.every((x) => !x.enabled)).toBe(true);
    expect((await audits('remote_stop_all')).length).toBe(1);
    await teardown(a.shop.id); await teardown(b.shop.id);
    const c = await setup(storeA);
    const rc = await remote.request(operator, c.shop.id, { mode: 'view', reason: '总开关测试' });
    await remote.agentClaim(c.dev.token); await remote.agentAccept(c.dev.token, rc.id);
    process.env.KUDESI_REMOTE_ASSIST_DISABLED = '1';
    expect((await remote.get(operator, rc.id)).endReason).toBe('killed');
    await expect(remote.request(operator, c.shop.id, { mode: 'view', reason: '总开关之后' })).rejects.toThrow(/已关闭远程协助/);
    expect(await remote.agentClaim(c.dev.token)).toEqual({ enabled: false, session: null });
    expect((await remote.devices(boss)).globalDisabled).toBe(true);
    delete process.env.KUDESI_REMOTE_ASSIST_DISABLED;
    await teardown(c.shop.id);
  });

  it('开关参数校验与记录：时长范围、开关写操作日志、只看自己的历史', async () => {
    const a = await setup(storeA, {});
    await expect(remote.setDevice(boss, a.dev.deviceId, { enabled: true, maxMinutes: 3 })).rejects.toThrow(/5 到 60/);
    await expect(remote.setDevice(boss, a.dev.deviceId, { enabled: true, maxMinutes: 120 })).rejects.toThrow(/5 到 60/);
    await remote.setDevice(boss, a.dev.deviceId, { enabled: true, allowControl: true, maxMinutes: 30 });
    expect((await audits('remote_device_enabled')).pop()!.summary).toMatch(/可操作.*30 分钟/);
    const r = await remote.request(operator, a.shop.id, { mode: 'view', reason: '历史范围测试' });
    await remote.end(operator, r.id);
    expect((await remote.history(operator)).every((h) => h.requestedByName === '小王')).toBe(true);
    expect((await remote.history(operator2)).some((h) => h.id === r.id)).toBe(false);
    expect((await remote.history(boss)).some((h) => h.id === r.id)).toBe(true);
    expect(await ds.manager.findOneByOrFail(SessionRemoteSession, { id: r.id })).toMatchObject({ endReason: 'cancelled' }); // 没开始就取消
    await teardown(a.shop.id);
  });
});

describe('ICE 配置（不需要数据库）', () => {
  it('没配置就是空；有 TURN 时给限时账号，账号里带会话号', () => {
    expect(buildIceServers(1, 600, {})).toEqual([]);
    const now = 1_700_000_000_000;
    const ice = buildIceServers(7, 600, { WEBRTC_STUN_URLS: 'stun:s.example.com:3478', WEBRTC_TURN_URLS: 'turn:t.example.com:3478, turns:t.example.com:5349', WEBRTC_TURN_SHARED_SECRET: 'abcdefgh12345678' }, now);
    expect(ice[0]).toEqual({ urls: ['stun:s.example.com:3478'] });
    expect(ice[1].urls).toHaveLength(2);
    expect(ice[1].username).toBe(`${Math.floor(now / 1000) + 600}:remote-7`);
    expect(ice[1].credential).toBe(crypto.createHmac('sha1', 'abcdefgh12345678').update(ice[1].username!).digest('base64'));
    expect(buildIceServers(7, 600, { WEBRTC_TURN_URLS: 'turn:t.example.com', WEBRTC_TURN_SHARED_SECRET: 'short' }, now)).toEqual([]); // 密钥太短不发 TURN 账号
  });
});
