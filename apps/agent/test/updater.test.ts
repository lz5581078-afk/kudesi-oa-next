import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeBundle, encodeBundle, isSafeBundlePath, sha256Hex } from '../src/bundle';
import { entryOf, readState, supervise, writeState, type ChildHandle, type LauncherDeps } from '../src/launcher';
import { compareVersions, isNewer, markHealthy, reportPendingResult, runUpdate, UpdateController, type UpdateStatus, type UpdaterDeps } from '../src/updater';

const DEPS = { 'playwright-core': '^1.49.0' };
const files = (v: string, extra: Record<string, string> = {}) => [
  { path: 'package.json', data: Buffer.from(JSON.stringify({ version: v, dependencies: DEPS })) },
  { path: 'dist/cli.js', data: Buffer.from(`// cli ${v}`) },
  { path: 'dist/main.js', data: Buffer.from(`// main ${v}`) },
  ...Object.entries(extra).map(([p, c]) => ({ path: p, data: Buffer.from(c) })),
];
const pack = (v: string, deps = DEPS, extra: Record<string, string> = {}) => encodeBundle({ version: v, dependencies: deps, files: files(v, extra) });

describe('版本比较', () => {
  it('按数字比较，不是字符串', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.1.0', '1.1.0')).toBe(0);
    expect(compareVersions('0.9.9', '1.0.0')).toBe(-1);
    expect(isNewer('1.1.1', '1.1.0')).toBe(true);
    expect(isNewer('1.1.0', '1.1.0')).toBe(false);
    expect(isNewer('1.0.9', '1.1.0')).toBe(false);
  });
  it('格式不对一律不升级', () => {
    expect(isNewer('latest', '1.0.0')).toBe(false);
    expect(isNewer('2.0', '1.0.0')).toBe(false);
    expect(isNewer('1.2.3-beta', '1.0.0')).toBe(false);
    expect(isNewer('', '1.0.0')).toBe(false);
  });
});

describe('升级包格式', () => {
  it('编码后能还原，路径白名单', () => {
    const b = decodeBundle(pack('1.2.0'));
    expect(b.version).toBe('1.2.0');
    expect(b.files.map((f) => f.path)).toContain('dist/cli.js');
    for (const bad of ['../x.js', '/etc/passwd', 'dist/../../x.js', 'C:/a.js', 'dist\\a.js', 'node_modules/a.js', 'dist/a.exe', 'dist//a.js']) expect(isSafeBundlePath(bad)).toBe(false);
  });
  it('文件被改动、缺主程序、路径越界、不是升级包都拒绝', () => {
    const zlib = require('zlib') as typeof import('zlib');
    const m = JSON.parse(zlib.gunzipSync(pack('1.2.0')).toString());
    m.files[1].data = Buffer.from('evil').toString('base64');
    expect(() => decodeBundle(zlib.gzipSync(JSON.stringify(m)))).toThrow(/校验失败/);
    expect(() => encodeBundle({ version: '1.2.0', dependencies: {}, files: [{ path: '../x.js', data: Buffer.from('x') }] })).toThrow(/不合法/);
    expect(() => decodeBundle(encodeBundle({ version: '1.2.0', dependencies: {}, files: [{ path: 'package.json', data: Buffer.from('{}') }] }))).toThrow(/缺少助手主程序/);
    expect(() => decodeBundle(Buffer.from('not gzip'))).toThrow(/损坏/);
    expect(() => decodeBundle(zlib.gzipSync('{"format":"x"}'))).toThrow(/不是酷得斯/);
  });
});

