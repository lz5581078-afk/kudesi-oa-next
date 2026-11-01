import { CollectorTextController } from './collector-text.controller';
import { CollectorTextService } from './collector-text.service';
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
import { CollectorFileService } from './collector-file.service';
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
  const limitedCompanies = new Set<number>();
  const companies = new FakeRepo([{ id: 10, status: 'active' }, { id: 20, status: 'active' }]);
  const settings = { overview: jest.fn(async (companyId: number) => ({ enabled: true, configured: true, fileEnabled: true, realtimeEnabled: true, maxConcurrent: 20, allEmployees: !limitedCompanies.has(companyId) })),
    read: jest.fn(async () => ({ apiKey: 'server-test-key', enabled: true, fileEnabled: true, realtimeEnabled: true, maxConcurrent: 20 })), save: jest.fn(async () => ({ configured: true })) };
  const auth = { me: jest.fn(async (id, cid) => ({ id, companyId: cid, companyName: cid === 10 ? '公司甲' : '公司乙', name: '测试员工', mustChangePassword: false })) };
  const file = jest.fn(async () => ({ result: { text: '', utterances: [] } }));
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: 'isolated-test-jwt-secret-at-least-thirty-two', signOptions: { expiresIn: '1h' } })],
      controllers: [CollectorTextController, CollectorController, SpeechSettingsController],
      providers: [{ provide: CollectorTextService, useValue: { overview: jest.fn(async () => ({ configured: true })), organize: jest.fn(async (...args) => ({ body: '完整话术', identity: args.slice(0, 2) })) } }, CollectorService, CollectorIdentityService, CollectorRealtimeService, JwtAuthGuard,
        { provide: CollectorFileService, useValue: { start: file, query: jest.fn(async () => ({ state: 'processing' })), audio: jest.fn(async () => { throw new Error('invalid'); }) } },
        { provide: AuthService, useValue: auth }, { provide: SpeechSettingsService, useValue: settings },
        { provide: getRepositoryToken(User), useValue: users },
        { provide: getRepositoryToken(Company), useValue: companies },
        { provide: getRepositoryToken(PlatformAdmin), useValue: new FakeRepo([]) },
        { provide: getRepositoryToken(PositionPermission), useValue: new FakeRepo([]) },
        { provide: getRepositoryToken(UserPermissionOverride), useValue: new FakeRepo([]) },
        { provide: APP_GUARD, useExisting: JwtAuthGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }],
    }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1'); base = await app.getUrl(); jwt = app.get(JwtService); service = app.get(CollectorRealtimeService);
  });
  afterAll(async () => { await app?.close(); });
  const token = (sub = 1, cid = 10) => jwt.sign({ sub, cid });
  const request = (path: string, t?: string, body?: unknown, method = body ? 'POST' : 'GET') => fetch(base + '/api/' + path, { method,
    headers: { ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  it('匿名、平台令牌与伪造公司均拒绝；普通员工默认可用但不能查看语音设置', async () => {
    expect((await request('collector/session')).status).toBe(401);
    expect((await request('collector/session', jwt.sign({ sub: 1, typ: 'platform' }))).status).toBe(403);
    const employee = await request('collector/session', token(3)); expect(employee.status).toBe(200);
    expect((await employee.json()).speech.allEmployees).toBe(true);
    expect((await request('collector/file', token(3), { audio: 'xx', hotwords: [], apiVersion: 2, requestId: '11111111-1111-4111-8111-111111111111' })).status).toBe(201);
    expect(file).toHaveBeenLastCalledWith(10, 3, 'xx', [], '11111111-1111-4111-8111-111111111111');
    expect((await request('settings/integrations/speech', token(3))).status).toBe(403);
    expect((await request('collector/session', token(1, 20))).status).toBe(401);
  });
  it('话术整理复用员工鉴权和公司隔离，不接受客户端指定公司', async () => {
    expect((await request('collector/text')).status).toBe(401);
    expect((await request('collector/text', undefined, { mode: 'restore', text: '原始话术' })).status).toBe(401);
    const good = await request('collector/text', token(3), { mode: 'restore', text: '原始话术' });
    expect(good.status).toBe(201); expect((await good.json()).identity).toEqual([10, 3]);
    expect((await request('collector/text', token(3), { mode: 'script', text: '原始话术', companyId: 20 })).status).toBe(400);
    expect((await request('collector/text', token(1, 20))).status).toBe(401);
    limitedCompanies.add(10);
    try { expect((await request('collector/text', token(3), { mode: 'restore', text: '原始话术' })).status).toBe(403); }
    finally { limitedCompanies.delete(10); }
  });
  it('管理员可切回指定授权，HTTP与WS同时限制；不影响其他公司和管理员', async () => {
    limitedCompanies.add(10);
    try {
      expect((await request('collector/session', token(3))).status).toBe(403);
      expect((await request('collector/file', token(3), { audio: 'xx', hotwords: [], apiVersion: 2, requestId: '11111111-1111-4111-8111-111111111111' })).status).toBe(403);
      const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/collector/realtime', { headers: { Authorization: 'Bearer ' + token(3) } });
      const [error] = await once(ws, 'error'); expect(String(error)).toContain('403'); ws.terminate();
      expect((await request('collector/session', token())).status).toBe(200);
      expect((await request('collector/session', token(2, 20))).status).toBe(200);
    } finally { limitedCompanies.delete(10); }
  });
  it('旧客户端明确提示升级而不提交计费任务，新查询路由仍要求登录', async () => {
    const count = file.mock.calls.length;
    const old = await request('collector/file', token(3), { audio: 'xx', hotwords: [] });
    expect(old.status).toBe(426); expect((await old.json()).message).toContain('更新'); expect(file.mock.calls).toHaveLength(count);
    expect((await request('collector/file/tasks/opaque-task')).status).toBe(401);
    expect((await request('collector/file/tasks/opaque-task', token(3))).status).toBe(200);
    limitedCompanies.add(10);
    try { expect((await request('collector/file/tasks/opaque-task', token(3))).status).toBe(403); }
    finally { limitedCompanies.delete(10); }
  });
  it('全员使用不授予设置修改权限；使用范围只能提交布尔值', async () => {
    const input = { enabled: false, fileEnabled: true, realtimeEnabled: true, maxConcurrent: 20, allEmployees: false };
    expect((await request('settings/integrations/speech', token(3), input, 'PUT')).status).toBe(403);
    expect(settings.save).not.toHaveBeenCalled();
    expect((await request('settings/integrations/speech', token(), { ...input, allEmployees: 'false' }, 'PUT')).status).toBe(400);
    expect((await request('settings/integrations/speech', token(), input, 'PUT')).status).toBe(200);
    expect(settings.save).toHaveBeenLastCalledWith(expect.objectContaining({ companyId: 10, id: 1 }), input);
  });
  it('全员开放仍拒绝停用员工与停用公司', async () => {
    users.rows[2].status = 'disabled';
    try { expect((await request('collector/session', token(3))).status).toBe(401); }
    finally { users.rows[2].status = 'active'; }
    companies.rows[0].status = 'disabled';
    try { expect((await request('collector/file', token(3), { audio: 'xx', hotwords: [], apiVersion: 2, requestId: '11111111-1111-4111-8111-111111111111' })).status).toBe(401); }
    finally { companies.rows[0].status = 'active'; }
  });
  it('管理员可设置2000并发，越界或非整数请求不进入保存服务', async () => {
    const input = { enabled: true, fileEnabled: true, realtimeEnabled: true, maxConcurrent: 2000 };
    const count = settings.save.mock.calls.length;
    for (const maxConcurrent of [2001, 0, 1.5, '2000'])
      expect((await request('settings/integrations/speech', token(), { ...input, maxConcurrent }, 'PUT')).status).toBe(400);
    expect(settings.save.mock.calls).toHaveLength(count);
    expect((await request('settings/integrations/speech', token(), input, 'PUT')).status).toBe(200);
    expect(settings.save).toHaveBeenLastCalledWith(expect.objectContaining({ companyId: 10, id: 1 }), input);
  });
  it('会话只返回对应公司摘要，客户端不能通过 DTO 传入其他公司', async () => {
    const r = await request('collector/session', token(2, 20)); expect(r.status).toBe(200);
    const body = await r.json(); expect(body.company.id).toBe(20); expect(JSON.stringify(body)).not.toContain('server-test-key');
    expect((await request('collector/file', token(), { audio: 'xx', hotwords: [], apiVersion: 2, requestId: '11111111-1111-4111-8111-111111111111', companyId: 20 })).status).toBe(400);
    const ok = await request('collector/file', token(), { audio: 'xx', hotwords: [], apiVersion: 2, requestId: '11111111-1111-4111-8111-111111111111' }); expect(ok.status).toBe(201);
    expect(file).toHaveBeenLastCalledWith(10, 1, 'xx', [], '11111111-1111-4111-8111-111111111111');
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
      ws.send(encodeFrame(Buffer.from(JSON.stringify({ secret: 'server-test-key', result: { text: '测试原话', utterances: [{ text: '测试原话', end_time: 200, definite: true, words: [{ start_time: 40, end_time: 180 }], secret: 'server-test-key' }] } })), 9, 3, -1));
    }));
    const connect = jest.spyOn(service as any, 'connectVendor').mockImplementation(() => new WebSocket(`ws://127.0.0.1:${vendorPort}`));
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/collector/realtime', { headers: { Authorization: 'Bearer ' + token(3) } });
    try {
      await once(ws, 'open'); ws.send(encodeFrame(Buffer.from(JSON.stringify({ user: { uid: 'spoofed' }, audio: { rate: 999 }, request: {} })), 1));
      ws.send(encodeFrame(Buffer.alloc(6400), 2, 2));
      const [data] = await once(ws, 'message'), frame = decodeFrame(Buffer.from(data));
      expect(JSON.parse(frame.payload.toString()).result.utterances[0].end_time).toBe(200);
      expect(JSON.parse(frame.payload.toString()).result.utterances[0].start_time).toBe(40);
      expect(frame.payload.toString()).not.toContain('server-test-key'); expect(initial.user.uid).toBe('oa-10-3'); expect(initial.audio.rate).toBe(16000);
    } finally { ws.terminate(); connect.mockRestore(); for (const connection of vendor.clients) connection.terminate(); vendor.close(); }
  });
});
