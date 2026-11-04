import 'reflect-metadata';
import * as crypto from 'crypto';
import {DataSource} from 'typeorm';
import {buildDataSourceOptions} from '../database/data-source';
import {Company,ResourceRecord,User,ResourceChangeLog} from '../entities';
import type {AuthUser} from '../common/auth.decorators';
import {buildServices} from '../test-support';
import type {ResourcesService} from './resources.service';
import {CostService} from './cost.service';
import {buildSnapshot,baseCodeOutbound} from './base-code-support';
import {RESOURCE_IMPORT_PROFILES,getResourceImportProfile} from '@kudesi/shared';
const d=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
d('通用工作簿profile（隔离MySQL）',()=>{
  let ds:DataSource,svc:ResourcesService,boss:AuthUser,other:AuthUser;
  beforeAll(async()=>{
    ds=new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME ?? 'kudesi_oa_test_a'}),migrationsRun:true} as never);await ds.initialize();svc=buildServices(ds).resources;
    const user=async()=>{const company=await ds.manager.save(Company,ds.manager.create(Company,{code:crypto.randomBytes(8).toString('hex'),name:'合成profile公司',status:'active'}));const person=await ds.manager.save(User,ds.manager.create(User,{companyId:company.id,name:'合成导入员',account:'synthetic',passwordHash:'unused',status:'active',isCompanyAdmin:true,mustChangePassword:false}));return{id:person.id,companyId:company.id,name:person.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};};boss=await user();other=await user();
  });
  afterAll(async()=>{await ds?.destroy();});
  const workbook=(rows:Array<Record<string,string>>)=>[{name:'销售平台',headers:[...getResourceImportProfile('platforms')!.sheets[0].headers],rows}];
  it('首个模块实际闭环：预检写后回滚，执行同签名一次原子导入并沿统一校验',async()=>{
    const sheets=workbook([{平台名称:'合成平台一',平台编码:'HCONE',排序:'10',状态:'启用'}]);
    const before=await ds.manager.count(ResourceChangeLog,{where:{companyId:boss.companyId}});
    const preview=await svc.importProfile(boss,'platforms',sheets,true);expect(preview).toMatchObject({dryRun:true,committed:false,created:1,failed:0});expect(preview.signature).toBeTruthy();
    expect(await ds.manager.count(ResourceRecord,{where:{companyId:boss.companyId,type:'finance-platforms'}})).toBe(0);expect(await ds.manager.count(ResourceChangeLog,{where:{companyId:boss.companyId}})).toBe(before);
    const done=await svc.importProfile(boss,'platforms',sheets,false,preview.signature!);expect(done).toMatchObject({committed:true,created:1,failed:0});
    expect((await svc.list(boss,'finance-platforms',{})).items[0].data).toMatchObject({name:'合成平台一',code:'HCONE',sortOrder:10});
  });
  it('一个错误全组回滚，来源sheet/行号保留；拒绝无预检/过期签名与无资源导入权限',async()=>{
    const sheets=workbook([{平台名称:'合成先成功',平台编码:'HCGOOD'},{平台名称:'',平台编码:'HCBAD'}]);
    const preview=await svc.importProfile(boss,'platforms',sheets,true);expect(preview.failed).toBe(1);expect(preview.results.find(row=>row.action==='error')).toMatchObject({sheet:'销售平台',line:3});
    const done=await svc.importProfile(boss,'platforms',sheets,false,preview.signature!);expect(done.committed).toBe(false);expect(await ds.manager.findOneBy(ResourceRecord,{companyId:boss.companyId,type:'finance-platforms',title:'合成先成功'})).toBeNull();
    await expect(svc.importProfile(boss,'platforms',workbook([{平台名称:'合成需要预检',平台编码:'HCPRE'}]),false)).rejects.toThrow(/重新预检/);
    const valid=workbook([{平台名称:'合成签名过期',平台编码:'HCOLD'}]);const old=await svc.importProfile(boss,'platforms',valid,true);await svc.create(boss,'finance-brands',{name:'合成并发品牌',code:'HC'});
    await expect(svc.importProfile(boss,'platforms',valid,false,old.signature!)).rejects.toThrow(/重新预检/);
    await expect(svc.importProfile({...boss,permissions:{isCompanyAdmin:false,allow:['finance.master-import.view'],deny:[]}},'platforms',valid,true)).rejects.toThrow(/导入权限/);
  });
  it('自然键仅本公司匹配，不能用companyId/未知列越界，普通单资源导入仍可用',async()=>{
    await svc.create(other,'finance-platforms',{name:'合成同名平台',code:'OTHER'});
    const sheets=workbook([{平台名称:'合成同名平台',平台编码:'MINE'}]);const preview=await svc.importProfile(boss,'platforms',sheets,true);const done=await svc.importProfile(boss,'platforms',sheets,false,preview.signature!);expect(done.created).toBe(1);
    expect((await svc.list(other,'finance-platforms',{})).items[0].data.code).toBe('OTHER');
    const invalid=await svc.importProfile(boss,'platforms',[{name:'销售平台',rows:[{平台名称:'越界',平台编码:'NO',companyId:String(other.companyId)}]}],true);expect(invalid.failed).toBeGreaterThan(0);
    const single=await svc.importRows(boss,'finance-platforms',[{平台名称:'合成普通单表',平台码:'SINGLE'}],true);expect(single).toMatchObject({dryRun:true,created:1,failed:0});
  });
  const execute=async(id:string,sheets:Array<{name:string;rows:Array<Record<string,string>>}>)=>{
    const preview=await svc.importProfile(boss,id,sheets,true);
    expect(preview.results.filter(row=>row.action==='error')).toEqual([]);expect(preview.issues).toEqual([]);
    const done=await svc.importProfile(boss,id,sheets,false,preview.signature!);expect(done.committed).toBe(true);return done;
  };
  it('七模块配置沿真实资源落库：分类/独立编码字典/单位/档案/外部基础编码/组合多表联动',async()=>{
    await execute('platforms',workbook([{平台名称:'合成主链平台',平台编码:'CHAIN'}]));
    await execute('archive_categories',[{name:'档案分类',rows:[{档案类型:'原料',一级分类:'合成原料目录',一级分类编码:'RDIR',二级分类:'合成原料子目录',二级分类编码:'RSUB'}]}]);
    await execute('dictionaries',[{name:'字典数据',rows:[{字典类型:'商品分类',名称:'合成编码目录',编码:'CDIR'},{字典类型:'商品分类',上级名称:'合成编码目录',名称:'合成编码子目录',编码:'CSUB'},{字典类型:'品种',名称:'合成苹果',编码:'APPLE'},{字典类型:'品牌',名称:'合成编码品牌',编码:'BRD'},{字典类型:'规格单位',名称:'合成份',编码:'HCFS'}]}]);
    await execute('archive_units',[{name:'档案单位',rows:[{单位名称:'合成份',单位编码:'HCF',排序:'12'}]}]);
    await execute('product_archives',[{name:'商品档案',rows:[{档案类型:'原料',档案编号:'INPUT-RAW-ONE',档案名称:'合成原料一',一级分类:'合成原料目录',二级分类:'合成原料子目录',规格数量:'1',单位:'合成份',称重重量kg:'1.234567'}]}]);
    const raw=(await svc.list(boss,'finance-products',{})).items.find(row=>row.data.name==='合成原料一')!;expect(raw.data.weightG).toBe(1234.567);
    await execute('base_codes',[{name:'商品基础编码',rows:[{商品基础编码:'EXTERNAL-ONE',商品名称:'合成外部苹果',一级分类:'合成编码目录',二级分类:'合成编码子目录',品种:'合成苹果',品牌:'合成编码品牌',规格数量:'1',规格单位:'合成份',基本单位:'份',称重重量kg:'1.234567',成本价:'12.123456',采购价:'10.654321'}]},{name:'基础编码组成',rows:[{商品基础编码:'EXTERNAL-ONE',档案类型:'原料',档案编号:String(raw.data.code),角色:'主商品',数量:'1',单位:'合成份',排序:'8'}]}]);
    const base=(await svc.list(boss,'finance-base-codes',{})).items.find(row=>row.data.code==='EXTERNAL-ONE')!;
    expect(base.data).toMatchObject({codeSpecUnit:'HCFS',origin:'external_import',externalCost:1212.3456,externalPurchasePrice:1065.4321,weightG:1234.567});expect(base.data.productId).toBeUndefined();
    expect((await svc.list(boss,'finance-base-code-lines',{})).items.find(row=>row.data.baseCodeId===base.id)?.data).toMatchObject({productId:raw.id,sortOrder:8,unit:'HCF'});
    await expect(svc.create(boss,'finance-base-codes',{origin:'external_import',code:'SPOOF',name:'伪造',codeSpecQty:1,codeSpecUnit:'HCFS'})).rejects.toThrow(/只能通过/);
    const oldCount=await ds.manager.count(ResourceRecord,{where:{companyId:boss.companyId,type:'finance-products'}});
    await svc.confirmBaseProfile(boss,'finance-base-codes',base.id,{name:'合成外部苹果确认',shortName:'确认苹果'});
    expect(await ds.manager.count(ResourceRecord,{where:{companyId:boss.companyId,type:'finance-products'}})).toBe(oldCount);
    await svc.create(boss,'finance-scenarios',{name:'合成销售场景',code:'HCSC',segment:'',sortOrder:1});
    await execute('bundle_codes',[{name:'商品组合编码',rows:[{组合编码:'EXTERNAL-BUNDLE',组合名称:'合成外部组合',款式编码:'EXTERNAL-STYLE',一级分类:'合成编码目录',二级分类:'合成编码子目录',平台:'合成主链平台',销售场景:'合成销售场景',规格:'合成规格'}]},{name:'组合BOM',rows:[{组合编码:'EXTERNAL-BUNDLE',组件类型:'基础编码',组件编码:'EXTERNAL-ONE',角色:'主商品',数量:'1',单位:'合成份',必选:'是',进入聚水潭组合:'否'}]}]);
    const bundle=(await svc.list(boss,'finance-bundles',{})).items.find(row=>row.data.code==='EXTERNAL-BUNDLE')!;expect(bundle.data).toMatchObject({name:'合成外部组合',propertiesValue:'合成规格'});
    const cost=new CostService(ds),data=await cost.load(boss.companyId),row=cost.row(data,data.bundles.find(row=>row.id===bundle.id)!);
    expect(row).toMatchObject({preShipCostCents:1212.3456,weightG:1234.567,categoryId:base.data.codeDictionaryCategoryId});
    const record=await ds.manager.findOneByOrFail(ResourceRecord,{id:base.id,companyId:boss.companyId});
    expect((await buildSnapshot(ds.manager,boss.companyId,record)).issues).toEqual([]);
    expect(await baseCodeOutbound(ds.manager,boss.companyId,record)).toMatchObject({purchase_price:10.654321,cost_price:12.123456,unit:'HCFS',c_name:'合成编码目录/合成编码子目录'});
    const noCost={...boss,permissions:{isCompanyAdmin:false,allow:['resource.finance-base-codes.view'],deny:[]}};
    expect((await svc.get(noCost,'finance-base-codes',base.id)).data.externalCost).toBeUndefined();
    await expect(svc.update(boss,'finance-products',raw.id,{unitDictionaryKind:'spec_unit'})).rejects.toThrow(/不能更换/);
    expect((await svc.get(boss,'finance-products',raw.id)).optionLabels?.specUnit).toBe('合成份');

  });
  it('空行保持Excel真实报错行号，重复表头与主表外归属被拒绝',async()=>{
    const empty=await svc.importProfile(boss,'platforms',workbook([{}, {平台名称:'',平台编码:'BAD'}]),true);expect(empty.results[0]).toMatchObject({line:3,action:'error'});
    const duplicates=await svc.importProfile(boss,'platforms',[{name:'销售平台',headers:['平台名称','平台名称'],rows:[{平台名称:'合成重复头'}]}],true);expect(duplicates.issues.some(issue=>issue.message.includes('重复'))).toBe(true);
  });

  it('商品档案五sheet保留逐项0人工、引用原编号别名、明细统计与后续失败整组回滚',async()=>{
    await execute('archive_categories',[{name:'档案分类',rows:[{档案类型:'自产成品',一级分类:'合成自产目录',一级分类编码:'MAKE'},{档案类型:'产品包装',一级分类:'合成包装目录',一级分类编码:'PACK'},{档案类型:'OEM包装',一级分类:'合成OEM目录',一级分类编码:'OEM'}]}]);
    const sheets:Array<{name:string;rows:Array<Record<string,string>>}>=[{name:'商品档案',rows:[{档案类型:'原料',档案编号:'FIVE-R',档案名称:'五表原料',一级分类:'合成原料目录',二级分类:'合成原料子目录',规格数量:'1',单位:'合成份',称重重量kg:'1'},{档案类型:'自产成品',档案编号:'FIVE-S',档案名称:'五表成品',一级分类:'合成自产目录',品牌:'合成编码品牌',规格数量:'1',单位:'合成份',称重重量kg:'4'},{档案类型:'产品包装',档案编号:'FIVE-P',档案名称:'五表包装',一级分类:'合成包装目录',规格数量:'1',单位:'合成份',称重重量kg:'0.2'},{档案类型:'OEM包装',档案编号:'FIVE-O',档案名称:'五表OEM包装',一级分类:'合成OEM目录',品牌:'合成编码品牌',规格数量:'1',单位:'合成份',称重重量kg:'0.3'}]},{name:'原料明细',rows:[{成品档案编号:'FIVE-S',原料编号:'FIVE-R',用量:'2'}]},{name:'包装明细',rows:[{成品档案编号:'FIVE-S',产品包装编号:'FIVE-P',用量:'1'}]},{name:'OEM包装明细',rows:[{成品档案编号:'FIVE-S',OEM包装编号:'FIVE-O',用量:'1'}]},{name:'人工成本明细',rows:[{成品档案编号:'FIVE-S',人工成本名称:'原文件零人工',金额:'0'},{成品档案编号:'FIVE-S',人工成本名称:'原文件精确人工',金额:'1.000001'}]}];
    const done=await execute('product_archives',sheets);expect(done).toMatchObject({mainCreated:4,mainUpdated:0,detailRows:5});
    const products=(await svc.list(boss,'finance-products',{})).items;const owner=products.find(row=>row.data.name==='五表成品')!;
    expect(products.find(row=>row.data.name==='五表原料')!.data.code).not.toBe('FIVE-R');
    const details=(await svc.list(boss,'finance-product-boms',{})).items.filter(row=>row.data.productId===owner.id);
    expect(details).toHaveLength(5);expect(details.find(row=>row.data.importLaborName==='原文件零人工')?.data.importLaborCost).toBe(0);expect(details.find(row=>row.data.importLaborName==='原文件精确人工')?.data.importLaborCost).toBe(100.0001);
    expect(owner.data.freight).toBeUndefined();expect(owner.data.zeroValueReason).toBeUndefined();
    const before=await ds.manager.find(ResourceRecord,{where:{companyId:boss.companyId},order:{id:'ASC'}});const audit=await ds.manager.count(ResourceChangeLog,{where:{companyId:boss.companyId}});
    const broken=sheets.map(sheet=>sheet.name==='OEM包装明细'?{...sheet,rows:[{成品档案编号:'FIVE-S',OEM包装编号:'NOT-EXIST',用量:'1'}]}:sheet);
    const preview=await svc.importProfile(boss,'product_archives',broken,true);expect(preview.failed).toBeGreaterThan(0);const failed=await svc.importProfile(boss,'product_archives',broken,false,preview.signature!);expect(failed.committed).toBe(false);
    expect(await ds.manager.find(ResourceRecord,{where:{companyId:boss.companyId},order:{id:'ASC'}})).toEqual(before);expect(await ds.manager.count(ResourceChangeLog,{where:{companyId:boss.companyId}})).toBe(audit);
  });

  it('原外购共享分类同时承接原装/OEM，导入未知成本保真且可以普通编辑',async()=>{
    await execute('archive_categories',[{name:'档案分类',rows:[{档案类型:'外购成品',一级分类:'原外购共享目录',一级分类编码:'PURCHASE-LONG-CODE'},{档案类型:'外购成品',一级分类:'原外购可扩展目录',一级分类编码:'PUR2'}]}]);
    const sheets=[{name:'商品档案',rows:[{档案类型:'外购成品',档案编号:'PURCHASE-ORIGINAL',档案名称:'合成原装成品',一级分类:'原外购共享目录',品牌:'合成编码品牌',规格数量:'1',单位:'合成份',供货方式:'原装采购',称重重量kg:'1'},{档案类型:'外购成品',档案编号:'PURCHASE-OEM',档案名称:'合成OEM成品',一级分类:'原外购共享目录',品牌:'合成编码品牌',规格数量:'1',单位:'合成份',供货方式:'供应商OEM',称重重量kg:'1'}]}];
    await execute('product_archives',sheets);
    const products=(await svc.list(boss,'finance-products',{})).items;const original=products.find(row=>row.data.name==='合成原装成品')!,oem=products.find(row=>row.data.name==='合成OEM成品')!;
    expect(original.data.categoryId).toBe(oem.data.categoryId);expect(oem.data.supplyMode).toBe('supplier_oem');
    const category=await svc.get(boss,'finance-categories',Number(oem.data.categoryId));expect(category.data).toMatchObject({importArchiveType:'purchased',code:'PURCHASE-LONG-CODE'});
    expect((await svc.update(boss,'finance-products',oem.id,{note:'普通编辑保留未知运装成本'})).data.note).toBe('普通编辑保留未知运装成本');
    await expect(svc.update(boss,'finance-categories',category.id,{importArchiveType:'raw'})).rejects.toThrow(/不能更换/);
    const root=(await svc.list(boss,'finance-categories',{})).items.find(row=>row.data.name==='原外购可扩展目录')!;
    const child=await svc.create(boss,'finance-categories',{name:'原OEM页正常新增子类',code:'OMCH',parentId:root.id,archiveType:'supplier_oem'});
    expect(child.data).toMatchObject({archiveType:'original_purchase',importArchiveType:'purchased'});
    const brand=(await svc.list(boss,'finance-brands',{})).items.find(row=>row.data.name==='合成编码品牌')!;
    const ordinary=await svc.create(boss,'finance-products',{archiveType:'purchased',supplyMode:'supplier_oem',name:'共享子类正常新建',categoryId:child.id,brandId:brand.id,specQty:'1',specUnit:'HCFS',weightManual:true,weightG:1000,freight:1,handlingFee:1});
    expect(ordinary.data.categoryId).toBe(child.id);expect(ordinary.data.unitDictionaryKind).toBeUndefined();

  });

  it('原基础编码空重量按真实组成或重量单位补全，0成本保真且重复组成逐行保留',async()=>{
    await execute('dictionaries',[{name:'字典数据',rows:[{字典类型:'规格单位',名称:'千克',编码:'KG'}]}]);
    const raw=(await svc.list(boss,'finance-products',{})).items.find(row=>row.data.name==='合成原料一')!;
    const sheets:Array<{name:string;rows:Array<Record<string,string>>}>=[{name:'商品基础编码',rows:[{商品基础编码:'No_Source+Zero*1',商品名称:'无来源零成本',一级分类:'合成编码目录',二级分类:'合成编码子目录',品种:'未建字典的真实品名',规格数量:'2',规格单位:'千克',成本价:'0',采购价:'0'},{商品基础编码:'SOURCE-WEIGHT',商品名称:'真实组成重量',一级分类:'合成编码目录',二级分类:'合成编码子目录',品种:'合成苹果',规格数量:'1',规格单位:'合成份',成本价:'1',采购价:'0'}]},{name:'基础编码组成',rows:[{商品基础编码:'SOURCE-WEIGHT',档案类型:'原料',档案编号:String(raw.data.code),角色:'主商品',数量:'2',单位:'合成份'},{商品基础编码:'SOURCE-WEIGHT',档案类型:'原料',档案编号:String(raw.data.code),角色:'辅助',数量:'3',单位:'合成份'}]}];
    await execute('base_codes',sheets);
    const bases=(await svc.list(boss,'finance-base-codes',{})).items;const none=bases.find(row=>row.data.code==='No_Source+Zero*1')!,source=bases.find(row=>row.data.code==='SOURCE-WEIGHT')!;
    expect(none.data).toMatchObject({externalCost:0,externalPurchasePrice:0,cost:0,purchasePrice:0,weightG:2000});expect(none.data.productId).toBeUndefined();
    expect(source.data.weightG).toBe(6172.835);expect((await svc.list(boss,'finance-base-code-lines',{})).items.filter(row=>row.data.baseCodeId===source.id)).toHaveLength(2);
  });

  it('组合直接档案组件保留真实引用与控制列，主辅同量重复在预检阻止',async()=>{
    const raw=(await svc.list(boss,'finance-products',{})).items.find(row=>row.data.name==='合成原料一')!;
    const sheets:Array<{name:string;rows:Array<Record<string,string>>}>=[{name:'商品组合编码',rows:[{组合编码:'Direct_Archive+Bundle*1',组合名称:'真实直接档案组合',款式编码:'Direct_Style+1',一级分类:'合成编码目录',二级分类:'合成编码子目录',平台:'合成主链平台',销售场景:'合成销售场景'}]},{name:'组合BOM',rows:[{组合编码:'Direct_Archive+Bundle*1',组件类型:'原料',组件编码:String(raw.data.code),角色:'主商品',数量:'1.25',单位:'合成份',损耗率:'1.2345',必选:'否',进入聚水潭组合:'否',成本归类:'采购成本',计价处理:'仅参考',排序:'2'}]}];
    await execute('bundle_codes',sheets);
    const bundle=(await svc.list(boss,'finance-bundles',{})).items.find(row=>row.data.code==='Direct_Archive+Bundle*1')!;
    const line=(await svc.list(boss,'finance-bundle-lines',{})).items.find(row=>row.data.bundleId===bundle.id)!;
    expect(line.data).toMatchObject({productId:raw.id,qty:1.25,lossRate:1.2345,isRequired:false,includeInJst:false,costBucket:'purchase',costTreatment:'reference_only',sortOrder:2});expect(line.data.baseCodeId).toBeUndefined();
    const invalid:Array<{name:string;rows:Array<Record<string,string>>}>=sheets.map(sheet=>({name:sheet.name,rows:sheet.rows.map(row=>({...row,组合编码:'INVALID-MAIN-AUX'}))}));
    invalid[1].rows=[{...invalid[1].rows[0],数量:'1'},{...invalid[1].rows[0],数量:'1',角色:'辅助'}];
    const preview=await svc.importProfile(boss,'bundle_codes',invalid,true);expect(preview.results.some(row=>row.errors.some(message=>message.includes('重复计算成本')))).toBe(true);
    expect(await ds.manager.findOneBy(ResourceRecord,{companyId:boss.companyId,type:'finance-bundles',title:'INVALID-MAIN-AUX'})).toBeNull();
  });

  it('七个示例工作簿按依赖顺序可真实预检执行，非空示例不只生成占位文字',async()=>{
    await svc.create(other,'finance-scenarios',{name:'标准销售',code:'standard'});
    for(const profile of RESOURCE_IMPORT_PROFILES){
      const sheets=profile.sheets.map(sheet=>({name:sheet.name,headers:[...sheet.headers],rows:sheet.examples.map(row=>({...row}))}));
      const preview=await svc.importProfile(other,profile.id,sheets,true);
      expect({profile:profile.id,errors:preview.results.filter(row=>row.action==='error'),issues:preview.issues}).toEqual({profile:profile.id,errors:[],issues:[]});
      const done=await svc.importProfile(other,profile.id,sheets,false,preview.signature!);expect(done.committed).toBe(true);
    }
  });

});