describe('下载、校验、暂存、切换', () => {
  let root: string;
  const reports: Array<[string, UpdateStatus, { errorCode?: string; errorText?: string } | undefined]> = [];
  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kudesi-upd-'));
    await fsp.mkdir(path.join(root, 'versions', '1.1.0', 'dist'), { recursive: true });
    await fsp.writeFile(entryOf(root, '1.1.0'), '// old');
    await writeState({ fs: fsp, root }, { current: '1.1.0', previous: null, trial: false, bad: [] });
    reports.length = 0;
  });
  afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

  const mk = (buf: Buffer | null, o: { status?: number; headerSha?: string; lengthLie?: number; managed?: boolean; fs?: UpdaterDeps['fs'] } = {}): UpdaterDeps => ({
    root: o.managed === false ? null : root, currentVersion: '1.1.0', dependencies: DEPS, fs: o.fs ?? fsp, now: () => Date.now(), log: () => undefined,
    report: async (v, s, e) => { reports.push([v, s, e]); },
    download: async () => ({
      status: o.status ?? 200,
      headers: { get: (n: string) => (n === 'x-checksum-sha256' ? o.headerSha ?? (buf ? sha256Hex(buf) : null) : n === 'content-length' ? String(o.lengthLie ?? buf?.length ?? 0) : null) },
      body: buf ? (async function* () { yield buf.subarray(0, 10); yield buf.subarray(10); })() : null,
    }),
  });
  const info = (buf: Buffer, v = '1.2.0') => ({ targetVersion: v, sha256: sha256Hex(buf), size: buf.length });
  const statuses = () => reports.map((r) => r[1]);

  it('正常：下载 → 校验 → 暂存 → 进入试运行并要求重启', async () => {
    const buf = pack('1.2.0');
    expect(await runUpdate(mk(buf), info(buf))).toBe('restart');
    expect(statuses()).toEqual(['downloading', 'verifying', 'staged', 'applying', 'restarting']);
    expect(await fsp.readFile(entryOf(root, '1.2.0'), 'utf8')).toBe('// cli 1.2.0');
    expect(await readState({ fs: fsp, root })).toMatchObject({ current: '1.2.0', previous: '1.1.0', trial: true });
    expect(await fsp.readFile(entryOf(root, '1.1.0'), 'utf8')).toBe('// old'); // 旧版本原样保留
    expect((await fsp.readdir(path.join(root, 'versions'))).sort()).toEqual(['1.1.0', '1.2.0']); // 没有残留 .staging
  });

  it('包被篡改（SHA-256 与登记的不一致）→ 丢弃、不暂存、报告失败', async () => {
    const good = pack('1.2.0'); const evil = Buffer.from(good); evil[evil.length - 12] ^= 0xff; // 同样大小、内容被改
    expect(await runUpdate(mk(evil, { headerSha: sha256Hex(good) }), info(good))).toBe('failed');
    expect(reports.at(-1)).toMatchObject([ '1.2.0', 'failed', { errorCode: 'hash_mismatch' }]);
    expect((await fsp.readdir(path.join(root, 'versions')))).toEqual(['1.1.0']);
    expect(await readState({ fs: fsp, root })).toMatchObject({ current: '1.1.0', trial: false });
  });
  it('服务器响应头的校验值与心跳登记的不同 → 失败', async () => {
    const buf = pack('1.2.0');
    expect(await runUpdate(mk(buf, { headerSha: 'a'.repeat(64) }), info(buf))).toBe('failed');
    expect(reports.at(-1)![2]?.errorCode).toBe('hash_mismatch');
  });
  it('下载不完整 / 大小对不上 / 服务器报错 → 失败', async () => {
    const buf = pack('1.2.0');
    expect(await runUpdate(mk(buf), { ...info(buf), size: buf.length + 5 })).toBe('failed');
    expect(reports.at(-1)![2]?.errorCode).toBe('size_mismatch');
    expect(await runUpdate(mk(buf, { status: 403 }), info(buf))).toBe('failed');
    expect(reports.at(-1)![2]?.errorCode).toBe('download_failed');
  });
  it('包里的版本与目标不符、依赖变了、包内文件损坏 → 失败且不动当前版本', async () => {
    const wrong = pack('1.9.9');
    expect(await runUpdate(mk(wrong), info(wrong, '1.2.0'))).toBe('failed');
    expect(reports.at(-1)![2]?.errorCode).toBe('version_mismatch');
    const deps = pack('1.2.0', { 'playwright-core': '^2.0.0' });
    expect(await runUpdate(mk(deps), info(deps))).toBe('failed');
    expect(reports.at(-1)![2]?.errorCode).toBe('deps_changed');
    expect(await readState({ fs: fsp, root })).toMatchObject({ current: '1.1.0', trial: false });
    expect((await fsp.readdir(path.join(root, 'versions')))).toEqual(['1.1.0']);
  });
  it('暂存写文件中途失败 → 清理半成品，当前版本不变', async () => {
    const buf = pack('1.2.0');
    let n = 0;
    const flaky = { ...fsp, writeFile: (async (...a: Parameters<typeof fsp.writeFile>) => { if (++n === 2) throw new Error('磁盘已满'); return fsp.writeFile(...a); }) } as unknown as UpdaterDeps['fs'];
    expect(await runUpdate(mk(buf, { fs: flaky }), info(buf))).toBe('failed');
    expect((await fsp.readdir(path.join(root, 'versions')))).toEqual(['1.1.0']);
    expect(await readState({ fs: fsp, root })).toMatchObject({ current: '1.1.0', trial: false });
  });
  it('切换状态写不进去 → 删掉新版本目录，失败报告', async () => {
    const buf = pack('1.2.0');
    await fsp.rm(path.join(root, 'update-state.json'));
    expect(await runUpdate(mk(buf), info(buf))).toBe('failed');
    expect(reports.at(-1)![2]?.errorCode).toBe('not_managed');
    expect((await fsp.readdir(path.join(root, 'versions')))).toEqual(['1.1.0']);
  });
  it('不需要升级 / 没有登记安装包 / 曾回退过的版本 / 非自更新安装', async () => {
    const buf = pack('1.2.0');
    expect(await runUpdate(mk(buf), info(buf, '1.1.0'))).toBe('skipped');
    expect(await runUpdate(mk(buf), info(buf, '1.0.5'))).toBe('skipped');
    expect(reports).toHaveLength(0);
    expect(await runUpdate(mk(buf), { targetVersion: '1.2.0' })).toBe('failed');
    expect(reports.at(-1)![2]?.errorCode).toBe('no_package');
    await writeState({ fs: fsp, root }, { current: '1.1.0', previous: null, trial: false, bad: ['1.2.0'] });
    expect(await runUpdate(mk(buf), info(buf))).toBe('failed');
    expect(reports.at(-1)![2]?.errorCode).toBe('known_bad');
    expect(await runUpdate(mk(buf, { managed: false }), info(buf))).toBe('failed');
    expect(reports.at(-1)![2]?.errorCode).toBe('not_managed');
  });
  it('控制器：失败后同一目标版本冷却，不会每次心跳都重新下载', async () => {
    const buf = pack('1.2.0'); let dl = 0;
    const d = mk(buf, { status: 500 }); const orig = d.download; d.download = async (v) => { dl++; return orig(v); };
    const c = new UpdateController(d);
    expect(await c.handle(info(buf))).toBeNull();
    expect(await c.handle(info(buf))).toBeNull();
    expect(dl).toBe(1);
  });
  it('回退结果在下次启动时报告给 OA 并清除；健康标记写入', async () => {
    await fsp.writeFile(path.join(root, 'update-result.json'), JSON.stringify({ status: 'rolled_back', failedVersion: '1.2.0', restoredVersion: '1.1.0', reason: '120 秒内没有连上 OA', at: 'x' }));
    const d = mk(null);
    await reportPendingResult(d);
    expect(reports[0]).toMatchObject(['1.2.0', 'rolled_back', { errorCode: 'rolled_back' }]);
    await expect(fsp.access(path.join(root, 'update-result.json'))).rejects.toThrow();
    await markHealthy(d);
    expect(JSON.parse(await fsp.readFile(path.join(root, 'healthy.json'), 'utf8'))).toMatchObject({ version: '1.1.0' });
  });
});

