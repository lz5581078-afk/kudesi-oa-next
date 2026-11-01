import { BadGatewayException, BadRequestException, ForbiddenException, HttpException, Inject, Injectable, NotFoundException, OnModuleDestroy, Optional } from '@nestjs/common';
import { createHash } from 'crypto';
import { mkdir, readFile, readdir, stat, statfs, unlink, writeFile } from 'fs/promises';
import { join, isAbsolute } from 'path';
import { tmpdir } from 'os';
import { CryptoService } from '../common/crypto.service';
import { CollectorService } from './collector.service';
import { cleanWords, pcmWav, safeResult, speechRequest } from './speech-protocol';

export const FILE_ASR_OPTIONS = 'FILE_ASR_OPTIONS';
export interface FileAsrOptions { root?: string; origin?: string; fetcher?: typeof fetch; now?: () => number }
const TTL = 4 * 60 * 60 * 1000;
const SUBMIT = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit';
const QUERY = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/query';
const vendorId = (id: string) => `${id.slice(0, 8)}-${id.slice(8, 12)}-4${id.slice(13, 16)}-a${id.slice(17, 20)}-${id.slice(20, 32)}`;
interface Ticket { purpose: 'task' | 'audio'; id: string; cid: number; uid: number; exp: number }

/** Only derived, short-lived ASR input is cached here; the authoritative task is
 * held by the speech provider. No API key, OA token or business row is stored. */
