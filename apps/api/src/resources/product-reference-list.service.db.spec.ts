import 'reflect-metadata';
import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, Position, ResourceRecord, User } from '../entities';
import { buildServices } from '../test-support';
import { ResourcesService } from './resources.service';

const suite = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
suite('R05商品列表真实服务派生与分页排序（隔离MySQL）', () => {
  let ds: DataSource, resources: ResourcesService, boss: AuthUser, viewer: AuthUser, warehouse: AuthUser, companyId: number, otherCompanyId: number;
  let products: ResourceRecord[], supplier: ResourceRecord, category: ResourceRecord;
  const row = (type: string, data: Record<string, unknown>, options: { companyId?: number; title?: string; status?: string } = {}) => ds.manager.save(ResourceRecord, ds.manager.create(ResourceRecord, { companyId: options.companyId ?? companyId, type, data, title: options.title ?? 'R05合成记录', status: options.status ?? 'active', createdBy: boss.id, updatedBy: boss.id }));
  beforeAll(async () => {
    ds = await new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME }), migrationsRun: false } as never).initialize(); resources = buildServices(ds).resources;
    const companies = await ds.manager.save(Company, ['本公司', '外公司'].map(name => ds.manager.create(Company, { code: 'pr' + randomBytes(7).toString('hex'), name: 'R05服务合成' + name, status: 'active' }))); [companyId, otherCompanyId] = companies.map(company => company.id);
    const makeActor = async (account: string, admin: boolean, positionId: number | null = null): Promise<AuthUser> => {
      const user = await ds.manager.save(User, ds.manager.create(User, { companyId, account, name: account, passwordHash: 'synthetic', status: 'active', isCompanyAdmin: admin, positionId }));
      return { id: user.id, companyId, name: user.name, permissions: { isCompanyAdmin: admin, allow: admin ? [] : ['resource.finance-products.view'], deny: [] } };
    };
    boss = await makeActor('admin', true); viewer = await makeActor('viewer', false);
    const position = await ds.manager.save(Position, ds.manager.create(Position, { companyId, name: '真实合成仓库岗位', workspaceType: 'warehouse', status: 'active' })); warehouse = await makeActor('warehouse', false, position.id);
    supplier = await row('finance-suppliers', { name: '来源历史名称不作为标题' }, { title: '真实同公司供应商' }); category = await row('finance-categories', { archiveType: 'raw', name: '合成原料类', categoryCode: 'R05-CAT', code: 'NOT-CATEGORY-CODE' });
    products = await ds.manager.save(ResourceRecord, Array.from({ length: 205 }, (_, index) => ds.manager.create(ResourceRecord, { companyId, type: 'finance-products', title: '合成商品' + (index + 1), status: 'active', data: { name: '合成商品' + (index + 1), code: 'R05-' + (index + 1), archiveType: 'raw', categoryId: category.id, purchaseSpec: '千克', specQty: 1, specUnit: 'KG', purchasePrice: 123.4567, freight: 20.0001, handlingFee: 5, totalCost: 148.4568, latestUnitCost: 148.4568 }, createdBy: boss.id, updatedBy: boss.id })));
    const sourceRows = products.slice(0, 203).map((product, index) => ds.manager.create(ResourceRecord, { companyId, type: 'finance-product-sources', title: '合成有效来源', status: 'active', data: { productId: product.id, supplierId: supplier.id, originArea: '产区' + (203 - index), priceUpdatedAt: '2026-01-01T00:00:00Z', purchasePrice: 123.4567 }, createdBy: boss.id, updatedBy: boss.id }));
    sourceRows.push(ds.manager.create(ResourceRecord, { companyId, type: 'finance-product-sources', title: '只有停用来源', status: 'inactive', data: { productId: products[203].id, supplierId: supplier.id, originArea: '停用来源不作最新产区' }, createdBy: boss.id, updatedBy: boss.id }));
    for (let index = 0; index < 8; index++) sourceRows.push(ds.manager.create(ResourceRecord, { companyId, type: 'finance-product-sources', title: '同商品停用来源' + index, status: 'inactive', data: { productId: products[0].id, supplierId: supplier.id, originArea: '较新停用不采用', priceUpdatedAt: '2099-01-01' }, createdBy: boss.id, updatedBy: boss.id }));
    await ds.manager.save(ResourceRecord, sourceRows);
  });
  afterAll(async () => { await ds?.destroy(); });
  const list = (sortBy: string, sortDir: 'asc' | 'desc', page = 1, actor = boss) => resources.list(actor, 'finance-products', { tab: 'raw', sortBy, sortDir, page, pageSize: 200 });
  it('真实list/get都回同一四事实，来源含停用且最新只取启用；无来源不从商品旧值猜测', async () => {
    const detail = await resources.get(boss, 'finance-products', products[0].id);
    expect(detail.data).toMatchObject({ __sourceCount: 9, __sourceOrigin: '产区203', __sourceSupplier: '真实同公司供应商', __categoryCode: 'R05-CAT' });
    const page = await list('__sourceCount', 'desc'); expect(page.total).toBe(205);
    expect(page.items[0].id).toBe(products[0].id); expect(page.items[0].data).toMatchObject({ __sourceCount: 9, __sourceOrigin: '产区203', __sourceSupplier: '真实同公司供应商', __categoryCode: 'R05-CAT' });
    const empty = await resources.get(boss, 'finance-products', products[204].id); expect(empty.data).toMatchObject({ __sourceCount: 0, __sourceOrigin: '', __sourceSupplier: '', __categoryCode: 'R05-CAT' });
  });
  it('count在完整205条上排序再分页，相同计数保持原id降序，两页无重复缺失', async () => {
    const first = await list('__sourceCount', 'asc'), second = await list('__sourceCount', 'asc', 2);
    expect(first.total).toBe(205); expect(first.items).toHaveLength(200); expect(second.items).toHaveLength(5);
    const ids = [...first.items, ...second.items].map(item => item.id);
    expect(ids).toEqual([products[204].id, ...products.slice(1, 204).reverse().map(product => product.id), products[0].id]);
    expect(new Set(ids).size).toBe(205); expect(second.items[4].data.__sourceCount).toBe(9);
  });
  it('origin按中文数字全量排序，默认末页商品可升至第一页；无来源/仅停用空值两向末尾', async () => {
    for (const direction of ['asc', 'desc'] as const) {
      const first = await list('__sourceOrigin', direction), second = await list('__sourceOrigin', direction, 2), ids = [...first.items, ...second.items].map(item => item.id);
      const active = direction === 'asc' ? products.slice(0, 203).reverse() : products.slice(0, 203);
      expect(ids).toEqual([...active.map(product => product.id), products[204].id, products[203].id]);
      expect(first.items[0].id).toBe(direction === 'asc' ? products[202].id : products[0].id);
      expect(second.items.slice(-2).map(item => item.data.__sourceOrigin)).toEqual(['', '']);
    }
  });
  it('普通无成本查看者可读非金额事实，但DTO不含成本价格且合计排序在服务端拒绝', async () => {
    await expect(list('__freightHandling', 'asc', 1, viewer)).rejects.toThrow(/权限|成本|查看/);
    const detail = await resources.get(viewer, 'finance-products', products[0].id), page = await list('__sourceCount', 'desc', 1, viewer);
    expect(detail.data.__sourceCount).toBe(9); expect(page.items[0].id).toBe(products[0].id);
    for (const data of [detail.data, page.items[0].data]) for (const key of ['purchasePrice', 'freight', 'handlingFee', 'totalCost', 'latestUnitCost', '__freightHandling']) expect(data).not.toHaveProperty(key);
  });
  it('真实仓库岗位精简get/list清除新事实，五种虚拟排序都拒绝，不以伪user标志触发', async () => {
    const detail = await resources.get(warehouse, 'finance-products', products[0].id);
    expect(detail.warehouseMode).toBe(true);
    const page = await resources.list(warehouse, 'finance-products', { tab: 'raw', page: 1, pageSize: 1 }); expect(page.items[0].warehouseMode).toBe(true);
    for (const data of [detail.data, page.items[0].data]) for (const key of ['__sourceCount', '__sourceOrigin', '__sourceSupplier', '__categoryCode']) expect(data).not.toHaveProperty(key);
    for (const sortBy of ['__sourceCount', '__sourceOrigin', '__sourceSupplier', '__categoryCode', '__freightHandling']) await expect(list(sortBy, 'asc', 1, warehouse)).rejects.toThrow(/排序|仓库|权限/);
  });
  it('跨公司source/supplier/category不会混入，未知商品排序键继续拒绝', async () => {
    const foreignSupplier = await row('finance-suppliers', { name: '真实同公司供应商' }, { companyId: otherCompanyId, title: '外公司不可见标题' });
    const foreignCategory = await row('finance-categories', { categoryCode: '外公司不可见标识' }, { companyId: otherCompanyId });
    const foreignProduct = await row('finance-products', { archiveType: 'raw' }, { companyId: otherCompanyId });
    await row('finance-product-sources', { productId: products[0].id, supplierId: foreignSupplier.id, originArea: '外公司不可见来源', priceUpdatedAt: '2099-01-01' }, { companyId: otherCompanyId });
    const ownProduct = await row('finance-products', { archiveType: 'shipping_material', categoryId: foreignCategory.id, supplierId: supplier.id });
    await row('finance-product-sources', { productId: ownProduct.id, supplierId: foreignSupplier.id, supplierName: '真实同公司供应商', originArea: '本公司来源', priceUpdatedAt: '2026-01-01' });
    expect((await resources.get(boss, 'finance-products', products[0].id)).data).toMatchObject({ __sourceCount: 9, __sourceOrigin: '产区203', __sourceSupplier: '真实同公司供应商' });
    expect((await resources.get(boss, 'finance-products', ownProduct.id)).data).toMatchObject({ __sourceCount: 1, __sourceOrigin: '本公司来源', __sourceSupplier: '', __categoryCode: '' });
    await expect(resources.get(viewer, 'finance-products', foreignProduct.id)).rejects.toThrow(/不存在/);
    const page = await list('__sourceOrigin', 'asc'); expect(page.total).toBe(205); expect(page.items.some(item => item.id === foreignProduct.id)).toBe(false);
    await expect(list('__unknownProductSort', 'asc')).rejects.toThrow(/排序/);
  });
});
