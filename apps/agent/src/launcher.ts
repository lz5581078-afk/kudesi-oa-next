#!/usr/bin/env node
/**
 * 助手启动器：开机任务运行的是它，不是助手本身。
 * 它只用 Node 自带模块（安装时单独复制到安装根目录，升级包不会改它），负责：
 *   - 按 update-state.json 启动当前版本（versions/<版本>/dist/cli.js run）；
 *   - 新版本“试运行”：要在限定时间内写出 healthy.json（助手连上 OA 后才写），否则杀掉并回退到上一个版本；
 *   - 助手异常退出自动重启（逐步放慢）；退出码 75 = 助手要求立刻重启（升级换版本）；退出码 0 = 正常停止，启动器也退出。
 * 换版本只是改一个小文件，不移动正在运行的程序文件，所以 Windows 上不会遇到“文件被占用”。
 */
import * as childProcess from 'child_process';
import * as fsp from 'fs/promises';
import * as path from 'path';

export const RESTART_EXIT_CODE = 75;
export const TRIAL_MS = 120_000;
export const STATE_FILE = 'update-state.json';
export const HEALTHY_FILE = 'healthy.json';
export const RESULT_FILE = 'update-result.json';

export interface LauncherState { current: string; previous: string | null; trial: boolean; trialStartedAt?: string; bad?: string[] }
export interface UpdateResult { status: 'rolled_back'; failedVersion: string; restoredVersion: string | null; reason: string; at: string }
export interface ChildHandle { exited: Promise<number | null>; kill(signal?: NodeJS.Signals): void }
export interface LauncherDeps {
  root: string;
  fs: Pick<typeof fsp, 'readFile' | 'writeFile' | 'rename' | 'rm' | 'readdir' | 'mkdir' | 'access'>;
  spawn(entry: string, cwd: string, env: NodeJS.ProcessEnv): ChildHandle;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  trialMs?: number;
  stopSignal?: { stopped: boolean };
}

const j = (root: string, ...p: string[]) => path.join(root, ...p);
export const versionDir = (root: string, v: string) => j(root, 'versions', v);
export const entryOf = (root: string, v: string) => j(versionDir(root, v), 'dist', 'cli.js');

async function writeJsonAtomic(d: Pick<LauncherDeps, 'fs'>, file: string, value: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  await d.fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  let last: unknown;
  for (let i = 0; i < 6; i++) {
    try { await d.fs.rename(tmp, file); return; } catch (e) { last = e; await new Promise((r) => setTimeout(r, 30 * (i + 1))); }
  }
  await d.fs.rm(tmp, { force: true }).catch(() => undefined);
  throw last;
}

export async function readState(d: Pick<LauncherDeps, 'fs' | 'root'>): Promise<LauncherState | null> {
  try {
    const s = JSON.parse(await d.fs.readFile(j(d.root, STATE_FILE), 'utf8') as string) as LauncherState;
    return s && typeof s.current === 'string' ? { current: s.current, previous: s.previous ?? null, trial: !!s.trial, trialStartedAt: s.trialStartedAt, bad: s.bad ?? [] } : null;
  } catch { return null; }
}
export const writeState = (d: Pick<LauncherDeps, 'fs' | 'root'>, s: LauncherState) => writeJsonAtomic(d, j(d.root, STATE_FILE), s);

async function readHealthy(d: LauncherDeps): Promise<{ version: string; at: string } | null> {
  try { return JSON.parse(await d.fs.readFile(j(d.root, HEALTHY_FILE), 'utf8') as string); } catch { return null; }
}

/** 只保留当前和上一个版本，其余版本目录删掉 */
export async function pruneVersions(d: Pick<LauncherDeps, 'fs' | 'root'>, keep: Array<string | null>): Promise<void> {
  const dir = j(d.root, 'versions');
  const names = await d.fs.readdir(dir).catch(() => [] as string[]);
  for (const n of names) if (!keep.includes(n)) await d.fs.rm(j(dir, n), { recursive: true, force: true }).catch(() => undefined);
}

/** 试运行失败：回到上一个版本，记下失败原因（助手下次启动后报告给 OA） */
export async function rollback(d: LauncherDeps, s: LauncherState, reason: string): Promise<LauncherState> {
  const restored = s.previous;
  const res: UpdateResult = { status: 'rolled_back', failedVersion: s.current, restoredVersion: restored, reason, at: new Date(d.now()).toISOString() };
  await writeJsonAtomic(d, j(d.root, RESULT_FILE), res);
  d.log(`新版本 ${s.current} 启动失败（${reason}），回退到 ${restored ?? '（无）'}`);
  const next: LauncherState = restored
    ? { current: restored, previous: null, trial: false, bad: [...(s.bad ?? []), s.current] }
    : { ...s, trial: false, bad: [...(s.bad ?? []), s.current] };
  await writeState(d, next);
  await d.fs.rm(j(d.root, HEALTHY_FILE), { force: true }).catch(() => undefined);
  await d.fs.rm(versionDir(d.root, s.current), { recursive: true, force: true }).catch(() => undefined);
  return next;
}

