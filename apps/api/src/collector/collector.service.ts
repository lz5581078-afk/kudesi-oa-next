import { BadGatewayException, ForbiddenException, HttpException, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { SpeechSettingsService } from './speech-settings.service';
import { cleanWords, FILE_URL, pcmWav, safeResult, speechRequest } from './speech-protocol';

/** Single API process (PM2 fork); slots are shared by file and realtime calls. */
@Injectable()
export class CollectorService {
  private readonly active = new Map<number, number>();
  constructor(private readonly settings: SpeechSettingsService) {}
  async config(companyId: number, mode: 'file' | 'realtime') {
    const c = await this.settings.read(companyId);
    if (!c?.enabled || !c.apiKey || !(mode === 'file' ? c.fileEnabled : c.realtimeEnabled)) throw new ForbiddenException('公司未启用此语音模式，请联系管理员在 OA 系统 → 接口设置中配置');
    return c;
  }
  acquire(companyId: number, limit: number) {
    const n = this.active.get(companyId) ?? 0;
    if (n >= limit) throw new HttpException('公司语音并发已满，请稍后重试', 429);
    this.active.set(companyId, n + 1); let released = false;
    return () => { if (released) return; released = true; const remaining = (this.active.get(companyId) ?? 1) - 1;
      if (remaining) this.active.set(companyId, remaining); else this.active.delete(companyId); };
  }
  async transcribe(companyId: number, userId: number, audio: string, words: string[], fetcher: typeof fetch = fetch) {
    const wav = pcmWav(audio), hotwords = cleanWords(words), c = await this.config(companyId, 'file');
    const release = this.acquire(companyId, c.maxConcurrent);
    try {
      const response = await fetcher(FILE_URL, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180000),
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': c.apiKey, 'X-Api-Resource-Id': 'volc.bigasr.auc_turbo', 'X-Api-Request-Id': randomUUID(), 'X-Api-Sequence': '-1' },
        body: JSON.stringify({ user: { uid: `oa-${companyId}-${userId}` }, audio: { data: wav.toString('base64'), format: 'wav', rate: 16000, bits: 16, channel: 1 }, request: speechRequest(hotwords) }) });
      if (response.status === 429) throw new HttpException('豆包语音额度或并发不足，请联系管理员', 429);
      if (!response.ok || response.headers.get('X-Api-Status-Code') !== '20000000') throw new BadGatewayException('豆包语音未完成识别，请管理员检查语音密钥、服务权限及额度');
      // Bound responses before JSON parsing; upstream error text is never exposed.
      const reader = response.body?.getReader(); let size = 0; const chunks: Uint8Array[] = [];
      if (!reader) throw new BadGatewayException('语音服务没有返回结果');
      try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length;
        if (size > 2 * 1024 * 1024) throw new BadGatewayException('语音结果超过限制'); chunks.push(part.value); } }
      finally { await reader.cancel().catch(() => undefined); }
      return safeResult(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch (e) { if (e instanceof HttpException) throw e; throw new BadGatewayException('语音连接中断或返回异常，原文保留，请检查后手动重试'); }
    finally { release(); }
  }
}
