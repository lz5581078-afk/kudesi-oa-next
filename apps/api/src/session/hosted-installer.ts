import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
/** Operator-published program assets only; no company credentials or profile files are embedded. */
export function hostedInstaller(version: string, packageSha256: string, root = process.env.KUDESI_AGENT_INSTALLER_DIR) {
  if (!root) return null;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new ConflictException('安装包版本无效');
  let manifest: { version: string; packageSha256: string; sha256: string };
  try {
    const file = join(root, `${version}.json`), stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw Error();
    manifest = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ConflictException('安装包清单校验失败，请联系管理员');
  }
  // Other companies may publish a different package under the same version; retain their own ZIP installer.
  if (manifest.packageSha256 !== packageSha256) return null;
  try {
    if (manifest.version !== version || !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw Error();
    const filename = `KudesiAssistant-Setup-${version}.exe`, file = join(root, filename), stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 64 || stat.size > 64 * 1024 * 1024) throw Error();
    const buf = readFileSync(file);
    if (buf.toString('ascii', 0, 2) !== 'MZ' || createHash('sha256').update(buf).digest('hex') !== manifest.sha256) throw Error();
    return { version, filename, contentType: 'application/octet-stream', sha256: manifest.sha256, buf };
  } catch { throw new ConflictException('EXE 安装包完整性校验失败，请联系管理员'); }
}
