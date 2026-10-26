import * as fsp from 'fs/promises';
import * as path from 'path';
import { BundleError, decodeBundle, isVersion, sha256Hex, MAX_PACKAGE_BYTES } from './bundle';
import { HEALTHY_FILE, RESTART_EXIT_CODE, RESULT_FILE, readState, versionDir, writeState, type LauncherState, type UpdateResult } from './launcher';

/**
 * 助手自更新（对应旧系统 online-update.js + apply-update.ps1 的行为，换成这一版的做法）：
 * 心跳里看到比自己新的目标版本 → 下载 → 校验大小和 SHA-256 → 解包校验每个文件 → 放进 versions/<新版本> →
 * 把 update-state.json 切到“试运行”并让进程以 75 退出 → 启动器拉起新版本；新版本连上 OA 后写 healthy.json 才算成功，
 * 否则启动器回退到旧版本，旧版本启动后把“已回退”报告给 OA。
 * 全程每一步都向 OA 回报（update_status）；任何失败都不会动当前正在运行的版本。
 */
export { RESTART_EXIT_CODE };

export type UpdateStatus = 'downloading' | 'verifying' | 'staged' | 'applying' | 'restarting' | 'failed' | 'rolled_back';
export interface UpdateInfo { targetVersion: string; sha256?: string; size?: number }
export interface DownloadResponse { status: number; headers: { get(name: string): string | null }; body: AsyncIterable<Uint8Array> | null }
export interface UpdaterDeps {
  /** 安装根目录（启动器设置的 KUDESI_AGENT_ROOT）；没有说明不是按自更新方式安装的 */
  root: string | null;
  currentVersion: string;
  /** 当前版本 package.json 里的 dependencies：新版依赖变了就不能热更新（node_modules 在安装时装好） */
  dependencies: Record<string, string>;
  fs: Pick<typeof fsp, 'readFile' | 'writeFile' | 'rename' | 'rm' | 'readdir' | 'mkdir' | 'access'>;
  download(version: string): Promise<DownloadResponse>;
  report(version: string, status: UpdateStatus, extra?: { errorCode?: string; errorText?: string }): Promise<void>;
  log(line: string): void;
  now(): number;
}

export class UpdateError extends Error {
  constructor(message: string, public code: string) { super(message); this.name = 'UpdateError'; }
}

export function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
/** 版本号比较；任一方格式不对返回 NaN（调用方按“不升级”处理） */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return NaN;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}
export const isNewer = (target: string, current: string) => compareVersions(target, current) > 0;

/** 回报给 OA 的文字不带本机路径和多行堆栈 */
const clean = (s: string) => s.replace(/[A-Za-z]:\\[^\s'"]*/g, '<路径>').replace(/\/(?:home|Users|tmp|var)\/[^\s'"]*/g, '<路径>').replace(/\s+/g, ' ').trim().slice(0, 280);

async function readAll(d: UpdaterDeps, res: DownloadResponse, info: Required<Pick<UpdateInfo, 'size'>>): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared !== info.size) throw new UpdateError('安装包大小与 OA 登记的不一致', 'size_mismatch');
  if (!res.body) throw new UpdateError('下载响应为空', 'download_failed');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of res.body) {
    total += c.length;
    if (total > info.size || total > MAX_PACKAGE_BYTES) throw new UpdateError('安装包比登记的大小更大，已中止', 'size_mismatch');
    chunks.push(Buffer.from(c));
  }
  if (total !== info.size) throw new UpdateError('安装包下载不完整', 'download_incomplete');
  return Buffer.concat(chunks);
}

/** 下载 + 校验（大小、SHA-256、服务器随响应给的校验头） */
export async function downloadAndVerify(d: UpdaterDeps, info: UpdateInfo & { sha256: string; size: number }): Promise<Buffer> {
  const res = await d.download(info.targetVersion);
  if (res.status !== 200) throw new UpdateError(`下载安装包失败（服务器返回 ${res.status}）`, 'download_failed');
  const header = res.headers.get('x-checksum-sha256');
  if (header && header.toLowerCase() !== info.sha256.toLowerCase()) throw new UpdateError('服务器随安装包给的校验值与心跳登记的不一致', 'hash_mismatch');
  const buf = await readAll(d, res, { size: info.size });
  if (sha256Hex(buf) !== info.sha256.toLowerCase()) throw new UpdateError('安装包 SHA-256 校验失败，已丢弃', 'hash_mismatch');
  return buf;
}

