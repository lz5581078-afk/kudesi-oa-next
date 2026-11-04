import 'reflect-metadata';
import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, OutboxJob, ResourceChangeLog, ResourceRecord, User } from '../entities';
import { deriveProductReferenceList } from './product-reference-list';

const suite = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
suite('商品原列表只读供货/分类派生（隔离MySQL）', () => {
  let ds: DataSource, companyId: number, otherId: number, userId: number;
  const resource = async (type: string, data: Record<string, unknown>, options: { companyId?: number; status?: string; title?: string; archivedAt?: Date } = {}) => ds.manager.save(ResourceRecord, ds.manager.create(ResourceRecord, {
    companyId: options.companyId ?? companyId, type, data, status: options.status ?? 'active', title: options.title ?? '合成显示标题', createdBy: userId, updatedBy: userId, archivedAt: options.archivedAt ?? null,
  }));
  beforeAll(async () => {
    ds = await new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME }), migrationsRun: false } as never).initialize();
    const companies = await ds.manager.save(Company, ['本公司', '外公司'].map(name => ds.manager.create(Company, { code: 'pl' + randomBytes(7).toString('hex'), name: '列表派生合成' + name, status: 'active' })));
    [companyId, otherId] = companies.map(company => company.id);
    const user = await ds.manager.save(User, ds.manager.create(User, { companyId, account: 'admin', name: '合成核对员', passwordHash: 'synthetic', status: 'active', isCompanyAdmin: true, mustChangePassword: false })); userId = user.id;
  });
  afterAll(async () => { await ds?.destroy(); });
  it('完整计数205条含停用来源；批量页面只用两次白名单SELECT且不改资料、审计或队列', async () => {
    const supplier = await resource('finance-suppliers', { name: '不是显示标题', purchasePrice: 987654 }, { title: '真实供应商标题', status: 'inactive' });
    const category = await resource('finance-categories', { categoryCode: 'RAW-CATEGORY', code: '不代替分类标识', secret: '禁止返回整份JSON' });
    const products = await Promise.all(['raw', 'shipping_material', 'raw'].map(archiveType => resource('finance-products', { archiveType, categoryId: category.id, purchaseHistory: [{ cost: 123456 }] })));
    await ds.manager.save(ResourceRecord, Array.from({ length: 205 }, (_, index) => ds.manager.create(ResourceRecord, { companyId, type: 'finance-product-sources', title: '合成来源' + index, status: index === 204 ? 'active' : 'inactive', data: { productId: products[0].id, supplierId: supplier.id, originArea: '真实最新产区', priceUpdatedAt: '2026-01-01T00:00:00Z', purchasePrice: 987654, secret: '来源私有字段' }, createdBy: userId, updatedBy: userId })));
    await resource('finance-product-sources', { productId: products[0].id, supplierId: supplier.id }, { status: 'deleted' });
    await resource('finance-product-sources', { productId: products[0].id, supplierId: supplier.id }, { archivedAt: new Date() });
    const before = await ds.manager.find(ResourceRecord, { where: { companyId }, order: { id: 'ASC' } });
    const counts = async () => [await ds.manager.count(ResourceChangeLog, { where: { companyId } }), await ds.manager.count(OutboxJob, { where: { companyId } })];
    const beforeCounts = await counts();
    const runner = ds.createQueryRunner(); await runner.connect();
    try {
      const query = jest.spyOn(runner, 'query');
      const result = await deriveProductReferenceList(runner.manager, companyId, products);
      expect(result.get(products[0].id)).toEqual({ __sourceCount: 205, __sourceOrigin: '真实最新产区', __sourceSupplier: '真实供应商标题', __categoryCode: 'RAW-CATEGORY' });
      expect(result.get(products[1].id)).toEqual({ __sourceCount: 0, __sourceOrigin: '', __sourceSupplier: '', __categoryCode: 'RAW-CATEGORY' });
      expect(query).toHaveBeenCalledTimes(2);
      for (const [sql] of query.mock.calls) { expect(sql).toMatch(/^SELECT /); expect(sql).not.toMatch(/purchasePrice|purchaseHistory|secret|SELECT\s+[^\n]*\.\*/i); }
      for (const value of result.values()) expect(Object.keys(value).sort()).toEqual(['__categoryCode', '__sourceCount', '__sourceOrigin', '__sourceSupplier']);
      expect(JSON.stringify([...result])).not.toMatch(/987654|123456|私有|secret|purchase/);
    } finally { await runner.release(); }
    expect(await ds.manager.find(ResourceRecord, { where: { companyId }, order: { id: 'ASC' } })).toEqual(before);
    expect(await counts()).toEqual(beforeCounts);
  });
  it('采购价时间优先于资料更新时间，相同时间沿legacySourceId和id的canonical排序', async () => {
    const supplier = await resource('finance-suppliers', {}, { title: '排序供应商' });
    const legacy = await resource('finance-products', { archiveType: 'raw' }), byId = await resource('finance-products', { archiveType: 'shipping_material' }), fallback = await resource('finance-products', { archiveType: 'raw' });
    const olderId = await resource('finance-product-sources', { productId: legacy.id, supplierId: supplier.id, originArea: '大legacy胜出', priceUpdatedAt: '2026-01-01T00:00:00Z', legacySourceId: '9007199254740993' });
    const newerId = await resource('finance-product-sources', { productId: legacy.id, supplierId: supplier.id, originArea: '小legacy后创建', priceUpdatedAt: '2026-01-01T00:00:00Z', legacySourceId: '9007199254740992' });
    await ds.manager.query('UPDATE resource_records SET updated_at=? WHERE id=? AND company_id=?', ['2030-01-01 00:00:00', newerId.id, companyId]);
    await resource('finance-product-sources', { productId: legacy.id, supplierId: supplier.id, originArea: '停用较新不采用', priceUpdatedAt: '2099-01-01T00:00:00Z' }, { status: 'inactive' });
    for (const originArea of ['旧ID', '新ID胜出']) await resource('finance-product-sources', { productId: byId.id, supplierId: supplier.id, originArea, priceUpdatedAt: '2026-01-01T00:00:00Z' });
    await resource('finance-product-sources', { productId: fallback.id, supplierId: supplier.id, originArea: '有效采购时间', priceUpdatedAt: '2025-01-01T00:00:00Z' });
    const invalid = await resource('finance-product-sources', { productId: fallback.id, supplierId: supplier.id, originArea: '无效采购时间回退updatedAt', priceUpdatedAt: 'invalid' });
    await ds.manager.query('UPDATE resource_records SET updated_at=? WHERE id IN (?,?) AND company_id=?', ['2026-01-01 00:00:00', olderId.id, invalid.id, companyId]);
    const result = await deriveProductReferenceList(ds.manager, companyId, [legacy, byId, fallback]);
    expect(result.get(legacy.id)).toMatchObject({ __sourceCount: 3, __sourceOrigin: '大legacy胜出' });
    expect(result.get(byId.id)).toMatchObject({ __sourceOrigin: '新ID胜出' });
    expect(result.get(fallback.id)).toMatchObject({ __sourceOrigin: '无效采购时间回退updatedAt' });
  });
  it('跨公司来源/供应商/分类与错误资源类型不参与；不按历史同名或商品旧供应商猜测', async () => {
    const supplier = await resource('finance-suppliers', {}, { title: '相同供应商名' });
    const foreignSupplier = await resource('finance-suppliers', {}, { companyId: otherId, title: '相同供应商名' });
    const foreignCategory = await resource('finance-categories', { categoryCode: '外公司秘密标识' }, { companyId: otherId });
    const wrongType = await resource('finance-customers', { categoryCode: '客户不是分类' });
    const product = await resource('finance-products', { archiveType: 'raw', categoryId: foreignCategory.id, supplierId: supplier.id, originArea: '不读商品旧产区' });
    const inactiveOnly = await resource('finance-products', { archiveType: 'shipping_material', categoryId: wrongType.id });
    await resource('finance-product-sources', { productId: product.id, supplierId: foreignSupplier.id, supplierName: '相同供应商名', originArea: '本公司来源产区', priceUpdatedAt: '2026-01-01' });
    await resource('finance-product-sources', { productId: product.id, supplierId: supplier.id, originArea: '外公司来源不得混入', priceUpdatedAt: '2099-01-01' }, { companyId: otherId });
    await resource('finance-product-sources', { productId: inactiveOnly.id, supplierId: supplier.id, originArea: '停用产区' }, { status: 'inactive' });
    const foreignProduct = await resource('finance-products', { archiveType: 'raw' }, { companyId: otherId });
    const result = await deriveProductReferenceList(ds.manager, companyId, [product, inactiveOnly, foreignProduct, wrongType]);
    expect([...result.keys()]).toEqual([product.id, inactiveOnly.id]);
    expect(result.get(product.id)).toEqual({ __sourceCount: 1, __sourceOrigin: '本公司来源产区', __sourceSupplier: '', __categoryCode: '' });
    expect(result.get(inactiveOnly.id)).toEqual({ __sourceCount: 1, __sourceOrigin: '', __sourceSupplier: '', __categoryCode: '' });
  });
  it('空页面不查询，也不借同公司未列出的商品来源派生记录', async () => {
    const runner = ds.createQueryRunner(); await runner.connect();
    try { const query = jest.spyOn(runner, 'query'); expect((await deriveProductReferenceList(runner.manager, companyId, [])).size).toBe(0); expect(query).not.toHaveBeenCalled(); }
    finally { await runner.release(); }
  });
});
