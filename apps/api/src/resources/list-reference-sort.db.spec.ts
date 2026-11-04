import 'reflect-metadata';
import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, Department, ResourceRecord, User } from '../entities';
import { buildServices } from '../test-support';
import { ResourcesService } from './resources.service';
const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
d('通用列表小数与引用显示名排序（隔离数据库）', () => {
 let ds:DataSource, svc:ResourcesService, actor:AuthUser, otherCompany:number;
 beforeAll(async()=>{
  ds=await new DataSource({...buildDataSourceOptions({...process.env, DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:true} as never).initialize();svc=buildServices(ds).resources;
  const company=await ds.manager.save(Company,ds.manager.create(Company,{code:randomBytes(8).toString('hex'),name:'合成排序',status:'active'}));
  otherCompany=(await ds.manager.save(Company,ds.manager.create(Company,{code:randomBytes(8).toString('hex'),name:'合成其他公司',status:'active'}))).id;
  const user=await ds.manager.save(User,ds.manager.create(User,{companyId:company.id,account:'sort',passwordHash:'x',name:'合成用户',isCompanyAdmin:true,status:'active',mustChangePassword:false}));
  actor={id:user.id,companyId:company.id,name:user.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};
 });
 afterAll(async()=>{await ds?.destroy();});
 const insert=(type:string,title:string,data:Record<string,unknown>,companyId=actor.companyId)=>ds.manager.save(ResourceRecord,ds.manager.create(ResourceRecord,{companyId,type,title,data,status:type==='finance-base-codes'?'pending':'active',createdBy:actor.id,updatedBy:actor.id}));
 it('decimal按数值分页排序，保留小数且相同值以ID倒序稳定排序',async()=>{
  const rows=[];for(const weightG of [10,2.125,2.125,0.000001])rows.push(await insert('finance-base-codes','numeric',{name:'numeric',weightG}));
  const q={keyword:'',sortBy:'weightG',sortDir:'asc' as const,pageSize:2};
  const first=await svc.list(actor,'finance-base-codes',q),second=await svc.list(actor,'finance-base-codes',{...q,page:2});
  expect([...first.items,...second.items].map(r=>r.id)).toEqual([rows[3].id,rows[2].id,rows[1].id,rows[0].id]);
 });
 it('树引用按DTO完整路径排序，不按ID或末级名替代',async()=>{
  const z=await insert('finance-categories','Z root',{name:'Z root'}),a=await insert('finance-categories','A root',{name:'A root'});
  const za=await insert('finance-categories','A leaf',{name:'A leaf',parentId:z.id}),az=await insert('finance-categories','Z leaf',{name:'Z leaf',parentId:a.id});
  const b=await insert('finance-base-codes','tree Z',{name:'tree Z',categoryId:za.id}),c=await insert('finance-base-codes','tree A',{name:'tree A',categoryId:az.id});
  const result=await svc.list(actor,'finance-base-codes',{sortBy:'categoryId',sortDir:'asc',fieldKey:'categoryId',fieldValue:String(a.id)});
  expect(result.items.map(r=>r.id)).toEqual([c.id]);
  const all=await svc.list(actor,'finance-base-codes',{sortBy:'categoryId',sortDir:'asc',pageSize:200});
  const matched=all.items.filter(r=>[b.id,c.id].includes(r.id));expect(matched.map(r=>r.id)).toEqual([c.id,b.id]);expect(matched[0].refLabels.categoryId).toBe('A root / Z leaf');
 });
 it('普通引用按同公司title排序，跨公司引用仅按不可读标签；受限成本仍403',async()=>{
  const z=await insert('finance-products','Z item',{}),a=await insert('finance-products','A item',{}),foreign=await insert('finance-products','AAAA private',{},otherCompany);
  const bz=await insert('finance-base-codes','ref Z',{productId:z.id}),ba=await insert('finance-base-codes','ref A',{productId:a.id}),bf=await insert('finance-base-codes','ref missing',{productId:foreign.id});
  const all=await svc.list(actor,'finance-base-codes',{sortBy:'productId',sortDir:'asc',pageSize:200});
  const matched=all.items.filter(r=>[bz.id,ba.id,bf.id].includes(r.id));expect(matched.map(r=>r.id)).toEqual([bf.id,ba.id,bz.id]);expect(matched[0].refLabels.productId).toBe(`#${foreign.id}（已不存在）`);
  const viewer={...actor,permissions:{isCompanyAdmin:false,allow:['resource.finance-base-codes.view'],deny:[]}};
  await expect(svc.list(viewer,'finance-base-codes',{sortBy:'cost',sortDir:'asc'})).rejects.toMatchObject({status:403});
 });
 it('员工和部门引用按各自同公司名称排序',async()=>{
  const users:User[]=[],depts:Department[]=[];
  for(const name of ['Z name','A name']){
   users.push(await ds.manager.save(User,ds.manager.create(User,{companyId:actor.companyId,account:randomBytes(8).toString('hex'),passwordHash:'x',name,isCompanyAdmin:false,status:'active',mustChangePassword:false})));
   depts.push(await ds.manager.save(Department,ds.manager.create(Department,{companyId:actor.companyId,name,status:'active',parentId:null})));
  }
  const z=await insert('self-media','Z account',{name:'Z account',operatorUserId:users[0].id,operatorDeptId:depts[0].id}),a=await insert('self-media','A account',{name:'A account',operatorUserId:users[1].id,operatorDeptId:depts[1].id});
  for(const sortBy of ['operatorUserId','operatorDeptId']){
   expect((await svc.list(actor,'self-media',{sortBy,sortDir:'asc'})).items.map(row=>row.id)).toEqual([a.id,z.id]);
   expect((await svc.list(actor,'self-media',{sortBy,sortDir:'desc'})).items.map(row=>row.id)).toEqual([z.id,a.id]);
  }
 });

});
