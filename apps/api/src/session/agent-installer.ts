import { BadRequestException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { gunzipSync } from 'zlib';
import { inspectPackage } from './agent-package';

/** ZIP STORE, UTF-8 names; portable across Windows development and the Linux API. */
function zip(files: Array<{ path: string; data: Buffer }>): Buffer {
  const records: Buffer[] = [], directory: Buffer[] = [];
  let offset = 0;
  for (const { path, data } of files) {
    const name = Buffer.from(path);
    let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const h = Buffer.alloc(30), c = Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x800, 6); h.writeUInt16LE(0x21, 12);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(name.length, 26);
    c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); h.copy(c, 6, 4, 30); c.writeUInt32LE(offset, 42);
    records.push(h, name, data); directory.push(c, name); offset += 30 + name.length + data.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...records, central, end]);
}

/** Use the same installer as apps/agent packaging. No account, device token or profile is embedded. */
export function buildAgentInstaller(packageBuffer: Buffer): { buf: Buffer; version: string } {
  const { version } = inspectPackage(packageBuffer);
  const m = JSON.parse(gunzipSync(packageBuffer, { maxOutputLength: 128 * 1024 * 1024 }).toString('utf8')) as { files: Array<{ path: string; data: string }> };
  const files = m.files.map(f => ({ path: f.path, data: Buffer.from(f.data, 'base64') }));
  const launcher = files.find(f => f.path === 'dist/launcher.js');
  if (!launcher) throw new BadRequestException('升级包缺少 Windows 启动器，请重新打包发布');
  files.push({ path: 'launcher.js', data: launcher.data });
  const templates = resolve(__dirname, '../../../agent/windows');
  for (const path of ['install.ps1', 'uninstall.ps1', 'README.txt']) files.push({ path, data: readFileSync(resolve(templates, path)) });
  return { version, buf: zip(files) };
}
