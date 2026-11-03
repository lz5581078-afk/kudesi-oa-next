import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';

const load = createRequire(import.meta.url);
const fs = load('node:fs/promises') as typeof import('node:fs/promises');
const root = fileURLToPath(new URL('../legacy-runtime/', import.meta.url));
const cfg = load(path.join(root, 'config.js'));
const { agentApi, AgentApiError } = load(path.join(root, 'api.js'));
const { registerDevice } = load(path.join(root, 'register-device.js'));
const mainNamespace = 'v1:1:company_store_maintenance';
const withdrawalNamespace = 'v1:1:finance_withdrawal';
const configuration = (profileNamespace: string | undefined = withdrawalNamespace) => ({
  serverUrl: 'https://oa.example.test', profileNamespace, deviceToken: 'synthetic-device-token', shops: {},
});
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

let directory: string;
let previousDataDir: string | undefined;
beforeEach(async () => {
  previousDataDir = process.env.SESSION_MANAGER_AGENT_DATA_DIR;
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kudesi-scoped-agent-test-'));
  process.env.SESSION_MANAGER_AGENT_DATA_DIR = directory;
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (previousDataDir === undefined) delete process.env.SESSION_MANAGER_AGENT_DATA_DIR;
  else process.env.SESSION_MANAGER_AGENT_DATA_DIR = previousDataDir;
  const resolved = await fs.realpath(directory);
  const temporaryRoot = await fs.realpath(os.tmpdir());
  if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith('kudesi-scoped-agent-test-')) {
    throw new Error('Refusing unexpected test cleanup path');
  }
  await fs.rm(resolved, { recursive: true });
});

