import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import { PermissionsGuard } from '../common/permissions.guard';
import { CryptoService } from '../common/crypto.service';
import { Company } from '../entities';
import { OutboxService, type RemoteCategory } from '../outbox/outbox.service';
import { ResourcesService } from './resources.service';
import { JstMaintenanceController } from './jst-maintenance.controller';
import { JstMaintenanceService } from './jst-maintenance.service';
import { DUPLICATE_CATEGORY_REASON } from './jst-upload-categories';

const category = (id: string, name: string, parentId = '0'): RemoteCategory => ({ id, name, parentId, sort: null, enable: true });
describe('远端同名分类 HTTP 边界（真实controller/service，全部fake sender）', () => {
  let app: INestApplication, url: string;
  const createRecord = jest.fn(async () => ({ id: 10 })), enqueueUpload = jest.fn(async () => ({ queued: true }));
  const senderFor = jest.fn(async (companyId: number) => ({ configured: true, targetKey: `synthetic-${companyId}`, send: jest.fn(), searchNormal: async () => [], readCategories: async () => companyId === 21 ? [category('a', '甲'), category('b', '乙'), category('a1', '苹果', 'a'), category('b1', '苹果', 'b'), category('ok', '唯一', 'a')] : [category('other', '另一公司分类')] }));
  beforeAll(async () => {
    const em = { find: jest.fn(async () => []), findOne: jest.fn(async (entity: unknown) => entity === Company ? { id: 21 } : null) };
    const ds = { manager: em, transaction: async (callback: (manager: unknown) => Promise<unknown>) => callback(em) };
    const service = new JstMaintenanceService(ds as unknown as DataSource, { createRecord } as unknown as ResourcesService, { senderFor, enqueueUpload } as unknown as OutboxService, new CryptoService({ synthetic: randomBytes(32) }, 'synthetic'));
    const module = await Test.createTestingModule({ controllers: [JstMaintenanceController], providers: [{ provide: JstMaintenanceService, useValue: service }, { provide: APP_GUARD, useClass: PermissionsGuard }] }).compile();
    app = module.createNestApplication();
    app.use((req: { headers: Record<string, string>; user?: unknown }, _res: unknown, next: () => void) => { if (req.headers.authorization) req.user = { id: 7, companyId: req.headers.authorization === 'Bearer other' ? 99 : 21, name: '合成人员', permissions: { isCompanyAdmin: true, allow: [], deny: [] } }; next(); });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })); await app.listen(0, '127.0.0.1'); url = await app.getUrl();
  });
  afterAll(async () => { await app?.close(); }); beforeEach(() => jest.clearAllMocks());
  const post = (path: string, body: unknown) => fetch(`${url}/finance/jst-maintenance/${path}`, { method: 'POST', headers: { authorization: 'Bearer admin', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const identity = { skuId: 'SYNTHETIC-SKU', styleId: 'SYNTHETIC-STYLE', name: '合成商品' };
  const form = { ...identity, shortName: '合成', propertiesValue: '100g', categoryName: '甲/苹果', brand: '品牌', costPrice: 1, purchasePrice: 1, weight: 0, unit: '个' };
  it('选项只来自token公司；重名可见但禁选且服务端预检返回同一说明', async () => {
    const response = await fetch(`${url}/finance/jst-maintenance/options`, { headers: { authorization: 'Bearer admin' } });
    const options = await response.json(); expect(options.categories).toEqual(['甲/唯一']);
    expect(options.categoryOptions.find((option: { value: string }) => option.value === '甲/苹果')).toMatchObject({ disabled: true, reason: DUPLICATE_CATEGORY_REASON });
    const rejected = await post('check-duplicate', { ...identity, categoryName: '甲/苹果' }); expect(rejected.status).toBe(400); expect((await rejected.json()).message).toBe(DUPLICATE_CATEGORY_REASON);
    const other = await fetch(`${url}/finance/jst-maintenance/options`, { headers: { authorization: 'Bearer other' } }); expect((await other.json()).categories).toEqual(['另一公司分类']);
    expect(senderFor).toHaveBeenCalledWith(21); expect(senderFor).toHaveBeenCalledWith(99);
  });
  it('伪造已核对或绕过分类预检也不能入队；原唯一分类成功状态不变', async () => {
    const checked = await post('check-duplicate', identity); expect(checked.status).toBe(200); const { signature } = await checked.json();
    const invalid = await post('upload', { form, signature, confirmed: true }); expect(invalid.status).toBe(400); expect((await invalid.json()).message).toBe(DUPLICATE_CATEGORY_REASON);
    expect(createRecord).not.toHaveBeenCalled(); expect(enqueueUpload).not.toHaveBeenCalled();
    const valid = await post('upload', { form: { ...form, categoryName: '甲/唯一' }, signature, confirmed: false }); expect(valid.status).toBe(200); expect(await valid.json()).toMatchObject({ id: 10, queued: true, status: 'queued' });
    expect(enqueueUpload).toHaveBeenCalledTimes(1);
  });
  it('请求不能伪造目标公司、分类可用性或远端ID', async () => {
    for (const extra of [{ companyId: 99 }, { disabled: false }, { categoryId: 'a1' }, { categoryOptions: [] }]) expect((await post('check-duplicate', { ...identity, categoryName: '甲/苹果', ...extra })).status).toBe(400);
    expect(senderFor).not.toHaveBeenCalled(); expect(enqueueUpload).not.toHaveBeenCalled();
  });
});
