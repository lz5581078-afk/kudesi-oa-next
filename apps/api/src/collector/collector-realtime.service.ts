import { ExecutionContext, Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { IncomingMessage, Server } from 'http';
import { Socket } from 'net';
import WebSocket, { WebSocketServer, RawData } from 'ws';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { AuthUser } from '../common/auth.decorators';
import { CollectorController } from './collector.controller';
import { CollectorIdentityService } from './collector-identity.service';
import { CollectorService } from './collector.service';
import { cleanWords, decodeFrame, encodeFrame, REALTIME_URL, safeResult, speechRequest } from './speech-protocol';
import { randomUUID } from 'crypto';

@Injectable()
export class CollectorRealtimeService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
  private server?: Server;
  constructor(private readonly adapter: HttpAdapterHost, private readonly guard: JwtAuthGuard,
    private readonly identity: CollectorIdentityService, private readonly collector: CollectorService) {}
  onApplicationBootstrap() {
    this.server = this.adapter.httpAdapter.getHttpServer() as Server;
    this.server.on('upgrade', this.upgrade);
  }
  onModuleDestroy() { this.server?.off('upgrade', this.upgrade); for (const ws of this.wss.clients) ws.terminate(); this.wss.close(); }
  private upgrade = (request: IncomingMessage, socket: Socket, head: Buffer) => {
    if (request.url?.split('?')[0] !== '/api/collector/realtime') { socket.destroy(); return; }
    socket.setTimeout(12000, () => socket.destroy());
    void this.accept(request, socket, head).catch((error) => {
      if (socket.destroyed) return;
      const status = typeof error?.getStatus === 'function' ? error.getStatus() : 400;
      socket.end(`HTTP/1.1 ${[401, 403, 429].includes(status) ? status : 400} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    });
  };
  private async accept(req: IncomingMessage, socket: Socket, head: Buffer) {
    if (req.url !== '/api/collector/realtime') throw new Error('Query credentials are not accepted');
    const context = { getClass: () => CollectorController, getHandler: () => CollectorController.prototype.session,
      switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
    const authorize = async () => {
      await this.guard.canActivate(context);
      const u = (req as IncomingMessage & { user: AuthUser }).user;
      await this.identity.session(u);
      const config = await this.collector.config(u.companyId, 'realtime');
      return { u, config };
    };
    const { u, config } = await authorize();
    if (socket.destroyed) return;
    const release = this.collector.acquire(u.companyId, config.maxConcurrent);
    try { this.wss.handleUpgrade(req, socket, head, ws => { socket.setTimeout(0); this.bridge(ws, u, config.apiKey, authorize, release); }); }
    catch (e) { release(); throw e; }
  }
  private bridge(client: WebSocket, user: AuthUser, apiKey: string,
    authorize: () => Promise<{ config: { apiKey: string } }>, release: () => void) {
    let upstream: WebSocket | undefined, ready = false, started = false, finalSent = false, bytes = 0, closed = false;
    const pending: Buffer[] = []; let pendingBytes = 0;
    const stop = (failed = false) => {
      if (closed) return; closed = true; clearInterval(check); clearTimeout(initial); clearTimeout(lifetime); release();
      upstream?.terminate();
      if (failed && client.readyState === WebSocket.OPEN) {
        const size = Buffer.alloc(4), code = Buffer.alloc(4); code.writeUInt32BE(55000000);
        const body = Buffer.from('{}'); size.writeUInt32BE(body.length);
        client.send(Buffer.concat([Buffer.from([0x11, 0xf0, 0x10, 0]), code, size, body]));
      }
      if (client.readyState === WebSocket.OPEN) client.close(failed ? 1011 : 1000);
      else client.terminate();
    };
    const check = setInterval(() => { void authorize().then(r => { if (r.config.apiKey !== apiKey) stop(true); }).catch(() => stop(true)); }, 30000);
    const lifetime = setTimeout(() => stop(true), 330000);
    const initial = setTimeout(() => { if (!started) stop(true); }, 10000);
    client.on('close', () => stop()); client.on('error', () => stop());
    client.on('message', (raw: RawData, isBinary: boolean) => {
      try {
        if (!isBinary || closed) throw new Error('binary only');
        const frame = decodeFrame(Buffer.from(raw as Buffer), started ? 12800 : 16384);
        if (!started) {
          if (frame.kind !== 1 || frame.flags !== 0) throw new Error('initial frame required');
          const requested = JSON.parse(frame.payload.toString('utf8'));
          let words: string[] = [];
          if (requested.request?.corpus?.context) words = cleanWords(JSON.parse(requested.request.corpus.context).hotwords?.map((w: any) => w.word));
          const initialFrame = encodeFrame(Buffer.from(JSON.stringify({ user: { uid: `oa-${user.companyId}-${user.id}` },
            audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1 }, request: speechRequest(words, true) })), 1);
          started = true;
          upstream = this.connectVendor(apiKey);
          upstream.on('open', () => {
            if (closed) { upstream?.terminate(); return; } upstream!.send(initialFrame); ready = true;
            for (const frame of pending) upstream!.send(frame); pending.length = 0; pendingBytes = 0;
          });
          upstream.on('message', (data: RawData, binary: boolean) => {
            try {
              if (!binary || closed) throw new Error('bad vendor frame');
              const result = decodeFrame(Buffer.from(data as Buffer));
              if (result.kind !== 9) throw new Error('bad vendor kind');
              const body = JSON.parse(result.payload.toString('utf8'));
              if (body.code !== undefined && ![0, 1000, 20000000].includes(body.code)) throw new Error('vendor error');
              const filtered = safeResult(body);
              if (client.bufferedAmount > 2 * 1024 * 1024) throw new Error('slow client');
              client.send(encodeFrame(Buffer.from(JSON.stringify(filtered)), 9, result.flags, result.sequence));
            } catch { stop(true); }
          });
          upstream.on('error', () => stop(true)); upstream.on('close', () => stop());
          return;
        }
        if (frame.kind !== 2 || ![0, 2].includes(frame.flags) || finalSent || frame.payload.length % 2) throw new Error('invalid audio');
        bytes += frame.payload.length;
        if (bytes > 300 * 32000) throw new Error('rotate after five minutes');
        finalSent = frame.flags === 2;
        const outgoing = encodeFrame(frame.payload, 2, frame.flags);
        if (ready) { if (upstream!.bufferedAmount > 1024 * 1024) throw new Error('slow upstream'); upstream!.send(outgoing); }
        else { pendingBytes += outgoing.length; if (pendingBytes > 256000) throw new Error('initial backlog'); pending.push(outgoing); }
      } catch { stop(true); }
    });
  }
  private connectVendor(apiKey: string) {
    return new WebSocket(REALTIME_URL, { handshakeTimeout: 10000, maxPayload: 2 * 1024 * 1024, perMessageDeflate: false,
      headers: { 'X-Api-Key': apiKey, 'X-Api-Resource-Id': 'volc.seedasr.sauc.duration', 'X-Api-Request-Id': randomUUID() } });
  }
}
