/**
 * 启动自检：从 AppModule 入口加载（和生产 main.js 同样的加载顺序），所有 provider/controller 的构造函数依赖都必须已定义。
 * 循环 import 会让某个依赖在运行时是 undefined——单元测试手工 new 服务时发现不了，生产启动才报错。
 */
import 'reflect-metadata';

const FAKE_ENV: Record<string, string> = {
  JWT_SECRET: 'boot-check-jwt-secret-0123456789abcdef',
  DATA_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 7).toString('base64')}`,
  DATA_ENCRYPTION_ACTIVE_KEY: 'k1',
  DB_NAME: 'boot_check',
  DB_USER: 'boot_check',
  DB_PASSWORD: 'boot_check',
};

describe('应用启动依赖自检', () => {
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => { for (const [k, v] of Object.entries(FAKE_ENV)) { saved[k] = process.env[k]; process.env[k] ||= v; } });
  afterAll(() => { for (const k of Object.keys(FAKE_ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it('AppModule 里没有因循环 import 变成 undefined 的构造函数依赖', () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { AppModule } = require('./app.module') as { AppModule: new () => unknown };
      const providers: unknown[] = Reflect.getMetadata('providers', AppModule) ?? [];
      const controllers: unknown[] = Reflect.getMetadata('controllers', AppModule) ?? [];
      const bad: string[] = [];
      for (const cls of [...providers, ...controllers]) {
        if (typeof cls !== 'function') continue;
        const types: unknown[] = Reflect.getMetadata('design:paramtypes', cls) ?? [];
        const selfDeclared: Array<{ index: number }> = Reflect.getMetadata('self:paramtypes', cls) ?? [];
        types.forEach((t, i) => {
          if (t === undefined && !selfDeclared.some((s) => s.index === i)) bad.push(`${cls.name}[${i}]`);
        });
      }
      expect(bad).toEqual([]);
    });
  });
});
