import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, FinanceEntry, ResourceFile, ResourceRecord, User } from '../entities';
import { FinanceDocumentsService } from '../resources/finance-documents.service';
import { EXCLUSIVE_TYPE, familyMembers } from '../resources/product-exclusive';
import { buildServices } from '../test-support';
import { CompanyProductsService } from './company-products.service';

const db = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
db('公司产品图册', () => {
  let ds: DataSource;
  afterAll(async () => { await ds?.destroy(); });

  it('分类和公司隔离，取马甲主品照片与专属归属，按仓计库存，仅授权返回价格和保存属性', async () => {
    ds = await new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME }), migrationsRun: true }).initialize();
    const company = (name: string) => ds.manager.save(Company, { code: randomBytes(8).toString('hex'), name, status: 'active' });
    const [ours, theirs] = await Promise.all([company('公司产品测试'), company('另一家公司')]);
    const owner = await ds.manager.save(User, { companyId: ours.id, account: 'owner', name: '测试运营', passwordHash: 'fixture', status: 'active', mustChangePassword: false });
    const admin: AuthUser = { id: owner.id, companyId: ours.id, name: owner.name, permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    const viewer: AuthUser = { ...admin, permissions: { isCompanyAdmin: false, allow: ['workbench.desk.view'], deny: [] } };
    const { resources, files } = buildServices(ds);
    const service = new CompanyProductsService(ds, resources, files);
    const rec = (type: string, title: string, data: Record<string, unknown>, status = 'active', companyId = ours.id) =>
      ds.manager.save(ResourceRecord, { type, title, data, status, companyId });
    const group = await rec('finance-categories', '生鲜', { archiveType: 'bundle' });
    const leaf = await rec('finance-categories', '水果', { archiveType: 'bundle', parentId: group.id });
    const raw = await resources.create(admin, 'finance-categories', { archiveType: 'raw', name: '测试库存分类', code: 'CATALOG' });
    const archive = await resources.create(admin, 'finance-products', {
      archiveType: 'raw', name: '合成苹果', categoryId: raw.id, specQty: 1, specUnit: 'KG', purchaseSpec: '千克',
      weightG: 1000, purchasePrice: 1, freight: 0, handlingFee: 0, zeroValueReason: '运费：无\n装卸费：无',
    });
    const photo = await ds.manager.save(ResourceFile, {
      companyId: ours.id, resourceType: 'finance-products', resourceId: archive.id, fieldKey: 'photos',
      mime: 'image/jpeg', name: '苹果照片', size: 123, storageKey: 'fixture.jpg',
    });
    const signer = jest.spyOn(files, 'urlOf').mockResolvedValue({ url: 'https://example.invalid/photo', name: photo.name, mime: photo.mime, expiresIn: 300 });
    const base = await rec('finance-base-codes', '苹果', { productId: archive.id, name: '苹果' });
    const alias = await rec('finance-base-codes', '苹果马甲', { canonicalId: base.id, name: '苹果马甲' });
    const members = await familyMembers(ds.manager, ours.id);
    await rec(EXCLUSIVE_TYPE, '专属', { familyKey: members.get(alias.id)!.familyKey, ownerId: owner.id, ownerName: owner.name,
      startsAt: '2000-01-01T00:00:00Z', endsAt: '2099-01-01T00:00:00Z' });
    const sku = await rec('finance-bundles', 'TEST-A', {
      bundleCategoryId: leaf.id, code: 'TEST-A', name: '合成苹果礼盒', jstPriceCents: 2570, weightMode: 'manual', manualWeightG: 2000,
    }, 'verified');
    await rec('finance-bundles', '未分类组合', { name: '未分类组合' }, 'pending');
    await rec('finance-bundles', '已停用', {}, 'inactive');
    const otherSku = await rec('finance-bundles', '其他公司组合', {}, 'verified', theirs.id);
    for (const qty of [1, 2]) await rec('finance-bundle-lines', '主品', { bundleId: qty === 1 ? sku.id : String(sku.id), role: 'main', qty, baseCodeId: alias.id, unit: 'KG' });
    const warehouse = await resources.create(admin, 'finance-warehouses', { name: '合成仓' });
    const supplier = await resources.create(admin, 'finance-suppliers', { name: '合成供应商' });
    const docs = new FinanceDocumentsService(ds);
    const draft = await docs.createDraft(admin, { type: 'purchase-in', date: '2026-11-03', partyId: supplier.id, warehouseId: warehouse.id,
      lines: [{ productId: archive.id, qty: 8, unitPriceCents: 100 }] });
    await docs.post(admin, draft.id);
    await ds.manager.save(FinanceEntry, { companyId: theirs.id, documentId: draft.id, entryDate: '2026-11-03', kind: 'inventory',
      accountId: archive.id, subId: warehouse.id, qty: 30, unit: '千克', amountCents: 0 });

    expect(await service.list(viewer, { category: group.id, keyword: '苹果' })).toMatchObject({
      total: 1, items: [{ id: sku.id, category: '生鲜 / 水果', stock: 2, owners: [owner.name], photo: { name: photo.name } }],
    });
    expect(signer).toHaveBeenCalledWith(ours.id, photo.id, 'finance-products');
    expect((await service.list(viewer, { category: 0 })).items.map(row => row.name)).toEqual(['未分类组合']);
    const detail = await service.detail(viewer, sku.id);
    expect(detail).toMatchObject({ weightG: 2000, photos: [{ name: photo.name }] });
    expect(detail).not.toHaveProperty('priceCents');
    expect((await service.detail({ ...viewer, permissions: { ...viewer.permissions, allow: ['product.price.view'] } }, sku.id)).priceCents).toBe(2570);
    await expect(service.detail(viewer, otherSku.id)).rejects.toThrow('产品不存在');
    await expect(service.setAttributes(viewer, sku.id, { priceRestricted: true, tags: [] })).rejects.toThrow('管理员');
    await service.setAttributes(admin, sku.id, { priceRestricted: true, tags: [' 新品 ', '新品'] });
    expect(await service.detail(viewer, sku.id)).toMatchObject({ priceRestricted: true, tags: ['新品'] });
    await expect(service.setAttributes(admin, otherSku.id, { priceRestricted: true, tags: [] })).rejects.toThrow('产品不存在');
  });
});
