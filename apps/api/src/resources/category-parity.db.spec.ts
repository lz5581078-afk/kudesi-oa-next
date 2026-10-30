import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, ResourceRecord, User } from '../entities';
import { buildServices } from '../test-support';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
d('24号分类管理：目录作用域与归档数量', () => {
  let ds: DataSource;
  beforeAll(async () => { ds = await new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME }), migrationsRun: true }).initialize(); });
  afterAll(async () => { await ds?.destroy(); });
  it('不同上级可同名、同上级不能重名；不同档案类型可复用标识，引用必须明确路径', async () => {
    const token = randomBytes(5).toString('hex'), company = await ds.manager.save(Company, ds.manager.create(Company, { code: 'cat' + token, name: '分类对照测试', status: 'active' }));
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId: company.id, account: 'cat' + token, passwordHash: 'x', name: '管理员', status: 'active', isCompanyAdmin: true, mustChangePassword: false }));
    const actor = { id: u.id, companyId: company.id, name: u.name, permissions: { isCompanyAdmin: true, allow: [], deny: [] } }, svc = buildServices(ds).resources;
    const a = await svc.create(actor, 'finance-categories', { archiveType: 'raw', name: '种子', code: 'ZZ' });
    const b = await svc.create(actor, 'finance-categories', { archiveType: 'raw', name: '食用', code: 'SY' });
    const x = await svc.create(actor, 'finance-categories', { archiveType: 'raw', parentId: a.id, name: '大粒', code: 'DL' });
    const y = await svc.create(actor, 'finance-categories', { archiveType: 'raw', parentId: b.id, name: '大粒', code: 'DL2' });
    await expect(svc.update(actor,'finance-categories',a.id,{archiveType:'package'})).rejects.toThrow(/下级分类/);
    await svc.reorderCategories(actor,'finance-categories',[b.id,a.id]);
    expect((await svc.get(actor,'finance-categories',b.id)).data.sort).toBe(10);
    await expect(svc.reorderCategories(actor,'finance-categories',[a.id,x.id])).rejects.toThrow(/同一个上级/);
    expect((await svc.get(actor,'finance-categories',b.id)).data.sort).toBe(10);
    await expect(svc.create(actor, 'finance-categories', { archiveType: 'raw', parentId: a.id, name: ' 大粒 ', code: 'D3' })).rejects.toThrow(/同一上级/);
    const packaging = await svc.create(actor, 'finance-categories', { archiveType: 'package', name: '种子', code: 'ZZ' });
    expect(packaging.id).not.toBe(a.id);
    await expect(svc.create(actor, 'finance-categories', { archiveType: 'raw', name: '其他', code: 'ZZ' })).rejects.toThrow(/分类码/);
    await expect(svc.findByUnique(ds.manager, company.id, 'finance-categories', '大粒')).rejects.toThrow(/完整分类路径/);
    expect((await svc.findByUnique(ds.manager, company.id, 'finance-categories', '食用 / 大粒'))?.id).toBe(y.id);
    await svc.update(actor, 'finance-categories', x.id, { name: '饱满籽' });
    expect((await svc.findByUnique(ds.manager, company.id, 'finance-categories', '种子 / 饱满籽'))?.id).toBe(x.id);

    const product = await svc.create(actor, 'finance-products', { archiveType: 'raw', name: '原料测试', categoryId: x.id, specQty: 1, specUnit: 'KG', purchaseSpec: '千克', freight: 1, handlingFee: 1 });
    let tree = await svc.categoryTree(actor, 'finance-products', 'categoryId', { tab: 'raw', showHidden: true });
    expect(tree.total).toBe(1);
    expect(tree.nodes.find(n => n.id === a.id)?.count).toBe(1);
    // 测试归档过滤本身，不依赖商品归档时对编码等关联对象的额外处理。
    await ds.manager.update(ResourceRecord, { id: product.id, companyId: company.id }, { archivedAt: new Date() });
    await ds.manager.update(ResourceRecord, { id: y.id, companyId: company.id }, { archivedAt: new Date() });
    tree = await svc.categoryTree(actor, 'finance-products', 'categoryId', { tab: 'raw', showHidden: true });
    expect(tree.total).toBe(0);
    expect(tree.nodes.find(n => n.id === a.id)?.count).toBe(0);
    expect(tree.nodes.some(n => n.id === y.id)).toBe(false);
  });
  it('顶级编号只影响后续自动编号，已保存编码和其他公司保持不变',async()=>{
    const token=randomBytes(5).toString('hex'),company=await ds.manager.save(Company,ds.manager.create(Company,{code:'pf'+token,name:'类型编号测试',status:'active'}));
    const u=await ds.manager.save(User,ds.manager.create(User,{companyId:company.id,account:'pf'+token,passwordHash:'x',name:'管理员',status:'active',isCompanyAdmin:true,mustChangePassword:false}));
    const actor={id:u.id,companyId:company.id,name:u.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}},svc=buildServices(ds).resources;
    const cat=await svc.create(actor,'finance-categories',{archiveType:'raw',name:'种子',code:'ZZ'});
    const fields={archiveType:'raw',categoryId:cat.id,specQty:1,specUnit:'KG',purchaseSpec:'千克',freight:1,handlingFee:1};
    const old=await svc.create(actor,'finance-products',{...fields,name:'原编号'});
    expect(String(old.data.code)).toMatch(/^YL-/);
    await svc.saveArchivePrefix(actor,'finance-categories','raw','ZYL');
    const next=await svc.create(actor,'finance-products',{...fields,name:'新编号'});
    expect(String(next.data.code)).toMatch(/^ZYL-/);
    expect((await svc.get(actor,'finance-products',old.id)).data.code).toBe(old.data.code);
    await expect(svc.saveArchivePrefix(actor,'finance-categories','raw','BZ')).rejects.toThrow(/已被/);
    await expect(svc.saveArchivePrefix(actor,'finance-categories','unknown','BAD')).rejects.toThrow(/不存在/);
    expect(await svc.list({...actor,companyId:company.id+99999},'finance-archive-prefixes',{} as never)).toMatchObject({total:0});
  });

});
