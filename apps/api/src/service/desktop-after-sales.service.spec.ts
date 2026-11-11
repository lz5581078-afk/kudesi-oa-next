import type {DesktopSaleSnapshot} from '@kudesi/shared';
import type {DataSource} from 'typeorm';
import type {AuthUser} from '../common/auth.decorators';
import type {CryptoService} from '../common/crypto.service';
import type {FilesService} from '../integrations/files.service';
import {DesktopAfterSalesService} from './desktop-after-sales.service';

it('筛选聚水潭新增列时只使用当前用户有权查看的金额和明细',async()=>{
  const snapshot:DesktopSaleSnapshot={
    afterSaleId:'85110001',internalOrderId:'4400001',sourceCompany:'演示公司',capturedAt:'2026-11-06T00:00:00.000Z',
    fields:{供应商退款状态:'已退款',退货金额:'54.29',买家应补运费:'6.00',实退金额明细:'应退运费：54.29',
      售后商品明细:'实收金额：54.29',退货物流状态:'已签收'},
  };
  const row={id:1,after_sale_id:snapshot.afterSaleId,internal_order_id:snapshot.internalOrderId,
    source_company:snapshot.sourceCompany,snapshot_enc:JSON.stringify(snapshot),progress_enc:'',version:1,
    store_id:null,owner_id:null,next_at:null,updated_at:new Date(snapshot.capturedAt)};
  const query=jest.fn().mockResolvedValue([row]);
  const ds={transaction:(_isolation:string,work:(em:{query:typeof query})=>unknown)=>work({query})} as unknown as DataSource;
  const service=new DesktopAfterSalesService(ds,{decrypt:(value:string)=>value} as CryptoService,{} as FilesService);
  const user:AuthUser={id:2,companyId:1,name:'客服',permissions:{isCompanyAdmin:false,allow:['after-sales.workspace.view'],deny:[]}};
  const authorized:AuthUser={...user,permissions:{...user.permissions,allow:[...user.permissions.allow,'product.price.view','product.cost.view']}};
  const visible=await service.list(user,'',1,'申请时间','desc',[{column:'供应商退款状态',value:'已退款'}]);
  expect(visible.total).toBe(1);
  expect(visible.rows[0].snapshot.fields).toEqual({供应商退款状态:'已退款',退货物流状态:'已签收'});
  const amountFilter=[{column:'退货金额',value:'54.29'}] as const;
  await expect(service.list(user,'',1,'申请时间','desc',[...amountFilter])).resolves.toEqual({total:0,rows:[]});
  const permitted=await service.list(authorized,'',1,'申请时间','desc',[...amountFilter]);
  expect(permitted.rows[0].snapshot.fields).toEqual(snapshot.fields);
});
