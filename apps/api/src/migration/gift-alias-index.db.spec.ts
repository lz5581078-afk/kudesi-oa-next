import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Company,ResourceRecord,User } from '../entities';
import { buildDataSourceOptions } from '../database/data-source';
import { buildServices } from '../test-support';
import type { AuthUser } from '../common/auth.decorators';
import { verifyGiftAliasIndex } from './gift-alias-index';
const suite=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
suite('赠品派生排重索引原值核对（MySQL）',()=>{
  let ds:DataSource,svc:ReturnType<typeof buildServices>,user:AuthUser,ids:Record<string,number>;
  const rows=()=>[{company_id:3,product_id:'one',name_key:'苹果赠',code_key:'PG'},{company_id:3,product_id:'empty',name_key:null,code_key:null}];
  beforeAll(async()=>{
    ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME??'kudesi_oa_test'}),migrationsRun:true}).initialize();svc=buildServices(ds);
    const c=await ds.manager.save(Company,ds.manager.create(Company,{code:randomBytes(6).toString('hex'),name:'赠品索引核对',status:'active'}));
    const u=await ds.manager.save(User,ds.manager.create(User,{companyId:c.id,name:'管理员',account:null,passwordHash:'!no-login',status:'active',isCompanyAdmin:true,mustChangePassword:false}));
    user={id:u.id,companyId:c.id,name:u.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};
    const category=(await svc.resources.create(user,'finance-categories',{name:'原料类',code:'YS',archiveType:'raw'})).id;
    const product=(name:string,extra={})=>svc.resources.create(user,'finance-products',{archiveType:'raw',name,categoryId:category,purchaseSpec:'千克',specQty:1,specUnit:'KG',purchasePrice:1000,freight:100,handlingFee:50,...extra});
    ids={one:(await product('商品甲',{giftShortName:'苹果 赠',giftCodeShortName:'pg'})).id,empty:(await product('原缺失简称')).id};
  });
  afterAll(async()=>{await ds?.destroy();});
  const verify=(records:Array<Record<string,unknown>>)=>ds.transaction(async em=>{em.queryRunner!.data.legacyImport=true;return verifyGiftAliasIndex({em,resources:svc.resources,user,sourceCompanyId:3,lookup:(_t,id)=>ids[String(id)]},records);});
  it('通过真实商品详情核对全部原键及NULL；不另建索引业务记录、不补空值',async()=>{
    const count=await ds.manager.count(ResourceRecord,{where:{companyId:user.companyId}});
    expect(await verify(rows())).toBe(2);expect(await verify(rows())).toBe(2);
    expect(await ds.manager.count(ResourceRecord,{where:{companyId:user.companyId}})).toBe(count);
    expect((await svc.resources.get(user,'finance-products',ids.empty)).data.giftShortName).toBeUndefined();
  });
  it('外公司、未知原列、丢失商品、重复商品或与页面不同的键均不能视为可重建',async()=>{
    const bad=[{...rows()[0],company_id:4},{...rows()[0],future_column:'not reviewed'},{...rows()[0],product_id:'missing'},{...rows()[0],name_key:'自动补的名'}];
    for(const r of bad)await expect(verify([r])).rejects.toThrow('旧赠品别名索引');
    await expect(verify([rows()[0],rows()[0]])).rejects.toThrow('旧赠品别名索引');
  });
  it('迁移器给旧空值生成简称也必须被拦截，失败事务不保留补值',async()=>{
    await expect(ds.transaction(async em=>{
      em.queryRunner!.data.legacyImport=true;const p=await em.findOneByOrFail(ResourceRecord,{id:ids.empty,companyId:user.companyId});
      await em.update(ResourceRecord,{id:p.id},{data:{...p.data,giftShortName:'生成名',giftCodeShortName:'SCM'}});
      return verifyGiftAliasIndex({em,resources:svc.resources,user,sourceCompanyId:3,lookup:(_t,id)=>ids[String(id)]},rows());
    })).rejects.toThrow('旧赠品别名索引');
    expect((await svc.resources.get(user,'finance-products',ids.empty)).data.giftShortName).toBeUndefined();
  });
});