describe('0.3.45原助手的Profile作用域最小适配', () => {
  it('同店按服务器origin、公司和用途隔离；同scope保持Profile与原编号', () => {
    const shared = {};
    const configs = [configuration(), { ...configuration(), profileNamespace: mainNamespace },
      { ...configuration(), profileNamespace: 'v1:2:finance_withdrawal' },
      { ...configuration(), serverUrl: 'https://another.example.test' }].map(value => ({ ...value, shops: shared }));
    const profiles = configs.map(value => cfg.ensureShopProfile(value, 101, '合成店铺', 'pdd'));
    expect(new Set(profiles.map(value => value.localProfileId)).size).toBe(4);
    expect(profiles.map(value => value.storeId)).toEqual(['101', '101', '101', '101']);
    expect(cfg.ensureShopProfile(configs[0], '101', '改名', 'pdd')).toBe(profiles[0]);
    expect(cfg.shopProfileKey({ ...configs[0], serverUrl: 'https://OA.Example.Test:443/a/path' }, 101))
      .toBe(cfg.shopProfileKey(configs[0], 101));
    expect(cfg.shopProfileKey({ ...configs[0], serverUrl: 'https://oa.example.test:444' }, 101))
      .not.toBe(cfg.shopProfileKey(configs[0], 101));
  });

  it('缺失/未知namespace、错误公司编号、非法origin和不安全店铺编号安全拒绝', () => {
    for (const namespace of [undefined, '', '1:finance_withdrawal', 'v1:0:finance_withdrawal',
      'v1:01:finance_withdrawal', 'v1:1:unknown', 'v1:4294967296:finance_withdrawal']) {
      expect(() => cfg.ensureShopProfile({ ...configuration(), profileNamespace: namespace }, 1, 'shop')).toThrow();
    }
    for (const storeId of [0, -1, '001', '1.5', '../1', Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => cfg.shopProfileKey(configuration(), storeId)).toThrow();
    }
    expect(() => cfg.shopProfileKey({ ...configuration(), serverUrl: 'http://public.example.test' }, 1)).toThrow();
    expect(() => cfg.shopProfileKey({ ...configuration(), serverUrl: 'https://user:pass@oa.example.test' }, 1)).toThrow();
  });

  it('保留旧raw-ID配置及Profile文件，不自动导入到新scope', async () => {
    const old = { storeId: '1', platformCode: 'pdd', localProfileId: 'old-unscoped-profile' };
    const config = { ...configuration(), shops: { '1': old } };
    const oldDirectory = cfg.profileDir(old);
    await fs.mkdir(oldDirectory, { recursive: true });
    await fs.writeFile(path.join(oldDirectory, 'synthetic-sentinel'), 'old-profile-preserved');
    const current = cfg.ensureShopProfile(config, 1, '新用途店铺', 'pdd');
    expect(current.localProfileId).not.toBe(old.localProfileId);
    expect(config.shops['1']).toBe(old);
    expect(await fs.readFile(path.join(oldDirectory, 'synthetic-sentinel'), 'utf8')).toBe('old-profile-preserved');
    await cfg.saveConfig(config);
    expect((await cfg.loadConfig()).shops['1']).toEqual(old);
  });

  it('原sessions平台查找只使用作用域key，既不读也不修改旧raw-ID Profile', async () => {
    const { markLocalLoginStatus } = load(path.join(root, 'sessions.js'));
    const old = { storeId: '1', platformCode: 'jd', localProfileId: 'legacy', localLoginStatus: 'expired' };
    const config = { ...configuration(), shops: { '1': old } };
    const current = cfg.ensureShopProfile(config, 1, '合成店铺', 'taobao');
    const api = vi.fn().mockResolvedValue({ ok: true });
    await markLocalLoginStatus(config, 1, current.localProfileId, 'pending', { api, save: async () => {} });
    const payload = JSON.parse(api.mock.calls[0][2].body);
    expect(payload).toMatchObject({ storeId: 1, localProfileId: current.localProfileId, platformCode: 'taobao' });
    expect(old.localLoginStatus).toBe('expired'); expect(current.localLoginStatus).toBe('pending');
  });

  it('原打开流程对旧raw-ID视为新环境，首次绑定一次；同scope重试不重复初始化', async () => {
    const { runOpenShop } = load(path.join(root, 'open-shop.js'));
    const old = { storeId: '1', platformCode: 'jd', localProfileId: 'old-profile' };
    const config = { ...configuration(), shops: { '1': old } };
    const fetcher = vi.fn().mockImplementation(async () => response({ ok: true }));
    vi.stubGlobal('fetch', fetcher);
    const request = () => ({ id: 'synthetic-request', store_id: 1, store_name: '店铺', platform_code: 'pdd' });
    const options = { reportProgress: async () => {}, executablePath: 'synthetic-not-executed', adapter: { platformCode: 'pdd' },
      openShopBrowser: async () => { throw new Error('synthetic stop before browser'); } };
    await expect(runOpenShop(config, request(), options)).rejects.toThrow('synthetic stop before browser');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ storeId: '1', platformCode: 'pdd', loginStatus: 'pending' });
    const profile = cfg.ensureShopProfile(config, 1, '店铺', 'pdd');
    await expect(runOpenShop(config, request(), options)).rejects.toThrow('synthetic stop before browser');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cfg.ensureShopProfile(config, 1, '店铺', 'pdd').localProfileId).toBe(profile.localProfileId);
    expect(config.shops['1']).toBe(old);
  });

  it('原关闭恢复只接受当前scope Profile，旧raw-ID或另一用途不能授权关闭', async () => {
    const { recoverMissingBrowserClose } = load(path.join(root, 'browser-close-recovery.js'));
    const config = { ...configuration(), deviceId: '11111111-1111-4111-8111-111111111111', shops: {} };
    const current = cfg.ensureShopProfile(config, 1, '店铺', 'pdd');
    const job = { shopId: 1, deviceId: config.deviceId, localProfileId: current.localProfileId,
      browserSessionId: '22222222-2222-4222-8222-222222222222', remoteSessionId: '33333333-3333-4333-8333-333333333333' };
    const options = { config, job, isIdle: () => true, snapshot: async () => ({ complete: true, processes: [] }), pause: async () => {} };
    expect(await recoverMissingBrowserClose(options)).toMatchObject({ closed: true });
    expect(await recoverMissingBrowserClose({ ...options, config: { ...config, profileNamespace: mainNamespace } }))
      .toMatchObject({ closed: false, reason: 'close_binding_unverified' });
  });
});

