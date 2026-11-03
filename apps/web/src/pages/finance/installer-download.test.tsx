import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sessionApi } from './sessionApi';
const bytes = Buffer.from('MZ synthetic public installer fixture');
const sha = createHash('sha256').update(bytes).digest('hex');
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('crypto',{subtle:{digest: (algorithm: string, data: ArrayBuffer) => webcrypto.subtle.digest(algorithm, Buffer.from(new Uint8Array(data)))}});
  vi.stubGlobal('URL',Object.assign(class extends URL {},{createObjectURL:vi.fn(()=> 'blob:installer-test'),revokeObjectURL:vi.fn()}));
  vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>undefined);
});
afterEach(() => { vi.runOnlyPendingTimers();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals(); });
it('EXE通过摘要校验后按正确文件名下载', async () => {
  vi.stubGlobal('fetch',vi.fn(async(path:string)=>path.endsWith('/engine')?new Response(JSON.stringify({engine:'native'}),{headers:{'content-type':'application/json'}}):new Response(bytes,{headers:{'X-Checksum-SHA256':sha,'Content-Disposition':'attachment; filename="KudesiAssistant-Setup-1.2.1.exe"'}})));
  expect(await sessionApi.downloadInstaller()).toBe('KudesiAssistant-Setup-1.2.1.exe');
  expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
  const anchor=vi.mocked(HTMLAnchorElement.prototype.click).mock.contexts[0] as HTMLAnchorElement;
  expect(anchor.download).toBe('KudesiAssistant-Setup-1.2.1.exe');
});
it('摘要错误时拒绝保存安装程序', async () => {
  vi.stubGlobal('fetch',vi.fn(async(path:string)=>path.endsWith('/engine')?new Response(JSON.stringify({engine:'native'}),{headers:{'content-type':'application/json'}}):new Response(bytes,{headers:{'X-Checksum-SHA256':'0'.repeat(64),'Content-Disposition':'attachment; filename="malicious.exe"'}})));
  await expect(sessionApi.downloadInstaller()).rejects.toThrow('完整性');
  expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
});