@Injectable()
export class CollectorFileService implements OnModuleDestroy {
  private readonly root: string;
  private readonly origin: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly creating = new Map<string, Promise<any>>();
  private readonly cleaner: NodeJS.Timeout;
  constructor(private readonly collector: CollectorService, private readonly crypto: CryptoService,
    @Optional() @Inject(FILE_ASR_OPTIONS) options: FileAsrOptions = {}) {
    this.root = options.root ?? join(process.env.FILES_LOCAL_ROOT || tmpdir(), '.collector-speech-cache');
    const u = new URL(options.origin ?? process.env.COLLECTOR_PUBLIC_ORIGIN ?? process.env.CORS_ORIGIN?.split(',')[0].trim() ?? 'http://localhost:5173');
    if (!isAbsolute(this.root) || u.username || u.password || u.search || u.hash || u.pathname !== '/'
      || !(u.protocol === 'https:' || u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) throw new Error('语音临时存储配置无效');
    this.origin = u.origin; this.fetcher = options.fetcher ?? fetch; this.now = options.now ?? Date.now;
    this.cleaner = setInterval(() => { void this.cleanup().catch(() => undefined); }, 300000); this.cleaner.unref();
  }
  onModuleDestroy() { clearInterval(this.cleaner); }
  private location(id: string) { return join(this.root, id + '.enc'); }
  private encode(t: Ticket) { return Buffer.from(this.crypto.encrypt(JSON.stringify(t))).toString('base64url'); }
  private decode(token: string, purpose: Ticket['purpose']): Ticket {
    try {
      if (token.length > 2000 || !/^[A-Za-z0-9_-]+$/.test(token)) throw Error();
      const t = JSON.parse(this.crypto.decrypt(Buffer.from(token, 'base64url').toString())) as Ticket;
      if (t.purpose !== purpose || !/^[0-9a-f]{64}$/.test(t.id) || !Number.isSafeInteger(t.cid) || t.cid < 1
        || !Number.isSafeInteger(t.uid) || t.uid < 1 || !Number.isSafeInteger(t.exp) || t.exp <= this.now() || t.exp > this.now() + TTL) throw Error();
      return t;
    } catch { throw new NotFoundException('语音任务不存在或已过期，请手动重新识别'); }
  }
  async cleanup() {
    for (const name of await readdir(this.root).catch(() => [] as string[])) {
      if (!/^[0-9a-f]{64}\.enc$/.test(name)) continue;
      const path = join(this.root, name), info = await stat(path).catch(() => null);
      if (info && info.mtimeMs < this.now() - TTL) await unlink(path).catch(() => undefined);
    }
  }
  private async body(response: Response) {
    const reader = response.body?.getReader(); if (!reader) throw new BadGatewayException('语音服务没有返回结果');
    const chunks: Uint8Array[] = []; let bytes = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.length;
      if (bytes > 2 * 1024 * 1024) throw new BadGatewayException('语音结果超过限制'); chunks.push(part.value); } }
    finally { await reader.cancel().catch(() => undefined); }
    return JSON.parse(Buffer.concat(chunks).toString());
  }
  private check(response: Response, pending = false) {
    const code = response.headers.get('X-Api-Status-Code');
    if (response.status === 429) throw new HttpException('豆包语音额度或并发不足，请联系管理员', 429);
    if (response.status === 401 || response.status === 403 || code === '45000030')
      throw new BadGatewayException('录音文件识别 2.0 未获授权，请管理员检查当前 Key 所属项目的服务开通情况');
    if (!response.ok || !['20000000', '20000003', ...(pending ? ['20000001', '20000002'] : [])].includes(code ?? ''))
      throw new BadGatewayException('录音文件识别 2.0 未完成请求，请检查服务权限、额度及音频格式');
    return code;
  }
  async start(cid: number, uid: number, audio: string, words: string[], requestId: string) {
    const wav = pcmWav(audio), hotwords = cleanWords(words);
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new BadRequestException('语音任务编号无效');
    const c = await this.collector.config(cid, 'file');
    const id = createHash('sha256').update(JSON.stringify([cid, uid, requestId, hotwords])).update(wav).digest('hex');
    const existing = this.creating.get(id); if (existing) return existing;
    const operation = this.submit(cid, uid, id, wav, hotwords, c);
    this.creating.set(id, operation);
    try { return await operation; } finally { this.creating.delete(id); }
  }
  private async submit(cid: number, uid: number, id: string, wav: Buffer, words: string[], c: { apiKey: string; maxConcurrent: number }) {
    const release = this.collector.acquire(cid, c.maxConcurrent);
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      // A repeated client upload must query the same provider task, never charge twice.
      let exp = this.now() + TTL, present = false;
      try { const old = JSON.parse(this.crypto.decrypt(await readFile(this.location(id), 'utf8'))); exp = old.exp; present = exp > this.now(); }
      catch (e: any) { if (e.code !== 'ENOENT') throw new BadGatewayException('语音临时文件不可用，请联系管理员'); }
      const ticket: Ticket = { purpose: 'task', id, cid, uid, exp };
      if (present) return { state: 'processing', taskToken: this.encode(ticket), pollAfter: 3 };
      const disk = await statfs(this.root);
      if (disk.bavail * disk.bsize < wav.length * 2 + 256 * 1024 * 1024) throw new HttpException('OA 语音临时存储空间不足，录像仍保存在电脑上', 507);
      exp = this.now() + TTL; ticket.exp = exp;
      await writeFile(this.location(id), this.crypto.encrypt(JSON.stringify({ exp, audio: wav.toString('base64') })), { mode: 0o600 });
      const audioToken = this.encode({ ...ticket, purpose: 'audio' });
      let response: Response;
      try {
        response = await this.fetcher(SUBMIT, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
          headers: { 'Content-Type': 'application/json', 'X-Api-Key': c.apiKey, 'X-Api-Resource-Id': 'volc.seedasr.auc', 'X-Api-Request-Id': vendorId(id), 'X-Api-Sequence': '-1' },
          body: JSON.stringify({ user: { uid: `oa-${cid}-${uid}` }, audio: { url: `${this.origin}/api/collector/audio/${audioToken}`, format: 'wav', rate: 16000, bits: 16, channel: 1 }, request: speechRequest(words) }) });
      } catch {
        // Submission might have reached the provider. Preserve the ticket so a retry only queries.
        return { state: 'processing', taskToken: this.encode(ticket), pollAfter: 3 };
      }
      try { this.check(response); }
      catch (e) { await unlink(this.location(id)).catch(() => undefined); throw e; }
      finally { await response.body?.cancel().catch(() => undefined); }
      return { state: 'processing', taskToken: this.encode(ticket), pollAfter: 3 };
    } finally { release(); }
  }
  async query(cid: number, uid: number, token: string) {
    const t = this.decode(token, 'task');
    if (t.cid !== cid || t.uid !== uid) throw new ForbiddenException('不能访问其他员工的语音任务');
    const c = await this.collector.config(cid, 'file'), release = this.collector.acquire(cid, c.maxConcurrent);
    try {
      const response = await this.fetcher(QUERY, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': c.apiKey, 'X-Api-Resource-Id': 'volc.seedasr.auc', 'X-Api-Request-Id': vendorId(t.id) }, body: '{}' });
      let code: string | null;
      try { code = this.check(response, true); }
      catch (e) { await response.body?.cancel().catch(() => undefined); throw e; }
      if (code === '20000001' || code === '20000002') { await response.body?.cancel(); return { state: code === '20000002' ? 'queued' : 'processing', taskToken: token, pollAfter: 3 }; }
      const result = code === '20000003' ? { result: { text: '', utterances: [] } } : safeResult(await this.body(response));
      await unlink(this.location(t.id)).catch(() => undefined);
      return { state: 'done', ...result };
    } catch (e) { if (e instanceof HttpException) throw e; throw new BadGatewayException('语音查询暂时中断，任务保留，可稍后继续查询'); }
    finally { release(); }
  }
  async audio(token: string) {
    const t = this.decode(token, 'audio'); await this.collector.config(t.cid, 'file');
    try {
      const payload = JSON.parse(this.crypto.decrypt(await readFile(this.location(t.id), 'utf8')));
      if (payload.exp <= this.now()) throw Error();
      return pcmWav(payload.audio);
    } catch { throw new NotFoundException('临时音频已过期'); }
  }
}