/** 主循环：返回进程退出码 */
export async function supervise(d: LauncherDeps): Promise<number> {
  let fast = 0;
  let child: ChildHandle | null = null;
  const trialMs = d.trialMs ?? TRIAL_MS;
  for (;;) {
    if (d.stopSignal?.stopped) return 0;
    let state = await readState(d);
    if (!state) { d.log('找不到 update-state.json，请重新安装助手'); return 2; }
    let entryOk = true;
    await d.fs.access(entryOf(d.root, state.current)).catch(() => { entryOk = false; });
    if (!entryOk) {
      if (state.trial && state.previous) { state = await rollback(d, state, '新版本文件不完整'); continue; }
      d.log(`版本 ${state.current} 的程序文件不存在，请重新安装助手`);
      return 2;
    }
    const startedAt = d.now();
    if (state.trial) {
      await d.fs.rm(j(d.root, HEALTHY_FILE), { force: true }).catch(() => undefined);
      if (!state.trialStartedAt) { state = { ...state, trialStartedAt: new Date(startedAt).toISOString() }; await writeState(d, state); }
    }
    d.log(`启动助手 ${state.current}${state.trial ? '（试运行）' : ''}`);
    child = d.spawn(entryOf(d.root, state.current), versionDir(d.root, state.current), { ...process.env, KUDESI_AGENT_ROOT: d.root });
    let exitCode: number | null | undefined;
    void child.exited.then((c) => { exitCode = c; });
    if (state.trial) {
      let healthy = false;
      while (exitCode === undefined && d.now() - startedAt < trialMs && !d.stopSignal?.stopped) {
        const h = await readHealthy(d);
        if (h && h.version === state.current) { healthy = true; break; }
        await Promise.race([d.sleep(500), child.exited.then(() => undefined)]);
      }
      if (healthy) {
        await writeState(d, { current: state.current, previous: state.previous, trial: false, bad: state.bad });
        await pruneVersions(d, [state.current, state.previous]);
        d.log(`助手 ${state.current} 试运行成功`);
      } else if (!d.stopSignal?.stopped) {
        const reason = exitCode !== undefined ? `进程在连上 OA 前退出（退出码 ${exitCode ?? '未知'}）` : `${Math.round(trialMs / 1000)} 秒内没有连上 OA`;
        if (exitCode === undefined) { child.kill(); await child.exited.catch(() => undefined); }
        if (state.previous) { await rollback(d, state, reason); continue; }
        d.log('没有可回退的版本，继续运行当前版本');
        await writeState(d, { ...state, trial: false });
      }
    }
    const code = await child.exited;
    if (d.stopSignal?.stopped) return code ?? 0;
    if (code === 0) return 0;
    if (code === RESTART_EXIT_CODE) { fast = 0; continue; }
    fast = d.now() - startedAt < 60_000 ? fast + 1 : 0;
    const wait = Math.min(60_000, 5_000 * 2 ** Math.max(0, fast - 1));
    d.log(`助手异常退出（${code ?? '被终止'}），${Math.round(wait / 1000)} 秒后重启`);
    await d.sleep(wait);
  }
}

export function realSpawn(entry: string, cwd: string, env: NodeJS.ProcessEnv): ChildHandle {
  const cp = childProcess.spawn(process.execPath, [entry, 'run'], { cwd, env, stdio: 'inherit', windowsHide: true });
  const exited = new Promise<number | null>((resolve) => { cp.once('exit', (c) => resolve(c)); cp.once('error', () => resolve(1)); });
  return { exited, kill: (sig = 'SIGKILL') => { try { cp.kill(sig); } catch { /* 已退出 */ } } };
}

async function main() {
  const root = path.resolve(process.env.KUDESI_AGENT_ROOT || __dirname);
  const stop = { stopped: false };
  let current: ChildHandle | null = null;
  const d: LauncherDeps = {
    root, fs: fsp, now: Date.now, trialMs: Number(process.env.KUDESI_AGENT_TRIAL_MS) || undefined, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), stopSignal: stop,
    log: (l) => { const t = `[${new Date().toISOString()}] [启动器] ${l}\n`; process.stdout.write(t); void fsp.appendFile(j(root, 'launcher.log'), t).catch(() => undefined); },
    spawn: (e, c, env) => { current = realSpawn(e, c, env); return current; },
  };
  const onSignal = () => { stop.stopped = true; current?.kill('SIGTERM'); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  process.exitCode = await supervise(d);
}

if (require.main === module) void main();
