import 'reflect-metadata';
import { REQUIRED_PERMISSIONS } from '../common/auth.decorators';
import { AfterSalesController, AppealsController, SupervisionController } from './service.controller';

/** 接口默认拒绝：售后、申诉、监督的每个路由都必须声明权限键，漏写就会被守卫 403。 */
describe('售后/申诉/监督接口都声明了权限', () => {
  for (const [name, cls, prefix] of [['售后', AfterSalesController, 'after-sales.table.'], ['申诉', AppealsController, 'after-sales.appeals.'], ['监督', SupervisionController, 'supervision.center.']] as const) {
    it(`${name}：每个路由都要有权限键，且包含页面查看权限`, () => {
      const methods = Object.getOwnPropertyNames(cls.prototype).filter((m) => m !== 'constructor');
      expect(methods.length).toBeGreaterThan(4);
      for (const m of methods) {
        const perms: string[] | undefined = Reflect.getMetadata(REQUIRED_PERMISSIONS, (cls.prototype as unknown as Record<string, object>)[m]);
        expect(perms && perms.length > 0).toBe(true);
        expect(perms!.some((p) => p.startsWith(prefix))).toBe(true);
      }
    });
  }
});
