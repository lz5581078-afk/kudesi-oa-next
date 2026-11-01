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
  it('允许保存2000并发并保留密钥及使用范围，非法值不覆盖原设置', async () => {
    const { settings, rows, logs } = setup();
    const input = { enabled: true, fileEnabled: true, realtimeEnabled: true, maxConcurrent: 20 };
    await settings.save(user, { ...input, apiKey: key, allEmployees: false });
    expect((await settings.save(user, { ...input, maxConcurrent: 2000 })).maxConcurrent).toBe(2000);
    expect(await settings.read(1)).toMatchObject({ apiKey: key, allEmployees: false, maxConcurrent: 2000 });
    const ciphertext = rows[0].configEnc, auditCount = logs.length;
    for (const maxConcurrent of [0, -1, 2001, 1.5, NaN, Infinity])
      await expect(settings.save(user, { ...input, maxConcurrent })).rejects.toThrow('并发上限');
    expect(rows[0].configEnc).toBe(ciphertext); expect(logs).toHaveLength(auditCount);
  });
  it('2000个公司槽位可同时占用，2001个拒绝；释放后可用且其他公司独立', () => {
    const { collector } = setup();
    const leases = Array.from({ length: 2000 }, () => collector.acquire(1, 2000));
    expect(() => collector.acquire(1, 2000)).toThrow('并发');
    expect(() => collector.acquire(2, 2000)()).not.toThrow();
    leases[0](); leases[0](); const replacement = collector.acquire(1, 2000);
    expect(() => collector.acquire(1, 2000)).toThrow('并发');
    replacement(); leases.forEach(release => release());
    expect(() => collector.acquire(1, 1)()).not.toThrow();
  });
  it('默认全员可用；公司范围可恢复指定授权，旧客户端保存时保留此设置', async () => {
    const { settings, rows } = setup();
    expect((await settings.overview(1)).allEmployees).toBe(true);
    const input = { enabled: false, fileEnabled: true, realtimeEnabled: true, maxConcurrent: 20 };
    await settings.save(user, { ...input, allEmployees: false });
    expect((await settings.overview(1)).allEmployees).toBe(false);
    expect((await settings.overview(2)).allEmployees).toBe(true);
    await settings.save(user, input);
    expect((await settings.overview(1)).allEmployees).toBe(false);
    rows[0].configEnc = 'invalid-ciphertext';
    await expect(settings.overview(1)).rejects.toThrow('配置暂时不可用');
  });
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
