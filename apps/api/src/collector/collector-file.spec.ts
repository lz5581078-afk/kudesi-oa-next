import { mkdtemp, readFile, readdir, rm, writeFile, utimes } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { CryptoService } from '../common/crypto.service';
import { CollectorService } from './collector.service';
import { CollectorFileService } from './collector-file.service';

function wav() {
  const b = Buffer.alloc(32044); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(32000, 40); return b;
}
const rid = '11111111-1111-4111-8111-111111111111';
const response = (code = '20000000', body: any = {}) => new Response(JSON.stringify(body), { headers: { 'X-Api-Status-Code': code } });
describe('录音文件2.0真实提交/查询协议与临时音频边界', () => {
  let root: string, service: CollectorFileService, clock: number;
  const key = 'test-server-only-secret';
  const crypto = new CryptoService({ test: Buffer.alloc(32, 5) }, 'test');
  const settings = { read: jest.fn(async () => ({ apiKey: key, enabled: true, fileEnabled: true, realtimeEnabled: true, maxConcurrent: 1 })) };
  let collector: CollectorService;
  function make(fetcher: typeof fetch) { return new CollectorFileService(collector, crypto, { root, origin: 'https://oa.test', fetcher, now: () => clock }); }
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'speech2-')); clock = Date.now(); collector = new CollectorService(settings as any); });
  afterEach(async () => { service?.onModuleDestroy(); await rm(root, { recursive: true, force: true }); });
  it('仅音频经限时链接提供给2.0；处理/排队保持任务，完成返回原生时间且清理缓存', async () => {
    const calls: any[] = []; let audioToken = '';
    const fake = jest.fn(async (url, init) => { calls.push({ url, ...init }); const body = JSON.parse(init!.body as string);
      if (String(url).endsWith('/submit')) { audioToken = body.audio.url.split('/').pop(); return response(); }
      if (calls.length === 2) return response('20000002');
      return response('20000000', { secret: key, result: { text: '测试原话', utterances: [{ text: '测试原话', start_time: 100, end_time: 900, secret: key }] } });
    }) as typeof fetch;
    service = make(fake);
    const task = await service.start(10, 3, wav().toString('base64'), ['商品甲'], rid);
    expect(calls[0].url).toBe('https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit');
    expect(calls[0].headers['X-Api-Resource-Id']).toBe('volc.seedasr.auc');
    const sent = JSON.parse(calls[0].body); expect(sent.user.uid).toBe('oa-10-3'); expect(sent.audio.data).toBeUndefined();
    expect(sent.request.enable_ddc).toBe(false); expect(sent.request.show_utterances).toBe(true);
    expect(sent.audio.url.startsWith('https://oa.test/api/collector/audio/')).toBe(true);
    expect(await service.audio(audioToken)).toEqual(wav());
    const cached = await readFile(join(root, (await readdir(root))[0]), 'utf8');
    expect(cached).not.toContain(key); expect(cached).not.toContain(wav().toString('base64'));
    expect(await service.query(10, 3, task.taskToken)).toMatchObject({ state: 'queued', taskToken: task.taskToken });
    const done = await service.query(10, 3, task.taskToken); expect(done).toMatchObject({ state: 'done', result: { utterances: [{ start_time: 100, end_time: 900 }] } });
    expect(JSON.stringify([task, done])).not.toContain(key); expect(calls[1].headers['X-Api-Request-Id']).toBe(calls[0].headers['X-Api-Request-Id']);
    expect(calls[1].url).toBe('https://openspeech.bytedance.com/api/v3/auc/bigmodel/query'); expect(await readdir(root)).toEqual([]);
  });
  it('网络不确定与重复上传不重复提交；服务重启后原任务仍可查询', async () => {
    const submit = jest.fn(async () => { throw Error(key); }); service = make(submit as typeof fetch);
    const first = await service.start(10, 3, wav().toString('base64'), [], rid);
    const again = await service.start(10, 3, wav().toString('base64'), [], rid);
    expect(submit).toHaveBeenCalledTimes(1); expect(first.state).toBe('processing'); expect(again.state).toBe('processing');
    service.onModuleDestroy(); service = make(jest.fn(async () => response('20000003')) as typeof fetch);
    expect(await service.query(10, 3, first.taskToken)).toEqual({ state: 'done', result: { text: '', utterances: [] } });
  });
  it('任务仅本人本公司可查，篡改/过期/用途混用均拒绝且不触发供应商', async () => {
    const fake = jest.fn(async () => response()); service = make(fake as typeof fetch);
    const task = await service.start(10, 3, wav().toString('base64'), [], rid);
    await expect(service.query(20, 3, task.taskToken)).rejects.toThrow('其他员工');
    await expect(service.query(10, 4, task.taskToken)).rejects.toThrow('其他员工');
    await expect(service.audio(task.taskToken)).rejects.toThrow('过期');
    // 改动真实密文字节；改外层base64末尾可能只改到被解码器忽略的填充，样本并未篡改密文。
    const envelope = Buffer.from(task.taskToken, 'base64url').toString().split(':');
    const ciphertext = Buffer.from(envelope[4], 'base64');
    ciphertext[0] ^= 1;
    envelope[4] = ciphertext.toString('base64');
    const tampered = Buffer.from(envelope.join(':')).toString('base64url');
    await expect(service.query(10, 3, tampered)).rejects.toThrow();
    clock += 4 * 3600000 + 1;
    await expect(service.query(10, 3, task.taskToken)).rejects.toThrow('过期'); expect(fake).toHaveBeenCalledTimes(1);
  });
  it('供应商403给出2.0未授权原因，不泄露原始响应、密钥，释放公司槽位', async () => {
    const fake = jest.fn(async () => new Response(key, { status: 403, headers: { 'X-Api-Status-Code': '45000030' } }));
    service = make(fake as typeof fetch);
    await expect(service.start(10, 3, wav().toString('base64'), [], rid)).rejects.toThrow('2.0 未获授权');
    expect(fake).toHaveBeenCalledTimes(1); expect(await readdir(root)).toEqual([]); expect(() => collector.acquire(10, 1)()).not.toThrow();
  });
  it('格式和热词无效不上传，查询失败保留临时音频且不自动再提交', async () => {
    const fake = jest.fn(async () => response()); service = make(fake as typeof fetch);
    await expect(service.start(10, 3, 'invalid', [], rid)).rejects.toThrow();
    await expect(service.start(10, 3, wav().toString('base64'), ['x'.repeat(300)], rid)).rejects.toThrow();
    expect(fake).not.toHaveBeenCalled(); const task = await service.start(10, 3, wav().toString('base64'), [], rid);
    fake.mockImplementationOnce(async () => { throw Error(key); });
    await expect(service.query(10, 3, task.taskToken)).rejects.toThrow('查询暂时中断'); expect(await readdir(root)).toHaveLength(1);
  });
  it('只清理过期的本功能缓存，保留无关文件及未过期音频', async () => {
    service = make(jest.fn(async () => response()) as typeof fetch);
    await service.start(10, 3, wav().toString('base64'), [], rid);
    const file = (await readdir(root))[0]; await writeFile(join(root, 'unrelated.txt'), '保留');
    await service.cleanup(); expect(await readdir(root)).toContain(file);
    await utimes(join(root, file), new Date(0), new Date(0)); await service.cleanup();
    expect(await readdir(root)).toEqual(['unrelated.txt']);
  });
});