describe('namespace握手、持久化与注册', () => {
  it('首次升级heartbeat必须先持久化成功，随后才能领取任务', async () => {
    const config = configuration(undefined);
    // Default parameters supply a scope, so represent the old absent field explicitly.
    delete (config as { profileNamespace?: string }).profileNamespace;
    const fetcher = vi.fn().mockImplementation(async () => response({ authorized: true, profileNamespace: withdrawalNamespace }));
    vi.stubGlobal('fetch', fetcher);
    let entered!: () => void, release!: () => void;
    const enteredRename = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (...args) => { entered(); await gate; return rename(...args); });
    const heartbeat = agentApi(config, '/api/session-manager/agent/heartbeat', { method: 'POST', body: '{}' });
    await enteredRename;
    expect(config.profileNamespace).toBeUndefined();
    await expect(agentApi(config, '/api/session-manager/agent/open-requests')).rejects.toMatchObject({ status: 403 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    release(); await heartbeat;
    expect((await cfg.loadConfig()).profileNamespace).toBe(withdrawalNamespace);
    expect(config.profileNamespace).toBe(withdrawalNamespace);
    await agentApi(config, '/api/session-manager/agent/open-requests');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('首次heartbeat写入失败不更新内存scope，任务不会发送，保留旧配置', async () => {
    const config = { ...configuration(), profileNamespace: undefined };
    await cfg.saveConfig(config);
    const before = await fs.readFile(cfg.agentConfigPath(), 'utf8');
    const fetcher = vi.fn().mockImplementation(async () => response({ authorized: true, profileNamespace: withdrawalNamespace }));
    vi.stubGlobal('fetch', fetcher);
    vi.spyOn(fs, 'rename').mockRejectedValue(Object.assign(new Error('synthetic write refused'), { code: 'EACCES' }));
    await expect(agentApi(config, '/api/session-manager/agent/heartbeat', { method: 'POST', body: '{}' })).rejects.toBeInstanceOf(AgentApiError);
    expect(config.profileNamespace).toBeUndefined();
    expect(await fs.readFile(cfg.agentConfigPath(), 'utf8')).toBe(before);
    await expect(agentApi(config, '/api/session-manager/agent/open-requests')).rejects.toMatchObject({ status: 403 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('heartbeat不提供namespace或在线改变用途时拒绝，保留原scope与profiles', async () => {
    const config = configuration();
    const profile = cfg.ensureShopProfile(config, 1, '店铺', 'pdd');
    await cfg.saveConfig(config);
    const before = await fs.readFile(cfg.agentConfigPath(), 'utf8');
    const fetcher = vi.fn().mockResolvedValueOnce(response({ authorized: true }))
      .mockResolvedValueOnce(response({ authorized: true, profileNamespace: mainNamespace }));
    vi.stubGlobal('fetch', fetcher);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(agentApi(config, '/api/session-manager/agent/heartbeat', { method: 'POST', body: '{}' })).rejects.toMatchObject({ status: 403 });
    }
    expect(config.profileNamespace).toBe(withdrawalNamespace);
    expect(await fs.readFile(cfg.agentConfigPath(), 'utf8')).toBe(before);
    expect(cfg.ensureShopProfile(config, 1, '店铺', 'pdd').localProfileId).toBe(profile.localProfileId);
  });

  it('注册未知namespace不覆盖原配置；有效注册保存用途并保留旧Profile条目', async () => {
    const existing = { ...configuration(), privateKeyPem: 'synthetic-private-key', publicKeyPem: 'synthetic-public-key',
      shops: { '1': { storeId: '1', platformCode: 'pdd', localProfileId: 'old-profile' } } };
    await cfg.saveConfig(existing);
    const before = await fs.readFile(cfg.agentConfigPath(), 'utf8');
    const device = { deviceId: 'synthetic-device', deviceCode: 'SYNTHETIC', deviceToken: 'synthetic-token' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response(device))
      .mockResolvedValueOnce(response({ ...device, profileNamespace: 'v1:1:unknown' }))
      .mockResolvedValueOnce(response({ ...device, profileNamespace: mainNamespace })));
    const options = { serverUrl: 'https://oa.example.test', pairingCode: 'ABCDEFGH', name: '合成测试电脑' };
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(registerDevice(options)).rejects.toThrow(/用途/);
      expect(await fs.readFile(cfg.agentConfigPath(), 'utf8')).toBe(before);
    }
    await registerDevice(options);
    const stored = await cfg.loadConfig();
    expect(stored.profileNamespace).toBe(mainNamespace); expect(stored.shops['1']).toEqual(existing.shops['1']);
    expect(stored.deviceToken).toBe(device.deviceToken);
  });

  it('新绑定默认新OA地址且参数与环境优先，加载已有配置不改地址；不发送真实网络请求', async () => {
    const previous = process.env.SESSION_MANAGER_SERVER_URL;
    const existing = { ...configuration(), serverUrl: 'https://already-bound.example.test', privateKeyPem: 'synthetic-private', publicKeyPem: 'synthetic-public' };
    await cfg.saveConfig(existing);
    expect((await cfg.loadConfig()).serverUrl).toBe(existing.serverUrl);
    const fetcher = vi.fn().mockImplementation(async () => response({ deviceId: 'synthetic-device', deviceCode: 'SYNTHETIC', deviceToken: 'synthetic-token', profileNamespace: withdrawalNamespace }));
    vi.stubGlobal('fetch', fetcher);
    try {
      delete process.env.SESSION_MANAGER_SERVER_URL;
      await registerDevice({ pairingCode: 'ABCDEFGH' });
      expect(String(fetcher.mock.calls[0][0])).toBe('https://lc.kudesi.com/api/session-manager/agent/register');
      expect((await cfg.loadConfig()).serverUrl).toBe('https://lc.kudesi.com');
      process.env.SESSION_MANAGER_SERVER_URL = 'https://environment.example.test/';
      await registerDevice({ pairingCode: 'ABCDEFGH' });
      expect(String(fetcher.mock.calls[1][0])).toBe('https://environment.example.test/api/session-manager/agent/register');
      await registerDevice({ pairingCode: 'ABCDEFGH', serverUrl: 'https://explicit.example.test/' });
      expect(String(fetcher.mock.calls[2][0])).toBe('https://explicit.example.test/api/session-manager/agent/register');
    } finally {
      if (previous === undefined) delete process.env.SESSION_MANAGER_SERVER_URL;
      else process.env.SESSION_MANAGER_SERVER_URL = previous;
    }
    const tray = await fs.readFile(path.join(root, 'windows/tray.ps1'), 'utf8');
    expect(tray).toContain('::InputBox("请输入 OA 地址（https://...）", "绑定电脑", "https://lc.kudesi.com/")');
  });
});

describe('可发布旧助手快照完整性', () => {
  it('清单验证全部文件，除8处最小适配之外的浏览器/输入/原生桥接/windows源码逐字保留', async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'snapshot-manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ sourceVersion: '0.3.44', version: '0.3.45' });
    const changed = new Set(['config.js', 'api.js', 'register-device.js', 'open-shop.js', 'sessions.js', 'browser-close-recovery.js', 'version.json', 'windows/tray.ps1']);
    for (const entry of manifest.files) {
      const content = await fs.readFile(path.join(root, entry.snapshot));
      expect(createHash('sha256').update(content).digest('hex')).toBe(entry.sha256);
      expect(entry.modified).toBe(changed.has(entry.snapshot));
      if (!entry.modified) expect(entry.sha256).toBe(entry.sourceSha256);
    }
    expect(manifest.files.filter((entry: { modified: boolean }) => entry.modified)).toHaveLength(8);
    expect(cfg.AGENT_VERSION).toBe('0.3.45');
  });
});
