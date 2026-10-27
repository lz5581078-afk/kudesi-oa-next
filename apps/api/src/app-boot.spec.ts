/**
 * 启动自检：从 AppModule 入口加载（和生产 main.js 同样的加载顺序），所有 provider/controller 的构造函数依赖都必须已定义。
 * 循环 import 会让某个依赖在运行时是 undefined——单元测试手工 new 服务时发现不了，生产启动才报错。
 */
import 'reflect-metadata';

describe('应用启动依赖自检', () => {
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