describe('启动器：试运行与回退', () => {
  let root: string; let clock: number; const logs: string[] = [];
  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kudesi-lau-'));
    for (const v of ['1.1.0', '1.2.0']) { await fsp.mkdir(path.join(root, 'versions', v, 'dist'), { recursive: true }); await fsp.writeFile(entryOf(root, v), v); }
    clock = 1_000_000; logs.length = 0;
  });
  afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

  /** 假子进程：按版本脚本化——退出码 / 是否写健康标记 */
  const plan: Record<string, { code?: number | null; healthy?: boolean; hang?: boolean }> = {};
  const spawned: string[] = [];
  const deps = (): LauncherDeps => ({
    root, fs: fsp, now: () => clock, log: (l) => logs.push(l), trialMs: 5_000,
    sleep: async (ms) => { clock += ms; },
    spawn: (entry) => {
      const v = path.basename(path.dirname(path.dirname(path.dirname(entry)))) === 'versions' ? path.basename(path.dirname(path.dirname(entry))) : '?';
      spawned.push(v);
      const p = plan[v] ?? { code: 0 };
      let resolve!: (c: number | null) => void;
      const exited = new Promise<number | null>((r) => { resolve = r; });
      if (p.healthy) void fsp.writeFile(path.join(root, 'healthy.json'), JSON.stringify({ version: v, at: 'x' }));
      if (!p.hang) setTimeout(() => resolve(p.code ?? 0), p.healthy ? 30 : 0);
      return { exited, kill: () => resolve(null) } as ChildHandle;
    },
  });
  beforeEach(() => { spawned.length = 0; for (const k of Object.keys(plan)) delete plan[k]; });

  it('新版本启动成功（写了健康标记）→ 结束试运行，只保留当前和上一版本', async () => {
    await fsp.mkdir(path.join(root, 'versions', '0.9.0'));
    await writeState({ fs: fsp, root }, { current: '1.2.0', previous: '1.1.0', trial: true });
    plan['1.2.0'] = { healthy: true, code: 0 };
    expect(await supervise(deps())).toBe(0);
    expect(spawned).toEqual(['1.2.0']);
    expect(await readState({ fs: fsp, root })).toMatchObject({ current: '1.2.0', previous: '1.1.0', trial: false });
    expect((await fsp.readdir(path.join(root, 'versions'))).sort()).toEqual(['1.1.0', '1.2.0']);
  });
  it('新版本在连上 OA 前就崩溃 → 回退旧版本、记录失败结果、该版本被列入 bad', async () => {
    await writeState({ fs: fsp, root }, { current: '1.2.0', previous: '1.1.0', trial: true });
    plan['1.2.0'] = { code: 1 };
    plan['1.1.0'] = { code: 0 };
    expect(await supervise(deps())).toBe(0);
    expect(spawned).toEqual(['1.2.0', '1.1.0']);
    expect(await readState({ fs: fsp, root })).toMatchObject({ current: '1.1.0', trial: false, bad: ['1.2.0'] });
    const r = JSON.parse(await fsp.readFile(path.join(root, 'update-result.json'), 'utf8'));
    expect(r).toMatchObject({ status: 'rolled_back', failedVersion: '1.2.0', restoredVersion: '1.1.0' });
    await expect(fsp.access(path.join(root, 'versions', '1.2.0'))).rejects.toThrow();
  });
  it('新版本一直不退出但也不连 OA（卡死）→ 超时杀掉并回退', async () => {
    await writeState({ fs: fsp, root }, { current: '1.2.0', previous: '1.1.0', trial: true });
    plan['1.2.0'] = { hang: true };
    expect(await supervise(deps())).toBe(0);
    expect(spawned).toEqual(['1.2.0', '1.1.0']);
    expect(JSON.parse(await fsp.readFile(path.join(root, 'update-result.json'), 'utf8')).reason).toMatch(/没有连上 OA/);
  });
  it('新版本文件缺失 → 直接回退，不尝试启动', async () => {
    await fsp.rm(path.join(root, 'versions', '1.2.0'), { recursive: true });
    await writeState({ fs: fsp, root }, { current: '1.2.0', previous: '1.1.0', trial: true });
    expect(await supervise(deps())).toBe(0);
    expect(spawned).toEqual(['1.1.0']);
  });
  it('退出码 75 立即重启（升级换版本）；异常退出等待后重启；0 则启动器结束', async () => {
    await writeState({ fs: fsp, root }, { current: '1.1.0', previous: null, trial: false });
    let n = 0;
    const d = deps(); const sp = d.spawn;
    d.spawn = (e, c, env) => { n++; plan['1.1.0'] = { code: n === 1 ? 75 : n === 2 ? 1 : 0 }; return sp(e, c, env); };
    const t0 = clock;
    expect(await supervise(d)).toBe(0);
    expect(n).toBe(3);
    expect(clock - t0).toBe(5_000); // 只有那次异常退出等了 5 秒
  });
  it('没有可回退版本时不会死循环：继续运行当前版本', async () => {
    await writeState({ fs: fsp, root }, { current: '1.2.0', previous: null, trial: true });
    plan['1.2.0'] = { hang: true };
    const d = deps(); const sp = d.spawn;
    const stop = { stopped: false }; d.stopSignal = stop;
    d.spawn = (e, c, env) => { const h = sp(e, c, env); setTimeout(() => { stop.stopped = true; h.kill(); }, 50); return h; };
    await supervise(d);
    expect(await readState({ fs: fsp, root })).toMatchObject({ current: '1.2.0', trial: false });
  });
});
