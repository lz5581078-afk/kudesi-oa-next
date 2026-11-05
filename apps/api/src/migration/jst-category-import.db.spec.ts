import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, ResourceRecord, User } from '../entities';
import { buildServices } from '../test-support';
import { importJstCategoryHistory } from './jst-category-import';
import { runLegacyImport } from './runner';
import type { LegacyArchive } from './protocol';
import { readFakeLegacy } from './fake-legacy';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const db = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
db('旧聚水潭分类映射和历史迁移', () => {
  let ds: DataSource;
  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME }), migrationsRun: true } as never);
    await ds.initialize();
  });
  afterAll(async () => ds?.destroy());

  it('增量入口试跑回滚，应用后复用已有分类，重新执行不重复记录', async () => {
    const { resources, files, crypto }=buildServices(ds);
    const company=await ds.manager.save(Company,ds.manager.create(Company,{name:'合成分类增量',code:'TEST-CAT-INCREMENT',status:'active'}));
    const actor=await ds.manager.save(User,ds.manager.create(User,{companyId:company.id,name:'合成管理员',account:'cat-import-admin',passwordHash:'unused',status:'active',isCompanyAdmin:true,mustChangePassword:false}));
    const user={id:actor.id,companyId:company.id,name:actor.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};
    const existing=await resources.create(user,'finance-code-dictionaries',{kind:'product_category',name:'现有旧根',code:'OLDROOT'});
    const source:LegacyArchive={company:{id:7,name:company.name},departments:[],positions:[],employees:[],positionPermissions:[],employeePositions:[],exclusions:[],loadFile:async()=>{throw new Error('不读取附件');},
      records:[{type:'finance-code-dictionaries',id:'11',status:'active',data:{kind:'product_category',name:'现有旧根',code:'OLDROOT',sort:0}},
        {type:'finance-code-dictionaries',id:'12',status:'active',data:{kind:'product_category',name:'旧叶',code:'OLDLEAF',parentId:{legacyRef:{type:'finance-code-dictionaries',id:'11'}},sort:1}}],
      jstCategories:{targets:{},links:[],runs:[{id:8,company_id:7,dictionary_type:'product_category',mode:'manual',status:'success',created_at:'2026-10-24 12:00:00'}]}};
    const options={companyId:company.id,actorId:actor.id,expectedName:company.name,jstCategoriesOnly:true,sourceRowsCrypto:crypto};
    const trial=await runLegacyImport(ds,resources,files,source,{...options,apply:false});
    expect(trial.failures).toEqual([]);
    expect(trial.reused['finance-code-dictionaries']).toBe(1);
    expect(await ds.manager.countBy(ResourceRecord,{companyId:company.id,type:'finance-code-dictionaries'})).toBe(1);
    const applied=await runLegacyImport(ds,resources,files,source,{...options,apply:true,expectedReport:trial});
    expect(applied.failures).toEqual([]);
    const leaf=(await ds.manager.findBy(ResourceRecord,{companyId:company.id,type:'finance-code-dictionaries'})).find(row=>row.data.code==='OLDLEAF');
    expect(leaf?.data.parentId).toBe(existing.id);
    const again=await runLegacyImport(ds,resources,files,source,{...options,apply:false});
    expect(again.reused['jst-category-run']).toBe(1);
    expect(again.reused['finance-code-dictionaries']).toBe(2);
  });

  it('映射本地父级和日志，只启用目标身份一致的关联，并且可重复执行', async () => {
    const { crypto } = buildServices(ds);
    const coid = '10001', app = 'synthetic-category-migration-app', url = 'https://openapi.jushuitan.com';
    const old = hash([9, coid, app, url]), other = 'f'.repeat(64);
    await ds.transaction(async em => {
      await em.save(Company,em.create(Company,{id:900001,name:'合成分类迁移公司',code:'TEST-JST-CATEGORY-MIG',status:'active'}));
      await em.query("INSERT INTO integration_settings(company_id,setting_key,config_enc) VALUES(900001,'jushuitan',?)", [crypto.encrypt(JSON.stringify({ accounts: [{ coid, accessToken: 'synthetic' }] }))]);
      await em.query("INSERT INTO platform_integration_apps(integration_key,environment,app_key_enc,app_secret_enc,base_url,status) VALUES('jushuitan','production',?,?,?,'active')", [crypto.encrypt(app), crypto.encrypt('synthetic'), url]);
      const ids = new Map([['finance-code-dictionaries:11',101],['finance-code-dictionaries:12',102]]);
      const lookup = (type: string, id: unknown) => ids.get(type+':'+id);
      const register = async (type: string, id: unknown, target: number) => { ids.set(type+':'+id, target); };
      const link = (local: number, remote: string, parent: string, key: string) => ({
        company_id: 7, dictionary_type: 'product_category', target_key: key, local_id: local, remote_id: remote, status: 'linked',
        local_json: { id: String(local), parentId: parent, name: '旧分类'+local, sort: 1, enable: true },
        remote_json: { id: remote, parentId: local===11?'0':'201', name: '旧分类'+local, sort: 1, enable: true },
      });
      const source = { targets: {[old]:hash([coid,app,url])}, links: [link(11,'201','0',old),link(12,'202','11',old),link(12,'302','11',other)],
        runs: [{ id: 99, company_id: 7, dictionary_type: 'product_category', target_key: old, mode: 'manual', status: 'success', created_at: '2026-10-24 10:00:00',
          details_json: [{ localId:'12', path:'旧分类11 / 旧分类12', action:'create', status:'success' }] }] };
      for(let i=0;i<2;i++)await importJstCategoryHistory(em,crypto,900001,7,source,lookup,register,()=>{});
      const links = await em.query('SELECT category_id,remote_id,local_json FROM jst_category_links WHERE company_id=900001 ORDER BY category_id');
      expect(links.map((row: {category_id:number;remote_id:string}) => [row.category_id,row.remote_id])).toEqual([[101,'201'],[102,'202']]);
      const parse = (value: unknown) => typeof value==='string'?JSON.parse(value):value;
      expect(parse(links[1].local_json)).toMatchObject({ id:'102', parentId:'101', syncScope:'product' });
      const runs = await em.query('SELECT details_json FROM jst_category_runs WHERE company_id=900001');
      expect(runs).toHaveLength(1);
      expect(parse(runs[0].details_json).changes[0]).toMatchObject({ localId:'102',status:'success' });
      const [raw] = await em.query("SELECT COUNT(*) n FROM legacy_source_rows WHERE company_id=900001 AND source_table='jst_category_sync_links'");
      expect(Number(raw.n)).toBe(3);
      await em.query("DELETE FROM platform_integration_apps WHERE integration_key='jushuitan' AND environment='production'");
    });
  });
});

test('旧基础编码分类保留父级和基础编码的原分类 ID', async () => {
  const out = await readFakeLegacy({
    companies:[{id:7,name:'合成公司'}],
    finance_product_code_dictionary:[
      {id:11,company_id:7,dictionary_type:'product_category',item_name:'旧根',item_code:'ROOT',status:'active'},
      {id:12,company_id:7,dictionary_type:'product_category',item_name:'旧叶',item_code:'LEAF',parent_id:11,status:'active'},
    ],
    finance_product_base_codes:[{id:42,company_id:7,category_dictionary_id:12,final_code:'OLD-SKU',status:'active'}],
  },7,{jstCategoriesOnly:true});
  const leaf = out.records.find(row=>row.type==='finance-code-dictionaries'&&row.id==='12');
  expect(leaf?.data.parentId).toEqual({legacyRef:{type:'finance-code-dictionaries',id:'11'}});
  expect(out.jstCategories?.baseAssignments).toEqual([{id:'42',categoryId:'12',code:'OLD-SKU'}]);
  expect(out.records.every(row=>row.type==='finance-code-dictionaries')).toBe(true);
});
