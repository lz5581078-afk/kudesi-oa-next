import 'reflect-metadata';
import {randomBytes} from 'crypto';
import {DataSource} from 'typeorm';
import {Company,User} from '../entities';
import {buildDataSourceOptions} from '../database/data-source';
import {buildServices} from '../test-support';
import type {AuthUser} from '../common/auth.decorators';
import {parseCsv} from '../org/staff-import.service';
const db=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
db('24号往来费用CSV沿统一导入导出事务',()=>{
 let ds:DataSource,s:ReturnType<typeof buildServices>,actor:AuthUser,other:AuthUser;
 beforeAll(async()=>{ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:true} as never).initialize();s=buildServices(ds);const user=async()=>{const company=await ds.manager.save(Company,ds.manager.create(Company,{code:randomBytes(8).toString('hex'),name:'合成CSV公司',status:'active'}));const person=await ds.manager.save(User,ds.manager.create(User,{companyId:company.id,account:'csv',name:'合成维护员',passwordHash:'unused',isCompanyAdmin:true,status:'active',mustChangePassword:false}));return{id:person.id,companyId:company.id,name:person.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};};actor=await user();other=await user();});
 afterAll(async()=>ds?.destroy());
 const objects=(csv:string)=>{const [headers,...rows]=parseCsv(csv);return rows.map(row=>Object.fromEntries(headers.map((head,index)=>[head,row[index]??''])));};
 it('供应商原列顺序/路径/电话/银行卡和停用原因完整往返；源CSV不加新扩展字段',async()=>{
 const root=await s.resources.create(actor,'finance-supplier-categories',{name:'合成供货根'}),a=await s.resources.create(actor,'finance-supplier-categories',{name:'甲目录',parentId:root.id}),b=await s.resources.create(actor,'finance-supplier-categories',{name:'乙目录',parentId:root.id});
 const row=await s.resources.create(actor,'finance-suppliers',{code:'CSV-S-1',name:'合成供货商',categoryIds:[a.id,b.id],contact:'合成联系人',phone:'185-000 01',bankAccountName:'合成账户',bankAccountNo:'00001234',note:'两行\n备注',address:'保留新系统补充资料'});await s.resources.changeStatus(actor,'finance-suppliers',row.id,'inactive','停');
 const out=await s.resources.exportCsv(actor,'finance-suppliers',true,{referenceArchive:true,ids:[row.id]});
 expect(parseCsv(out.csv)[0]).toEqual(['供应商分类','供应商编号','供应商名称','供应商简称','简称编号','联系人','联系电话','账户名称','开户行','银行账号','备注','状态','停用原因']);
 const rows=objects(out.csv);expect(rows[0]).toMatchObject({'供应商分类':'合成供货根 / 甲目录；合成供货根 / 乙目录','联系电话':'185-000 01','银行账号':'00001234','状态':'停用','停用原因':'停','备注':'两行\n备注'});
 expect(await s.resources.importRows(actor,'finance-suppliers',rows,false,false,undefined,{})).toMatchObject({committed:true,updated:1,failed:0});
 const fresh=await s.resources.get(actor,'finance-suppliers',row.id);expect(fresh.data).toMatchObject({categoryIds:[a.id,b.id],bankAccountNo:'00001234',address:'保留新系统补充资料'});expect(fresh.statusReason).toBe('停');
 const normal=await s.resources.exportCsv(actor,'finance-suppliers',true,{ids:[row.id]});expect(parseCsv(normal.csv)[0]).toContain('地址');
 });
 it('费用源标签、独立必挂选择及明确空白回填，不改缺列的旧节点',async()=>{
 const category=await s.resources.create(actor,'finance-fee-categories',{name:'合成费用分类'});
 const row=await s.resources.create(actor,'finance-fee-items',{code:'CSV-F-1',name:'合成源费用',categoryId:category.id,direction:'expense',defaultObject:'公司',requiredObject:'yes',accountingSubject:'原科目',isCommon:'yes',platform:'any',needFlow:'by_amount',note:'原备注'});
 const out=await s.resources.exportCsv(actor,'finance-fee-items',false,{referenceArchive:true,ids:[row.id]}),rows=objects(out.csv);
 expect(parseCsv(out.csv)[0]).toEqual(['费用分类','费用类型编号','费用类型名称','会计/核算科目','收支方向','适用平台','是否常用','费用单必须挂归属对象','是否走流程','挂账节点说明','费用备注','状态','停用原因']);expect(rows[0]).toMatchObject({'收支方向':'支出','费用单必须挂归属对象':'是','状态':'正常'});
 rows[0]['会计/核算科目']='';rows[0]['费用备注']='';expect(await s.resources.importRows(actor,'finance-fee-items',rows,false,false,undefined,{})).toMatchObject({committed:true,updated:1});
 const fresh=await s.resources.get(actor,'finance-fee-items',row.id);expect(fresh.data.defaultObject).toBe('公司');expect(fresh.data.requiredObject).toBe('yes');expect(fresh.data.accountingSubject??'').toBe('');expect(fresh.data.note??'').toBe('');
 });
 it('未知/跨公司分类与缺停用原因整批回滚，普通格式能力隔离',async()=>{
 const root=await s.resources.create(actor,'finance-customer-categories',{name:'合成客户根'}),leaf=await s.resources.create(actor,'finance-customer-categories',{name:'合成客户叶',parentId:root.id});
 const foreign=await s.resources.create(other,'finance-customer-categories',{name:'其他公司目录'});
 await expect(s.resources.importRows(actor,'finance-customers',[{'客户编号':'CSV-C-X','客户名称':'不应写入'}],false,false,undefined,{categoryId:foreign.id})).rejects.toThrow('当前分类已不可用');
 const good={'客户编号':'CSV-C-1','客户名称':'合法合成客户','客户分类':'合成客户根 / 合成客户叶','联系电话':'未格式化电话','状态':'正常'};
 const result=await s.resources.importRows(actor,'finance-customers',[good,{'客户编号':'CSV-C-2','客户名称':'不应写入','客户分类':'不存在'}],false,false,undefined,{categoryId:leaf.id});expect(result.committed).toBe(false);expect(result.failed).toBe(1);expect((await s.resources.list(actor,'finance-customers',{})).total).toBe(0);
 const missing=await s.resources.importRows(actor,'finance-customers',[{...good,'状态':'停用','停用原因':''}],false,false,undefined,{categoryId:leaf.id});expect(missing.committed).toBe(false);
 await expect(s.resources.exportCsv(actor,'finance-products',false,{referenceArchive:true})).rejects.toThrow('原版CSV格式');
 const imported=await s.resources.importRows(actor,'finance-customers',[good],false,false,undefined,{categoryId:leaf.id});expect(imported).toMatchObject({committed:true,created:1});
 });
});
