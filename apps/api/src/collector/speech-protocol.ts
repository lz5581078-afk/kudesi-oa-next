import { BadRequestException, BadGatewayException } from '@nestjs/common';
import { gzipSync, gunzipSync } from 'zlib';

export const REALTIME_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';
export const MAX_AUDIO = 120 * 32000 + 4096;

export function cleanWords(words: unknown): string[] {
  if (!Array.isArray(words) || words.length > 40 || words.some(w => typeof w !== 'string' || w.length > 40)
      || words.join('').length > 250) throw new BadRequestException('热词超出限制');
  return [...new Set(words.map(w => w.trim()).filter(Boolean))];
}
export function speechRequest(words: string[], realtime = false) {
  return { model_name: 'bigmodel', enable_punc: true, enable_itn: true, enable_ddc: false, show_utterances: true,
    ...(realtime ? { enable_nonstream: true, result_type: 'full' } : {}),
    ...(words.length ? { corpus: { context: JSON.stringify({ hotwords: words.map(word => ({ word })) }) } } : {}) };
}
export function pcmWav(encoded: string): Buffer {
  if (!encoded || encoded.length > Math.ceil(MAX_AUDIO / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
    throw new BadRequestException('录音格式无效或超过两分钟');
  const b = Buffer.from(encoded, 'base64');
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new BadRequestException('仅接受 PCM WAV 录音');
  let fmt = false, bytes = 0;
  for (let p = 12; p + 8 <= b.length;) {
    const n = b.readUInt32LE(p + 4), tag = b.toString('ascii', p, p + 4); p += 8;
    if (p + n > b.length) throw new BadRequestException('录音数据不完整');
    if (tag === 'fmt ') fmt = n >= 16 && b.readUInt16LE(p) === 1 && b.readUInt16LE(p + 2) === 1 && b.readUInt32LE(p + 4) === 16000 && b.readUInt16LE(p + 14) === 16;
    if (tag === 'data') bytes += n;
    p += n + (n % 2);
  }
  if (!fmt || bytes === 0 || bytes > 120 * 32000 || bytes % 2) throw new BadRequestException('录音须为两分钟以内的 16kHz 单声道 PCM16');
  return b;
}
function nativeTime(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : null;
}
/** Some realtime first utterances omit their sentence start, while retaining
 * native word times. Recover from those times; never fabricate a zero or NaN. */
function utteranceTime(u: any, requireTiming: boolean) {
  const words = Array.isArray(u?.words) ? u.words : [];
  const starts = words.map((w: any) => nativeTime(w?.start_time)).filter((n: number | null): n is number => n !== null);
  const ends = words.map((w: any) => nativeTime(w?.end_time)).filter((n: number | null): n is number => n !== null);
  const start = nativeTime(u?.start_time) ?? (starts.length ? Math.min(...starts) : null);
  const end = nativeTime(u?.end_time) ?? (ends.length ? Math.max(...ends) : null);
  if ((requireTiming || u?.definite === true) && (start === null || end === null || end <= start))
    throw new BadGatewayException('语音服务未返回有效的原生分句时间');
  return { start_time: start, end_time: end };
}
/** Only recognition text/times pass back; vendor headers, tracebacks and echoes do not. */
export function safeResult(value: any, requireTiming = true) {
  const body = value?.payload_msg ?? value?.body ?? value;
  const r = Array.isArray(body?.result) ? body.result[0] : body?.result;
  if (!r || typeof r !== 'object') throw new BadGatewayException('语音服务返回无效结果');
  const utterances = (Array.isArray(r.utterances) ? r.utterances : []).slice(0, 5000).map((u: any) => ({
    text: typeof u?.text === 'string' ? u.text.slice(0, 10000) : '', ...utteranceTime(u, requireTiming), definite: u?.definite === true,
  }));
  return { result: { text: typeof r.text === 'string' ? r.text.slice(0, 100000) : '', utterances } };
}
export function encodeFrame(payload: Buffer, kind: number, flags = 0, sequence?: number) {
  const zipped = gzipSync(payload), size = Buffer.alloc(4); size.writeUInt32BE(zipped.length);
  const seq = sequence === undefined ? Buffer.alloc(0) : Buffer.alloc(4);
  if (sequence !== undefined) seq.writeInt32BE(sequence);
  return Buffer.concat([Buffer.from([0x11, (kind << 4) | flags, (kind === 2 ? 0 : 0x10) | 1, 0]), seq, size, zipped]);
}
export function decodeFrame(b: Buffer, maxOutput = 1024 * 1024) {
  if (b.length < 8 || b[0] !== 0x11 || b[3] !== 0) throw new BadRequestException('语音协议帧无效');
  const kind = b[1] >> 4, flags = b[1] & 15;
  let p = 4, sequence: number | undefined;
  if (flags & 1) { if (b.length < 12) throw new BadRequestException('语音协议序号无效'); sequence = b.readInt32BE(p); p += 4; }
  if (kind === 15) throw new BadGatewayException('豆包语音拒绝请求，请管理员检查密钥、服务权限及额度');
  const size = b.readUInt32BE(p); p += 4;
  if (size !== b.length - p || (b[2] & 15) > 1) throw new BadRequestException('语音协议长度无效');
  const payload = (b[2] & 15) === 1 ? gunzipSync(b.subarray(p), { maxOutputLength: maxOutput }) : b.subarray(p);
  if (payload.length > maxOutput) throw new BadRequestException('语音协议数据过大');
  return { kind, flags, sequence, payload };
}
