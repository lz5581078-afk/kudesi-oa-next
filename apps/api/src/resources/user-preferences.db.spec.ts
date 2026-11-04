import 'reflect-metadata';
import {randomBytes} from 'crypto';
import {DataSource} from 'typeorm';
import {EXPENSE_SORT_KEY} from '@kudesi/shared';
import {Company,User,UserPreference,FeeArchiveSnapshot} from '../entities';
import {buildDataSourceOptions} from '../database/data-source';
import {buildServices} from '../test-support';
import type {AuthUser} from '../common/auth.decorators';
import {UserPreferencesService} from './user-preferences.service';
import {FeeSnapshotService} from './fee-snapshot.service';
const db=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
db('费用原个人顺序与历史包（真实MySQL）',()=>{
 let ds:DataSource,s:ReturnType<typeof buildServices>,prefs:UserPreferencesService,snaps:FeeSnapshotService,actor:AuthUser,peer:AuthUser,other:AuthUser;
 beforeAll(async()=>{ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:true} as never).initialize();s=buildServices(ds);prefs=new UserPreferencesService(ds);snaps=new FeeSnapshotService(ds,s.resources);const user=async(companyId?:number)=>{if(!companyId){const company=await ds.manager.save(Company,ds.manager.create(Company,{code:randomBytes(8).toString('hex'),name:'合成顺序公司',status:'active'}));companyId=company.id;}const person=await ds.manager.save(User,ds.manager.create(User,{companyId,account:randomBytes(6).toString('hex'),name:'合成维护员',passwordHash:'unused',isCompanyAdmin:true,status:'active',mustChangePassword:false}));return{id:person.id,companyId,name:person.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};};actor=await user();peer=await user(actor.companyId);other=await user();});
 afterAll(async()=>ds?.destroy());
 it('偏好按令牌公司/本人隔离，只有费用查看权可设置，不扩大业务编辑权',async()=>{
 const value={categoryOrders:{root:['12','11']},itemOrders:{'11':['22','21']}};const reader={...actor,permissions:{isCompanyAdmin:false,allow:['resource.finance-fee-items.view'],deny:[]}};
 expect((await prefs.put(reader,EXPENSE_SORT_KEY,value)).value).toEqual(value);expect((await prefs.get(peer,EXPENSE_SORT_KEY)).value.itemOrders).toEqual({});expect((await prefs.get(other,EXPENSE_SORT_KEY)).value.itemOrders).toEqual({});
 await expect(prefs.put({...actor,permissions:{isCompanyAdmin:false,allow:[],deny:[]}},EXPENSE_SORT_KEY,value)).rejects.toThrow(/权限/);await expect(prefs.put(actor,'unknown',value)).rejects.toThrow(/类型/);await expect(prefs.put(actor,EXPENSE_SORT_KEY,{companyId:other.companyId})).rejects.toThrow(/格式/);
 });
 it('费用个人顺序必须在分页之前应用；表头显式排序优先，不改变其他人的顺序',async()=>{
 const cat=await s.resources.create(actor,'finance-fee-categories',{name:'合成顺序分类'});const rows=[];for(let i=0;i<4;i++)rows.push(await s.resources.create(actor,'finance-fee-items',{code:`SORT-${i}`,name:`合成顺序${i}`,categoryId:cat.id}));
 await prefs.put(actor,EXPENSE_SORT_KEY,{categoryOrders:{},itemOrders:{[cat.id]:rows.map(row=>String(row.id))}});
 const query={filters:JSON.stringify({categoryId:cat.id}),referenceOrder:true,pageSize:2};expect((await s.resources.list(actor,'finance-fee-items',{...query,page:1})).items.map(row=>row.id)).toEqual(rows.slice(0,2).map(row=>row.id));expect((await s.resources.list(actor,'finance-fee-items',{...query,page:2})).items.map(row=>row.id)).toEqual(rows.slice(2).map(row=>row.id));
 expect((await s.resources.list(peer,'finance-fee-items',query)).items.map(row=>row.id)).toEqual([rows[3].id,rows[2].id]);expect((await s.resources.list(actor,'finance-fee-items',{...query,sortBy:'code',sortDir:'desc'})).items.map(row=>row.id)).toEqual([rows[3].id,rows[2].id]);await expect(s.resources.list(actor,'finance-customers',{referenceOrder:true})).rejects.toThrow(/顺序/);
 });
 it('快照保存和恢复本人的个人顺序，自动备份保留恢复前顺序，旧NULL快照不猜历史',async()=>{
 const value={categoryOrders:{root:['12','11']},itemOrders:{all:['22','21']}},later={categoryOrders:{root:['11','12']},itemOrders:{all:['21','22']}};
 await prefs.put(actor,EXPENSE_SORT_KEY,value);const snap=await snaps.create(actor,'合成顺序包');await prefs.put(actor,EXPENSE_SORT_KEY,later);await snaps.restore(actor,snap.id);expect((await prefs.get(actor,EXPENSE_SORT_KEY)).value).toEqual(value);expect((await prefs.get(peer,EXPENSE_SORT_KEY)).value.itemOrders).toEqual({});
 const backup=await ds.manager.findOne(FeeArchiveSnapshot,{where:{companyId:actor.companyId,auto:true},order:{id:'DESC'}});expect(backup?.sortPreference).toEqual(later);
 await ds.manager.update(FeeArchiveSnapshot,{id:snap.id},{sortPreference:null});await prefs.put(actor,EXPENSE_SORT_KEY,later);await snaps.restore(actor,snap.id);expect((await prefs.get(actor,EXPENSE_SORT_KEY)).value).toEqual(later);
 await expect(snaps.restore(other,snap.id)).rejects.toThrow(/不存在/);expect(await ds.manager.count(UserPreference,{where:{companyId:actor.companyId}})).toBe(1);
 });
});
