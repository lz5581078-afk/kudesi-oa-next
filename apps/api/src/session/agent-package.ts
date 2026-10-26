import { BadRequestException } from '@nestjs/common';
import * as crypto from 'crypto';
import * as zlib from 'zlib';

/**
 * 助手升级包（.kapkg）的服务器端检查，规则和 apps/agent/src/bundle.ts 一致：
 * gzip JSON，版本号 + 每个文件的路径/大小/sha256/内容；路径只允许 dist/ 下的 .js/.json 与 package.json。
 * 上传时服务器自己解包校验，版本号取自包内（不信管理员手填的）。
 */
export const PACKAGE_FORMAT = 'kudesi-assistant-package';
export const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 128 * 1024 * 1024;

export const sha256Hex = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
export const isVersion = (v: unknown): v is string => typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v);

function safePath(p: unknown): boolean {
  if (typeof p !== 'string' || !p || p.length > 200 || p.includes('\\') || p.includes(':') || p.startsWith('/') || p.includes('\0')) return false;
  const parts = p.split('/');
  if (parts.some((s) => s === '' || s === '.' || s === '..')) return false;
  return p === 'package.json' || (parts[0] === 'dist' && parts.length >= 2 && /\.(js|json)$/.test(p));
}

export function inspectPackage(buf: Buffer): { version: string; fileCount: number } {
  if (!buf.length || buf.length > MAX_PACKAGE_BYTES) throw new BadRequestException('升级包大小不合法（不超过 32MB）');
  let m: { format?: string; formatVersion?: number; version?: unknown; files?: Array<{ path?: unknown; size?: unknown; sha256?: unknown; data?: unknown }> };
  try { m = JSON.parse(zlib.gunzipSync(buf, { maxOutputLength: MAX_UNPACKED_BYTES }).toString('utf8')); } catch { throw new BadRequestException('不是有效的助手升级包（请上传 npm run pack 生成的 .kapkg 文件）'); }
  if (m.format !== PACKAGE_FORMAT || m.formatVersion !== 1) throw new BadRequestException('不是酷得斯助手升级包');
  if (!isVersion(m.version)) throw new BadRequestException('升级包里的版本号格式不对');
  if (!Array.isArray(m.files) || !m.files.length || m.files.length > 500) throw new BadRequestException('升级包文件清单不合法');
  const seen = new Set<string>();
  for (const f of m.files) {
    if (!f || !safePath(f.path) || seen.has(f.path as string)) throw new BadRequestException(`升级包含有不允许的文件：${String(f?.path)}`);
    seen.add(f.path as string);
    const data = typeof f.data === 'string' ? Buffer.from(f.data, 'base64') : null;
    if (!data || data.length !== f.size || sha256Hex(data) !== f.sha256) throw new BadRequestException(`升级包内文件 ${String(f.path)} 校验失败，包可能已损坏`);
  }
  for (const need of ['package.json', 'dist/cli.js', 'dist/main.js']) if (!seen.has(need)) throw new BadRequestException('升级包缺少助手主程序');
  return { version: m.version, fileCount: m.files.length };
}
