import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LegacySessionController } from './legacy-session.controller';
import { LegacySessionRuntime } from './legacy-session.service';

describe('旧助手真实HTTP绑定限流与高频心跳豁免', () => {
  let app: INestApplication, base: string;
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [ThrottlerModule.forRoot([{ ttl: 60000, limit: 3 }])], controllers: [LegacySessionController], providers: [
      { provide: APP_GUARD, useClass: ThrottlerGuard }, { provide: LegacySessionRuntime, useValue: { serve: (_req: unknown, res: any) => res.status(400).json({ message: 'synthetic route probe' }) } },
    ] }).compile();
    app = module.createNestApplication({ logger: false }); app.setGlobalPrefix('api'); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
  });
  afterAll(async () => app?.close());
  it('register使用显式路由保留限流，不落入agent通配豁免', async () => {
    for (let index = 0; index < 3; index++) expect((await fetch(base + '/api/session-manager/agent/register', { method: 'POST' })).status).toBe(400);
    expect((await fetch(base + '/api/session-manager/agent/register', { method: 'POST' })).status).toBe(429);
  });
  it('心跳仍可高频调用，普通员工动作没有顺带豁免', async () => {
    for (let index = 0; index < 5; index++) expect((await fetch(base + '/api/session-manager/agent/heartbeat', { method: 'POST' })).status).toBe(400);
    for (let index = 0; index < 3; index++) expect((await fetch(base + '/api/session-manager/pairings', { method: 'POST' })).status).toBe(400);
    expect((await fetch(base + '/api/session-manager/pairings', { method: 'POST' })).status).toBe(429);
  });
});
