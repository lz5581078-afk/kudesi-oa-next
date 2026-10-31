import { EventEmitter } from 'events';
import { BadGatewayException } from '@nestjs/common';
import { CryptoService } from '../common/crypto.service';
import { SpeechSettingsService } from './speech-settings.service';
import { CollectorService } from './collector.service';
import { cleanWords, decodeFrame, encodeFrame, pcmWav, safeResult } from './speech-protocol';
import { CollectorRealtimeService } from './collector-realtime.service';

const user = { id: 3, companyId: 1, name: '员工', permissions: { allow: ['*'], deny: [] } } as any;
const key = 'test-vendor-credential';
function wav() {
  const b = Buffer.alloc(44 + 32000); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(32000, 40); return b;
}
function setup() {
  const rows: any[] = [], logs: any[] = [];
  const repo = { findOne: jest.fn(async ({ where }) => rows.find(r => r.companyId === where.companyId && r.settingKey === where.settingKey)),
    upsert: jest.fn(async (value) => { const old = rows.findIndex(r => r.companyId === value.companyId); if (old < 0) rows.push(value); else rows[old] = value; }) };
  const crypto = new CryptoService({ test: Buffer.alloc(32, 7) }, 'test');
  const settings = new SpeechSettingsService(repo as any, { insert: async (value: any) => logs.push(value) } as any, crypto);
  return { settings, collector: new CollectorService(settings), rows, logs };
}
describe('采集器语音设置与代理', () => {
  it('按公司隔离，加密密钥、摘要不返回密钥；留空保留，日志无密钥', async () => {
    const { settings, rows, logs } = setup();
    const result = await settings.save(user, { apiKey: key, enabled: true, fileEnabled: true, realtimeEnabled: true, maxConcurrent: 20 });
    expect(result.configured).toBe(true); expect(JSON.stringify([rows, logs, result])).not.toContain(key);
    expect((await settings.read(1))?.apiKey).toBe(key); expect(await settings.read(2)).toBeNull();
    await settings.save(user, { enabled: false, fileEnabled: false, realtimeEnabled: true, maxConcurrent: 1 });
    expect((await settings.read(1))?.apiKey).toBe(key);
    await expect(settings.save({ ...user, companyId: 2 }, { enabled: true, fileEnabled: true, realtimeEnabled: true, maxConcurrent: 20 })).rejects.toThrow('API Key');
  });
  it('关闭模式直接拒绝，文件与实时共用公司槽位，释放幂等', async () => {
    const { collector } = setup(); await expect(collector.config(1, 'file')).rejects.toThrow('未启用');
    const leases = Array.from({ length: 20 }, () => collector.acquire(1, 20));
    expect(() => collector.acquire(1, 20)).toThrow('并发');
    expect(() => collector.acquire(2, 20)()).not.toThrow();
    leases[0](); leases[0](); const slot = collector.acquire(1, 20);
    expect(() => collector.acquire(1, 20)).toThrow('并发'); slot(); leases.forEach(release => release());
  });
  it('仅向固定豆包地址发声音和服务端身份，输出只含文本及时间', async () => {
    const { collector, settings } = setup(); await settings.save(user, { apiKey: key, enabled: true, fileEnabled: true, realtimeEnabled: false, maxConcurrent: 20 });
    let seen: any;
    const fakeFetch = jest.fn(async (url, init) => { seen = { url, ...init }; return new Response(JSON.stringify({ secret: key, result: { text: '原话',
      utterances: [{ text: '原话', start_time: 0, end_time: 1000, secret: key }] } }), { headers: { 'X-Api-Status-Code': '20000000' } }); });
    const r = await collector.transcribe(1, 3, wav().toString('base64'), ['商品甲'], fakeFetch as any);
    expect(seen.url).toBe('https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash');
    expect(seen.headers['X-Api-Key']).toBe(key); expect(JSON.parse(seen.body).user.uid).toBe('oa-1-3');
    expect(JSON.parse(seen.body).request.enable_ddc).toBe(false); expect(JSON.stringify(r)).not.toContain(key);
    expect(r.result.utterances[0].end_time).toBe(1000); await expect(collector.config(1, 'realtime')).rejects.toThrow('未启用');
  });
  it('供应商鉴权失败是 502 而非 OA 401；不返回供应商原始内容，不自动重试', async () => {
    const { collector, settings } = setup(); await settings.save(user, { apiKey: key, enabled: true, fileEnabled: true, realtimeEnabled: false, maxConcurrent: 1 });
    const fail = jest.fn(async () => new Response(key, { status: 401 }));
    await expect(collector.transcribe(1, 3, wav().toString('base64'), [], fail as any)).rejects.toBeInstanceOf(BadGatewayException);
    expect(fail).toHaveBeenCalledTimes(1); expect(() => collector.acquire(1, 1)()).not.toThrow();
  });
});
describe('采集器语音输入边界', () => {
  it('校验 WAV 类型、时长、热词及截断内容', () => {
    expect(pcmWav(wav().toString('base64'))).toEqual(wav());
    for (const value of ['abcd', '***', wav().subarray(0, 100).toString('base64')]) expect(() => pcmWav(value)).toThrow();
    const stereo = wav(); stereo.writeUInt16LE(2, 22); expect(() => pcmWav(stereo.toString('base64'))).toThrow();
    expect(() => cleanWords(['x'.repeat(251)])).toThrow(); expect(cleanWords(['甲', '甲', ' 乙 '])).toEqual(['甲', '乙']);
  });
  it('二进制帧限制解压大小，保留 final/序号，错误帧不透传', () => {
    const frame = encodeFrame(Buffer.from('{"result":{"text":"测试"}}'), 9, 3, -1), decoded = decodeFrame(frame);
    expect(decoded.sequence).toBe(-1); expect(decoded.flags).toBe(3); expect(safeResult(JSON.parse(decoded.payload.toString())).result.text).toBe('测试');
    expect(() => decodeFrame(frame.subarray(0, -1))).toThrow();
    expect(() => decodeFrame(encodeFrame(Buffer.alloc(100000), 2), 12800)).toThrow();
  });
  it('连接断开清理槽位；非法文本帧关闭，无上游调用', () => {
    const release = jest.fn(), client = Object.assign(new EventEmitter(), { readyState: 1, send: jest.fn(), close: jest.fn(), terminate: jest.fn() });
    const service = new CollectorRealtimeService({} as any, {} as any, {} as any, {} as any);
    (service as any).bridge(client, user, key, jest.fn(), release);
    client.emit('message', Buffer.from('invalid'), false); client.emit('close');
    expect(release).toHaveBeenCalledTimes(1); expect(client.close).toHaveBeenCalledWith(1011); expect(client.send).toHaveBeenCalledTimes(1);
  });
});
