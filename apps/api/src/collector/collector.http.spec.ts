import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { once } from 'events';
import WebSocket, { WebSocketServer } from 'ws';
import { AuthService } from '../auth/auth.service';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { PermissionsGuard } from '../common/permissions.guard';
import { Company, PlatformAdmin, PositionPermission, User, UserPermissionOverride } from '../entities';
import { CollectorController, SpeechSettingsController } from './collector.controller';
import { CollectorService } from './collector.service';
import { CollectorIdentityService } from './collector-identity.service';
import { SpeechSettingsService } from './speech-settings.service';
import { CollectorRealtimeService } from './collector-realtime.service';
import { decodeFrame, encodeFrame } from './speech-protocol';

class FakeRepo {
  constructor(public rows: any[]) {}
  async findOne({ where }: any) { return this.rows.find(r => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null; }
  async find({ where }: any) { return this.rows.filter(r => Object.entries(where).every(([k, v]) => r[k] === v)); }
}
describe('采集器 HTTP/WS 真实登录守卫与公司隔离（假仓库，无付费调用）', () => {
  let app: INestApplication, base: string, jwt: JwtService, service: CollectorRealtimeService;
  const users = new FakeRepo([
    { id: 1, companyId: 10, name: '公司甲管理员', status: 'active', isCompanyAdmin: true, positionId: null, extraPositionIds: [], employmentType: 'regular' },
    { id: 2, companyId: 20, name: '公司乙管理员', status: 'active', isCompanyAdmin: true, positionId: null, extraPositionIds: [], employmentType: 'regular' },
    { id: 3, companyId: 10, name: '普通员工', status: 'active', isCompanyAdmin: false, positionId: null, extraPositionIds: [], employmentType: 'regular' },
  ]);
  const settings = { overview: jest.fn(async () => ({ enabled: true, configured: true, fileEnabled: true, realtimeEnabled: true, maxConcurrent: 20 })),
    read: jest.fn(async () => ({ apiKey: 'server-test-key', enabled: true, fileEnabled: true, realtimeEnabled: true, maxConcurrent: 20 })), save: jest.fn(async () => ({ configured: true })) };
  const auth = { me: jest.fn(async (id, cid) => ({ id, companyId: cid, companyName: cid === 10 ? '公司甲' : '公司乙', name: '测试员工', mustChangePassword: false })) };
  const file = jest.fn(async () => ({ result: { text: '', utterances: [] } }));
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: 'isolated-test-jwt-secret-at-least-thirty-two', signOptions: { expiresIn: '1h' } })],
      controllers: [CollectorController, SpeechSettingsController],
      providers: [CollectorService, CollectorIdentityService, CollectorRealtimeService, JwtAuthGuard,
        { provide: AuthService, useValue: auth }, { provide: SpeechSettingsService, useValue: settings },
        { provide: getRepositoryToken(User), useValue: users },
        { provide: getRepositoryToken(Company), useValue: new FakeRepo([{ id: 10, status: 'active' }, { id: 20, status: 'active' }]) },
        { provide: getRepositoryToken(PlatformAdmin), useValue: new FakeRepo([]) },
        { provide: getRepositoryToken(PositionPermission), useValue: new FakeRepo([]) },
        { provide: getRepositoryToken(UserPermissionOverride), useValue: new FakeRepo([]) },
        { provide: APP_GUARD, useExisting: JwtAuthGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }],
    }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1'); base = await app.getUrl(); jwt = app.get(JwtService); service = app.get(CollectorRealtimeService);
    jest.spyOn(app.get(CollectorService), 'transcribe').mockImplementation(file);
  });
  afterAll(async () => { await app?.close(); });
  const token = (sub = 1, cid = 10) => jwt.sign({ sub, cid });
  const request = (path: string, t?: string, body?: unknown) => fetch(base + '/api/' + path, { method: body ? 'POST' : 'GET',
    headers: { ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  it('匿名、平台令牌、未授权员工与伪造公司均拒绝；设置只有有权限的人可看', async () => {
    expect((await request('collector/session')).status).toBe(401);
    expect((await request('collector/session', jwt.sign({ sub: 1, typ: 'platform' }))).status).toBe(403);
    expect((await request('collector/session', token(3))).status).toBe(403);
    expect((await request('settings/integrations/speech', token(3))).status).toBe(403);
    expect((await request('collector/session', token(1, 20))).status).toBe(401);
  });
  it('会话只返回对应公司摘要，客户端不能通过 DTO 传入其他公司', async () => {
    const r = await request('collector/session', token(2, 20)); expect(r.status).toBe(200);
    const body = await r.json(); expect(body.company.id).toBe(20); expect(JSON.stringify(body)).not.toContain('server-test-key');
    expect((await request('collector/file', token(), { audio: 'xx', hotwords: [], companyId: 20 })).status).toBe(400);
    const ok = await request('collector/file', token(), { audio: 'xx', hotwords: [] }); expect(ok.status).toBe(201);
    expect(file).toHaveBeenLastCalledWith(10, 1, 'xx', []);
  });
  it('停用员工后已有令牌立刻失效；首次改密要求对采集器同样生效', async () => {
    const t = token(); users.rows[0].status = 'disabled';
    try { expect((await request('collector/session', t)).status).toBe(401); } finally { users.rows[0].status = 'active'; }
    auth.me.mockResolvedValueOnce({ id: 1, companyId: 10, companyName: '公司甲', name: '测试员工', mustChangePassword: true });
    expect((await request('collector/session', t)).status).toBe(403);
  });
  it('WS 不接受查询参数凭据，未登录握手被拒绝', async () => {
    for (const suffix of ['/api/collector/realtime?token=bad', '/api/collector/realtime']) {
      const ws = new WebSocket(base.replace('http:', 'ws:') + suffix);
      const [error] = await once(ws, 'error'); expect(String(error)).toMatch(/400|401/); ws.terminate();
    }
  });
  it('真实 WS 音频帧经代理返回时间戳，重建身份、不透传密钥和额外字段', async () => {
    const vendor = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(vendor, 'listening');
    const vendorPort = (vendor.address() as { port: number }).port; let initial: any;
    vendor.on('connection', ws => ws.on('message', raw => {
      const p = decodeFrame(Buffer.from(raw as Buffer));
      if (p.kind === 1) { initial = JSON.parse(p.payload.toString()); return; }
      ws.send(encodeFrame(Buffer.from(JSON.stringify({ secret: 'server-test-key', result: { text: '测试原话', utterances: [{ text: '测试原话', start_time: 0, end_time: 200, definite: true, secret: 'server-test-key' }] } })), 9, 3, -1));
    }));
    const connect = jest.spyOn(service as any, 'connectVendor').mockImplementation(() => new WebSocket(`ws://127.0.0.1:${vendorPort}`));
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/collector/realtime', { headers: { Authorization: 'Bearer ' + token() } });
    try {
      await once(ws, 'open'); ws.send(encodeFrame(Buffer.from(JSON.stringify({ user: { uid: 'spoofed' }, audio: { rate: 999 }, request: {} })), 1));
      ws.send(encodeFrame(Buffer.alloc(6400), 2, 2));
      const [data] = await once(ws, 'message'), frame = decodeFrame(Buffer.from(data));
      expect(JSON.parse(frame.payload.toString()).result.utterances[0].end_time).toBe(200);
      expect(frame.payload.toString()).not.toContain('server-test-key'); expect(initial.user.uid).toBe('oa-10-1'); expect(initial.audio.rate).toBe(16000);
    } finally { ws.terminate(); connect.mockRestore(); for (const connection of vendor.clients) connection.terminate(); vendor.close(); }
  });
});
