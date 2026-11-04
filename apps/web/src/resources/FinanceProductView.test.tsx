import {cleanup,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {getResourceDef} from '@kudesi/shared';
import type {ResourceDto} from './api';
const mock=vi.hoisted(()=>({list:vi.fn(),get:vi.fn()}));
vi.mock('../auth/AuthContext',()=>({useAuth:()=>({user:{id:1,companyId:1,permissions:{isCompanyAdmin:true,allow:[],deny:[]}}})}));
vi.mock('./api',()=>({resourceApi:{list:(...a:unknown[])=>mock.list(...a),get:(...a:unknown[])=>mock.get(...a)}}));
vi.mock('./ProductArchivePhotos',()=>({ProductArchivePhotos:()=> <p>既有图片维护</p>}));
import {FinanceProductDetail} from './FinanceProductDetail';
import {FinanceDetailHead} from './FinanceRecordDetail';
const row=(data:Record<string,unknown>,id=1):ResourceDto=>({id,type:'finance-products',title:'查看合成',status:'active',statusReason:null,data,files:{},refLabels:{},secretConfigured:{},createdAt:'2026-11-04T00:00:00Z',updatedAt:'2026-11-04T00:00:00Z'});
afterEach(()=>{cleanup();vi.resetAllMocks();});
it.each([['raw',undefined,'原料'],['shipping_material',undefined,'发货物料'],['self_made',undefined,'自产成品'],['purchased','original_purchase','原装采购成品'],['purchased','supplier_oem','供应商OEM成品'],['package',undefined,'产品包装'],['oem_package',undefined,'OEM包装']])('%s/%s查看标题/副标题/状态沿源真实名词，productOnly无额外前后导航',async(archiveType,supplyMode,noun)=>{
 mock.list.mockResolvedValue({items:[],total:0});const record=row({archiveType,supplyMode,name:'真实合成名称',shape:'非源额外形态',weightManual:true});
 render(<><FinanceDetailHead def={getResourceDef('finance-products')!} record={record} nav={{index:1,total:2,onPrev:()=>{},onNext:()=>{}}} productOnly onClose={()=>{}}/><FinanceProductDetail record={record}/></>);
 expect(screen.getByRole('heading',{name:'真实合成名称'})).toBeTruthy();expect(screen.getByText(`查看${noun}的基础资料和系统编号。`)).toBeTruthy();expect(screen.queryByLabelText('上一条')).toBeNull();expect(screen.queryByText('非源额外形态')).toBeNull();expect(screen.queryByText('人工修正重量')).toBeNull();expect(screen.queryByText('更多设置')).toBeNull();expect(screen.getByText('既有图片维护')).toBeTruthy();
 if(!['raw','shipping_material'].includes(archiveType!))expect(screen.getByText('正常')).toBeTruthy();
 await waitFor(()=>expect(screen.queryByText('正在加载组成明细…')).toBeNull());
});
it('默认head及非产品仍保留既有导航，来源同采购时间按更新时间并保真实供应商简称编号',async()=>{
 mock.list.mockImplementation((type:string)=>Promise.resolve({items:type==='finance-product-sources'?[{...row({supplierId:9,originArea:'旧资料更新时间',priceUpdatedAt:'2026-11-01',purchasePrice:33.5001},11),type,updatedAt:'2026-11-02'},{...row({supplierId:9,originArea:'新资料更新时间',priceUpdatedAt:'2026-11-01',purchasePrice:33.5001},12),type,updatedAt:'2026-11-03'}]:[],total:type==='finance-product-sources'?2:0}));mock.get.mockResolvedValue(row({shortCode:'REAL-SUPPLIER'},9));const record=row({archiveType:'raw',name:'合成',purchaseSpec:'千克'});
 render(<><FinanceDetailHead def={getResourceDef('finance-products')!} record={record} nav={{index:1,total:2,onPrev:()=>{}}} onClose={()=>{}}/><FinanceProductDetail record={record}/></>);expect(screen.getByLabelText('上一条')).toBeTruthy();await screen.findAllByText('简称编号：REAL-SUPPLIER');const cards=[...document.querySelectorAll('.raw-supply-source-row')];expect((within(cards[0] as HTMLElement).getByLabelText('产区') as HTMLInputElement).value).toBe('新资料更新时间');expect(cards[0].textContent).toContain('当前最新成本');expect((within(cards[0] as HTMLElement).getByLabelText('来源采购价') as HTMLInputElement).value).toBe('0.335001');expect(cards[0].textContent).toContain('元/千克');expect(mock.get).toHaveBeenCalledTimes(1);expect(mock.get).toHaveBeenCalledWith('finance-suppliers',9);
});

it('原料马甲只显示服务端实际code/fullname；无事实保未知，不按client名称猜码',async()=>{
 mock.list.mockResolvedValue({items:[],total:0});render(<FinanceProductDetail record={row({archiveType:'raw',rawFinishedNames:'已存在\n未匹配',__finishedNameDetails:[{name:'已存在',code:'YL-REAL',fullName:'真实马甲-1-千克'}]})}/>);expect(screen.getByText('YL-REAL')).toBeTruthy();expect(screen.getByText('真实马甲-1-千克')).toBeTruthy();expect(screen.getByText('未记录')).toBeTruthy();expect(screen.getByText('未读取')).toBeTruthy();await waitFor(()=>expect(screen.queryByText('正在加载组成明细…')).toBeNull());
});

it('查看态运费装卸费保留8位元，采购单价仍按原6位读取',async()=>{
 mock.list.mockResolvedValue({items:[],total:0});
 render(<FinanceProductDetail record={row({archiveType:'raw',purchaseSpec:'千克',purchasePrice:123.4567,freight:12.345678,handlingFee:0.000001,totalCost:135.802379})}/>);
 expect((screen.getByLabelText('运费') as HTMLInputElement).value).toBe('0.12345678');
 expect((screen.getByLabelText('装卸费') as HTMLInputElement).value).toBe('0.00000001');
 await waitFor(()=>expect(screen.queryByText('正在加载组成明细…')).toBeNull());
});

it('包装查看容量显示单位名称，库存两位和采购计价单位沿原栏位',async()=>{
 mock.list.mockResolvedValue({items:[],total:0});
 render(<FinanceProductDetail record={row({archiveType:'oem_package',capacities:'500ML\n1KG',purchaseSpec:'张',purchasePrice:8,orderStock:12,actualStock:3})}/>);
 expect(screen.getByText('500 毫升')).toBeTruthy();expect(screen.getByText('1 千克')).toBeTruthy();
 expect(screen.getByText('12.00')).toBeTruthy();expect(screen.getByText('3.00')).toBeTruthy();expect(screen.getByText('¥0.080 / 张')).toBeTruthy();
 expect(screen.getByText('系统根据分类、品牌、名称和全部适用容量生成')).toBeTruthy();
 await waitFor(()=>expect(screen.queryByText('正在加载组成明细…')).toBeNull());
});

it('发货物料查看保留单件重量和独立单位，并以千克给出核算重量',async()=>{
 mock.list.mockResolvedValue({items:[],total:0});render(<FinanceProductDetail record={row({archiveType:'shipping_material',weightG:250,weightUnit:'g'})}/>);
 expect((screen.getByLabelText('发货物料单件重量') as HTMLInputElement).value).toBe('250');
 expect((screen.getByLabelText('发货物料重量单位') as HTMLSelectElement).value).toBe('g');
 expect((screen.getByLabelText('发货物料单件重量') as HTMLInputElement).readOnly).toBe(true);
 expect((screen.getByLabelText('发货物料重量单位') as HTMLSelectElement).disabled).toBe(true);
 expect(screen.getByText('0.25 kg')).toBeTruthy();
 await waitFor(()=>expect(screen.queryByText('正在加载组成明细…')).toBeNull());
});
