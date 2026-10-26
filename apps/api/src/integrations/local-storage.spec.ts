import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { LocalStorage } from './local-storage';

describe('私有文件存储', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'oa-files-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const key = 'oa/1/qualifications/202610/01234567-abcd-1234-abcd-012345678901.png';
  it('签名包含完整文件路径；拒绝篡改及过期访问', async () => {
    let now = 1793000000000;
    const store = new LocalStorage(root, 'test-signing-key-that-is-long-enough', () => now);
    await store.upload(key, Buffer.from('test'));
    const u = new URL(store.downloadUrl(key), 'https://example.test');
    const token = u.pathname.split('/').pop()!, expires = u.searchParams.get('expires')!, sig = u.searchParams.get('signature')!;
    expect((await store.readSigned(token, expires, sig)).toString()).toBe('test');
    await expect(store.readSigned(token, expires, '0'.repeat(64))).rejects.toThrow();
    await expect(store.readSigned(Buffer.from(key.replace('/1/', '/2/')).toString('base64url'), expires, sig)).rejects.toThrow();
    now += 301000;
    await expect(store.readSigned(token, expires, sig)).rejects.toThrow();
  });
  it('拒绝路径穿越、覆盖及无配置启动', async () => {
    const store = new LocalStorage(root, 'test-signing-key-that-is-long-enough');
    await expect(store.upload('../escape', Buffer.from('x'))).rejects.toThrow();
    await store.upload(key, Buffer.from('a'));
    await expect(store.upload(key, Buffer.from('b'))).rejects.toThrow();
    expect(() => new LocalStorage(root, '')).toThrow();
  });
});
