import * as crypto from 'crypto';
import * as zlib from 'zlib';

/**
 * 助手升级包格式（.kapkg）：gzip 压缩的 JSON，里面是版本号 + 每个文件的路径、sha256 和内容。
 * 不用 zip：Windows 上解 zip 要依赖 PowerShell，这里只用 Node 自带的 zlib，Linux 上也能完整测试。
 * 升级包只允许 dist/ 下的 .js/.json 和 package.json，路径越界、重复、哈希不符一律拒绝。
 * 服务器（apps/api/src/session/agent-package.ts）上传时会按同样规则再检查一遍。
 */
export const BUNDLE_FORMAT = 'kudesi-assistant-package';
export const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
export const MAX_UNPACKED_BYTES = 128 * 1024 * 1024;

export interface BundleFileInput { path: string; data: Buffer }
export interface BundleManifest { format: typeof BUNDLE_FORMAT; formatVersion: 1; version: string; dependencies: Record<string, string>; files: Array<{ path: string; size: number; sha256: string; data: string }> }
export interface DecodedBundle { version: string; dependencies: Record<string, string>; files: Array<{ path: string; data: Buffer; sha256: string }> }

export class BundleError extends Error {
  constructor(message: string, public code: string) { super(message); this.name = 'BundleError'; }
}

export const sha256Hex = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
export const isVersion = (v: unknown): v is string => typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v);

/** 路径必须是 dist/ 下的 .js/.json（或 package.json），不能含 ..、绝对路径、反斜杠、盘符 */
export function isSafeBundlePath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 200) return false;
  if (p.includes('\\') || p.includes(':') || p.startsWith('/') || p.includes('\0')) return false;
  const parts = p.split('/');
  if (parts.some((s) => s === '' || s === '.' || s === '..')) return false;
  if (p === 'package.json') return true;
  return parts[0] === 'dist' && parts.length >= 2 && /\.(js|json)$/.test(p);
}

export function encodeBundle(o: { version: string; dependencies: Record<string, string>; files: BundleFileInput[] }): Buffer {
  if (!isVersion(o.version)) throw new BundleError('版本号格式不对', 'bad_version');
  const seen = new Set<string>();
  const files = o.files.map((f) => {
    if (!isSafeBundlePath(f.path) || seen.has(f.path)) throw new BundleError(`文件路径不合法：${f.path}`, 'bad_path');
    seen.add(f.path);
    return { path: f.path, size: f.data.length, sha256: sha256Hex(f.data), data: f.data.toString('base64') };
  });
  const m: BundleManifest = { format: BUNDLE_FORMAT, formatVersion: 1, version: o.version, dependencies: o.dependencies, files };
  return zlib.gzipSync(Buffer.from(JSON.stringify(m), 'utf8'), { level: 9 });
}

/** 解包并逐文件校验；任何一项不对都抛 BundleError（升级包是“全有或全无”） */
export function decodeBundle(buf: Buffer): DecodedBundle {
  if (buf.length === 0 || buf.length > MAX_PACKAGE_BYTES) throw new BundleError('升级包大小不合法', 'bad_size');
  let raw: Buffer;
  try { raw = zlib.gunzipSync(buf, { maxOutputLength: MAX_UNPACKED_BYTES }); } catch { throw new BundleError('升级包已损坏或不是有效的升级包', 'bad_archive'); }
  let m: Partial<BundleManifest>;
  try { m = JSON.parse(raw.toString('utf8')) as Partial<BundleManifest>; } catch { throw new BundleError('升级包内容无法读取', 'bad_archive'); }
  if (m.format !== BUNDLE_FORMAT || m.formatVersion !== 1) throw new BundleError('不是酷得斯助手升级包', 'bad_format');
  if (!isVersion(m.version)) throw new BundleError('升级包版本号格式不对', 'bad_version');
  if (!Array.isArray(m.files) || m.files.length === 0 || m.files.length > 500) throw new BundleError('升级包文件清单不合法', 'bad_files');
  const deps = m.dependencies && typeof m.dependencies === 'object' ? m.dependencies : {};
  const seen = new Set<string>();
  const files = m.files.map((f) => {
    if (!f || !isSafeBundlePath(f.path) || seen.has(f.path)) throw new BundleError(`升级包含有不允许的文件：${String(f?.path)}`, 'bad_path');
    seen.add(f.path);
    if (typeof f.data !== 'string' || typeof f.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(f.sha256)) throw new BundleError(`文件 ${f.path} 的记录不合法`, 'bad_files');
    const data = Buffer.from(f.data, 'base64');
    if (data.length !== f.size || sha256Hex(data) !== f.sha256) throw new BundleError(`文件 ${f.path} 校验失败`, 'file_hash');
    return { path: f.path, data, sha256: f.sha256 };
  });
  if (!seen.has('dist/cli.js') || !seen.has('dist/main.js') || !seen.has('package.json')) throw new BundleError('升级包缺少助手主程序', 'missing_entry');
  return { version: m.version, dependencies: deps as Record<string, string>, files };
}