const sameDeps = (a: Record<string, string>, b: Record<string, string>) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/** 解包并放进 versions/<版本>：先写临时目录再改名，半路失败不留下半个版本 */
export async function stageBundle(d: UpdaterDeps, buf: Buffer, target: string): Promise<string> {
  if (!d.root) throw new UpdateError('不是自更新安装', 'not_managed');
  let bundle;
  try { bundle = decodeBundle(buf); } catch (e) { throw new UpdateError((e as BundleError).message, (e as BundleError).code ?? 'bad_package'); }
  if (bundle.version !== target) throw new UpdateError(`安装包里的版本是 ${bundle.version}，不是要升级的 ${target}`, 'version_mismatch');
  if (!sameDeps(bundle.dependencies, d.dependencies)) throw new UpdateError('新版本需要更新运行依赖，不能自动升级，请在这台电脑重新运行安装脚本', 'deps_changed');
  const final = versionDir(d.root, target);
  const tmp = `${final}.staging`;
  await d.fs.rm(tmp, { recursive: true, force: true });
  try {
    for (const f of bundle.files) {
      const dest = path.join(tmp, ...f.path.split('/'));
      if (path.relative(tmp, dest).startsWith('..')) throw new UpdateError('升级包路径越界', 'bad_path'); // 双保险：decodeBundle 已拒绝
      await d.fs.mkdir(path.dirname(dest), { recursive: true });
      await d.fs.writeFile(dest, f.data);
    }
    await d.fs.rm(final, { recursive: true, force: true });
    await d.fs.rename(tmp, final);
  } catch (e) {
    await d.fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
  return final;
}

/** 切到新版本并进入试运行；调用后进程应以 75 退出，由启动器拉起新版本 */
export async function activate(d: UpdaterDeps, target: string): Promise<void> {
  const st = await readState({ fs: d.fs, root: d.root! });
  if (!st) throw new UpdateError('找不到安装状态文件，请重新运行安装脚本', 'not_managed');
  if (st.current !== d.currentVersion) throw new UpdateError('本机安装状态与正在运行的版本不一致', 'state_mismatch');
  const next: LauncherState = { current: target, previous: d.currentVersion, trial: true, trialStartedAt: new Date(d.now()).toISOString(), bad: st.bad };
  await writeState({ fs: d.fs, root: d.root! }, next);
}

export type UpdateOutcome = 'restart' | 'skipped' | 'failed';

/** 完整的一次升级；失败时向 OA 回报并清理，当前版本不受影响 */
export async function runUpdate(d: UpdaterDeps, info: UpdateInfo): Promise<UpdateOutcome> {
  const target = info.targetVersion;
  const fail = async (code: string, text: string): Promise<UpdateOutcome> => {
    d.log(`升级到 ${target} 失败（${code}）：${text}`);
    await d.report(target, 'failed', { errorCode: code, errorText: clean(text) }).catch((e) => d.log(`回报失败状态时出错：${(e as Error).message}`));
    return 'failed';
  };
  if (!isVersion(target) || !isNewer(target, d.currentVersion)) return 'skipped';
  if (!d.root) return fail('not_managed', '这台电脑的助手不是按自动更新方式安装的，请重新运行安装脚本');
  if (!info.sha256 || !/^[a-f0-9]{64}$/i.test(info.sha256) || !info.size || info.size <= 0) return fail('no_package', `OA 上还没有 ${target} 版的安装包，请管理员先上传`);
  const st = await readState({ fs: d.fs, root: d.root });
  if (st?.bad?.includes(target)) return fail('known_bad', `${target} 版曾在这台电脑启动失败并已回退，不再自动重试，请联系管理员发布更高版本`);
  const full = { ...info, sha256: info.sha256, size: info.size };
  try {
    await d.report(target, 'downloading');
    const buf = await downloadAndVerify(d, full);
    await d.report(target, 'verifying');
    await stageBundle(d, buf, target);
    await d.report(target, 'staged');
  } catch (e) {
    if (d.root) await d.fs.rm(`${versionDir(d.root, target)}.staging`, { recursive: true, force: true }).catch(() => undefined);
    const ue = e as UpdateError;
    return fail(ue.code ?? 'update_failed', ue.message || '升级失败');
  }
  try {
    await d.report(target, 'applying');
    await activate(d, target);
  } catch (e) {
    await d.fs.rm(versionDir(d.root, target), { recursive: true, force: true }).catch(() => undefined);
    const ue = e as UpdateError;
    return fail(ue.code ?? 'apply_failed', ue.message || '切换版本失败');
  }
  await d.report(target, 'restarting').catch(() => undefined);
  d.log(`已切换到 ${target}，重启助手`);
  return 'restart';
}

/** 启动后：把启动器留下的“新版本启动失败，已回退”报告给 OA */
export async function reportPendingResult(d: UpdaterDeps): Promise<UpdateResult | null> {
  if (!d.root) return null;
  const file = path.join(d.root, RESULT_FILE);
  let r: UpdateResult;
  try { r = JSON.parse(await d.fs.readFile(file, 'utf8') as string) as UpdateResult; } catch { return null; }
  if (r?.status !== 'rolled_back' || !isVersion(r.failedVersion)) { await d.fs.rm(file, { force: true }).catch(() => undefined); return null; }
  await d.report(r.failedVersion, 'rolled_back', { errorCode: 'rolled_back', errorText: clean(`新版本启动失败，已回退到 ${r.restoredVersion ?? '旧版本'}：${r.reason}`) });
  await d.fs.rm(file, { force: true });
  return r;
}

/** 连上 OA 后写“健康”标记，启动器据此结束试运行 */
export async function markHealthy(d: Pick<UpdaterDeps, 'root' | 'currentVersion' | 'fs' | 'now'>): Promise<void> {
  if (!d.root) return;
  await d.fs.writeFile(path.join(d.root, HEALTHY_FILE), JSON.stringify({ version: d.currentVersion, at: new Date(d.now()).toISOString() }), 'utf8');
}

/** 主循环用：一次只跑一个升级，失败后同一目标版本 10 分钟内不再尝试（避免心跳反复触发下载） */
export class UpdateController {
  private running = false;
  private cooldown = new Map<string, number>();
  constructor(private readonly d: UpdaterDeps, private readonly cooldownMs = 10 * 60_000) {}
  get active() { return this.running; }
  async handle(info: UpdateInfo): Promise<'restart' | null> {
    if (this.running) return null;
    const until = this.cooldown.get(info.targetVersion);
    if (until && this.d.now() < until) return null;
    this.running = true;
    try {
      const r = await runUpdate(this.d, info);
      if (r === 'failed') this.cooldown.set(info.targetVersion, this.d.now() + this.cooldownMs);
      return r === 'restart' ? 'restart' : null;
    } catch (e) {
      this.d.log(`升级异常：${(e as Error).message}`);
      this.cooldown.set(info.targetVersion, this.d.now() + this.cooldownMs);
      return null;
    } finally { this.running = false; }
  }
}
