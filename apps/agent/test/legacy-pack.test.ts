import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const require = createRequire(import.meta.url);
const pack = require('../scripts/pack-legacy.cjs');
let temporary: string, root: string;
beforeEach(() => { temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kudesi-pack-test-')); root = path.join(temporary, 'package'); fs.mkdirSync(root); });
afterEach(() => {
  if (path.dirname(path.resolve(temporary)) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith('kudesi-pack-test-')) throw new Error('Unexpected test cleanup path');
  fs.rmSync(temporary, { recursive: true });
});
const fixture = () => {
  fs.mkdirSync(path.join(root, 'app'));
  const source = Buffer.from('module.exports = 1;\n');
  fs.writeFileSync(path.join(root, 'app/example.js'), source);
  fs.writeFileSync(path.join(root, 'core-manifest.json'), JSON.stringify({ product: 'SessionManagerAgent', platform: 'win32-x64', version: '0.3.45', files: { 'app/example.js': pack.sha256(source) } }));
};

describe('旧助手独立打包验证', () => {
  it('拒绝目录穿越、盘符、登录态与敏感路径', () => {
    for (const value of ['../secret', '/absolute', 'C:/agent', 'app\\agent.json', 'app/profiles/p1', 'app/agent.json', 'app/private-key.pem', 'app/.env']) expect(() => pack.safeRelative(value)).toThrow();
    expect(pack.safeRelative('app/runtime/node/node.exe')).toBe('app/runtime/node/node.exe');
  });
  it('完整文件集与真实SHA都必须符合清单，改一个字节即拒绝', () => {
    fixture(); expect(pack.verifyCoreTree(root, '0.3.45').fileCount).toBe(2);
    fs.appendFileSync(path.join(root, 'app/example.js'), 'tampered');
    expect(() => pack.verifyCoreTree(root, '0.3.45')).toThrow(/checksum mismatch/);
  });
  it('不接受清单外额外文件或错误产品版本', () => {
    fixture(); expect(() => pack.verifyCoreTree(root, '0.3.44')).toThrow(/identity/);
    fs.writeFileSync(path.join(root, 'app/extra.js'), 'x');
    expect(() => pack.verifyCoreTree(root, '0.3.45')).toThrow(/file set/);
  });
  it('即使文件摘要匹配，也拒绝包内私钥材料', () => {
    fixture(); const source = Buffer.from('-----BEGIN PRIVATE KEY-----\nsynthetic-not-a-real-key');
    fs.writeFileSync(path.join(root, 'app/example.js'), source);
    fs.writeFileSync(path.join(root, 'core-manifest.json'), JSON.stringify({ product: 'SessionManagerAgent', platform: 'win32-x64', version: '0.3.45', files: { 'app/example.js': pack.sha256(source) } }));
    expect(() => pack.verifyCoreTree(root, '0.3.45')).toThrow(/Private key/);
  });
  it('拒绝包内链接，不沿链接读取其他目录', () => {
    const outside = path.join(temporary, 'outside'); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');
    expect(() => pack.walk(root)).toThrow(/link/);
  });
  it('PS5.1封装只补一次UTF-8 BOM，正文逐字不变', () => {
    const source = Buffer.from('Write-Host "合成测试"\r\n', 'utf8');
    const encoded = pack.ps1Bytes(source);
    expect(encoded.subarray(0, 3).toString('hex')).toBe('efbbbf');
    expect(pack.stripBom(encoded).equals(source)).toBe(true);
    expect(pack.ps1Bytes(encoded).equals(encoded)).toBe(true);
  });
  it('输出总是全新目录，不覆盖既有包', () => {
    const release = path.join(temporary, 'release'); fs.mkdirSync(release);
    fs.writeFileSync(path.join(release, 'existing.exe'), 'keep');
    const a = pack.freshOutput(release, '0.3.45'), b = pack.freshOutput(release, '0.3.45');
    expect(a).not.toBe(b); expect(fs.readFileSync(path.join(release, 'existing.exe'), 'utf8')).toBe('keep');
    expect(() => pack.freshOutput(release, '../escape')).toThrow();
  });
  it('当前源码37份快照及版本清单逐项校验通过', () => {
    const snapshot = pack.verifySnapshot(path.resolve(__dirname, '../legacy-runtime'));
    expect(snapshot.manifest.version).toBe('0.3.45'); expect(snapshot.manifest.files).toHaveLength(37);
  });
});
