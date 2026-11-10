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

  it('基础编码目录对应档案，未建码保留，无马甲及无对应分类隐藏，库存与权限隔离', async () => {
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
    const group = await rec('finance-code-dictionaries', '生鲜', { kind: 'product_category', sort: 1 });
    const leaf = await rec('finance-code-dictionaries', '水果', { kind: 'product_category', parentId: group.id, sort: 2 });
    const archiveRoot = await rec('finance-categories', '生鲜', { archiveType: 'purchased' });
    const archiveLeaf = await rec('finance-categories', '水果', { archiveType: 'purchased', parentId: archiveRoot.id });
    const uncoded = await rec('finance-products', '未建码水果', { archiveType: 'purchased', name: '未建码水果', categoryId: archiveLeaf.id });
    const unmapped = await rec('finance-products', '无对应分类', { archiveType: 'purchased' });
    const noAlias = await rec('finance-products', '无马甲原料', { archiveType: 'raw', categoryId: archiveLeaf.id });
    const raw = await resources.create(admin, 'finance-categories', { archiveType: 'raw', name: '测试库存分类', code: 'CATALOG' });
    const archive = await resources.create(admin, 'finance-products', {
      archiveType: 'raw', name: '合成苹果', rawFinishedNames: '苹果马甲\n苹果马甲二', categoryId: raw.id, specQty: 1, specUnit: 'KG', purchaseSpec: '千克',
      weightG: 1000, purchasePrice: 1, freight: 0, handlingFee: 0, zeroValueReason: '运费：无\n装卸费：无',
    });
    const uncodedAlias = await rec('finance-products', '未建码原料', { archiveType: 'raw', rawFinishedNames: '未建码马甲', categoryId: raw.id });
    const photo = await ds.manager.save(ResourceFile, {
      companyId: ours.id, resourceType: 'finance-products', resourceId: archive.id, fieldKey: 'photos',
      mime: 'image/jpeg', name: '苹果照片', size: 123, storageKey: 'fixture.jpg',
    });
    const signer = jest.spyOn(files, 'urlOf').mockResolvedValue({ url: 'https://example.invalid/photo', name: photo.name, mime: photo.mime, expiresIn: 300 });
    const base = await rec('finance-base-codes', '苹果', { productId: archive.id, name: '苹果', codeDictionaryCategoryId: leaf.id });
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
      total: 2, items: [
        { id: archive.id, name: '苹果马甲', alias: '苹果马甲', stock: 8 },
        { id: archive.id, name: '苹果马甲二', alias: '苹果马甲二', category: '生鲜 / 水果', stock: 8, owners: [owner.name], photo: { name: photo.name } },
      ],
    });
    expect(signer).toHaveBeenCalledWith(ours.id, photo.id, 'finance-products');
    expect((await service.list(viewer, { category: 0 })).items).toEqual([]);
    const catalog = await service.list(viewer, { category: group.id });
    expect(catalog.total).toBe(4);
    expect(catalog.items.map(row => row.id)).toEqual(expect.arrayContaining([archive.id, uncoded.id, uncodedAlias.id]));
    expect(catalog.counts[leaf.id]).toBe(4);
    expect(catalog.categories.map(row => row.id)).toEqual([group.id, leaf.id]);
    for (const hidden of [unmapped, noAlias, sku]) await expect(service.detail(viewer, hidden.id)).rejects.toThrow('产品不存在');
    const aliasCards = catalog.items.filter(item => item.id === archive.id);
    expect(new Set(aliasCards.map(item => item.imagePosition)).size).toBe(2);
    const filtered = await service.list(viewer, { keyword: '苹果马甲二' });
    expect(filtered.total).toBe(1);
    const chosen = await service.detail(viewer, archive.id, '苹果马甲二');
    expect(chosen.name).toBe('苹果马甲二');
    expect(chosen.imagePosition).toBe(filtered.items[0].imagePosition);
    await expect(service.detail(viewer, archive.id, '不存在的马甲')).rejects.toThrow('产品不存在');
    const detail = await service.detail(viewer, archive.id);
    expect(detail).toMatchObject({ weightG: 1000, photos: [{ name: photo.name }] });
    expect(detail).not.toHaveProperty('priceCents');
    expect(detail).not.toHaveProperty('purchasePrice');
    await ds.manager.save(FinanceEntry, { companyId: ours.id, documentId: draft.id, entryDate: '2026-11-03', kind: 'inventory', accountId: archive.id, subId: warehouse.id, qty: 3, unit: '袋', amountCents: 0 });
    const mixed = await service.detail(viewer, archive.id);
    expect(mixed.stock).toBeNull();
    expect(mixed.stockBalances).toHaveLength(2);
    expect(mixed.stockBalances).toEqual(expect.arrayContaining([{ unit: '袋', qty: 3 }]));
    await expect(service.setAttributes(admin, unmapped.id, { priceRestricted: true, tags: [] })).rejects.toThrow('产品不存在');
    await expect(service.detail(viewer, otherSku.id)).rejects.toThrow('产品不存在');
    await expect(service.setAttributes(viewer, archive.id, { priceRestricted: true, tags: [] })).rejects.toThrow('管理员');
    await service.setAttributes(admin, archive.id, { priceRestricted: true, tags: [' 新品 ', '新品'] });
    expect(await service.detail(viewer, archive.id)).toMatchObject({ priceRestricted: true, tags: ['新品'] });
    await expect(service.setAttributes(admin, otherSku.id, { priceRestricted: true, tags: [] })).rejects.toThrow('产品不存在');
    await service.setAttributes(admin, archive.id, {priceRestricted:true,tags:[],minimumPriceCents:2990});
    expect(await service.detail(viewer, archive.id, '苹果马甲二')).toMatchObject({minimumPriceCents:2990});
    expect((await service.list(viewer,{keyword:'苹果'})).items.every(p=>p.minimumPriceCents===2990)).toBe(true);
    await service.setAttributes(admin, archive.id, {priceRestricted:true,tags:['旧客户端']});
    expect(await service.detail(viewer, archive.id)).toMatchObject({minimumPriceCents:2990});
    for(const amount of [-1,0,1.5,100000000000]) await expect(service.setAttributes(admin,archive.id,{priceRestricted:true,tags:[],minimumPriceCents:amount})).rejects.toThrow('最低销售价');
    await expect(service.setAttributes(viewer,archive.id,{priceRestricted:true,tags:[],minimumPriceCents:100})).rejects.toThrow('管理员');
    await service.setAttributes(admin,archive.id,{priceRestricted:false,tags:[],minimumPriceCents:2990});
    expect(await service.detail(viewer,archive.id)).toMatchObject({priceRestricted:false,minimumPriceCents:null});
    const manyNames = Array.from({length: 26}, (_, index) => `分页马甲${index}`);
    await ds.manager.update(ResourceRecord, archive.id, {data: {...(await ds.manager.findOneByOrFail(ResourceRecord, {id: archive.id})).data, rawFinishedNames: manyNames.join('\n')}});
    const first = await service.list(viewer, {keyword: '分页马甲'});
    const second = await service.list(viewer, {keyword: '分页马甲', page: 2});
    expect(first.total).toBe(26);
    expect(first.items).toHaveLength(24);
    expect(second.items).toHaveLength(2);
    expect(new Set([...first.items, ...second.items].map(item => item.alias)).size).toBe(26);
  });
});
