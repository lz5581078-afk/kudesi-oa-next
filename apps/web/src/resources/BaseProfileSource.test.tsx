import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseProfileSourceExtras } from './BaseProfileSource';
import { resourceApi, type ResourceDto } from './api';
let companyId=1;
let canCost=true;
vi.mock('../auth/AuthContext',()=>({useAuth:()=>({user:{id:1,companyId,permissions:{isCompanyAdmin:canCost,allow:[],deny:[]}}})}));
vi.mock('./api',()=>({resourceApi:{list:vi.fn(),get:vi.fn()}}));
vi.mock('./ReferenceProductFields',async orig=>({...await orig<typeof import('./ReferenceProductFields')>(),FreightHistory:()=>null}));
const dto=(id:number, data:Record<string,unknown>, refLabels:Record<string,string>={}):ResourceDto=>({
 id,type:'finance-product-sources',title:'原料',status:'active',statusReason:null,data,refLabels,
 files:{},secretConfigured:{},createdAt:'2026-11-03',updatedAt:'2026-11-03',
});
const source=(id:number):ResourceDto=>({...dto(id,{archiveType:'raw',purchaseSpec:'千克'}),type:'finance-products'});
const row=(id:number):ResourceDto=>dto(id,{originArea:`合成产区${id}`,systemSpec:'袋',purchasePrice:12.3456},{supplierId:`合成供应商${id}`});
beforeEach(()=>{companyId=1;canCost=true;});
afterEach(()=>{cleanup();vi.resetAllMocks();});
describe('基础编码只读供货来源',()=>{
 it('完整读取后页，并显示来源自己的系统规格和六位元采购价',async()=>{
  vi.mocked(resourceApi.list).mockImplementation(async(_type,q)=>({items:q?.page===1?Array.from({length:200},(_,i)=>row(i+1)):[row(201)],total:201}) as never);
  render(<BaseProfileSourceExtras source={source(7)}/>);
  await screen.findByDisplayValue('合成供应商201');
  expect(resourceApi.list).toHaveBeenLastCalledWith('finance-product-sources',{fieldKey:'productId',fieldValue:7,page:2,pageSize:200,showHidden:true});
  expect(screen.getAllByDisplayValue('袋')).toHaveLength(201);
  expect(screen.getAllByDisplayValue('0.123456')).toHaveLength(201);
 });
 it('换档案不显示旧来源，失败不是空清单，重试重新读实际档案',async()=>{
  vi.mocked(resourceApi.list).mockResolvedValueOnce({items:[row(1)],total:1} as never).mockRejectedValueOnce(new Error('失败')).mockResolvedValueOnce({items:[row(2)],total:1} as never);
  const view=render(<BaseProfileSourceExtras source={source(7)}/>);
  await screen.findByDisplayValue('合成供应商1');
  view.rerender(<BaseProfileSourceExtras source={source(8)}/>);
  expect(screen.queryByDisplayValue('合成供应商1')).toBeNull();
  await screen.findByRole('alert');
  expect(screen.queryByText('未维护供货来源')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'重试'}));
  await screen.findByDisplayValue('合成供应商2');
  expect(resourceApi.list).toHaveBeenLastCalledWith('finance-product-sources',expect.objectContaining({fieldValue:8,page:1}));
 });
 it('撤销成本权限后隐藏已读来源报价并重新按当前身份读取',async()=>{
  vi.mocked(resourceApi.list).mockResolvedValue({items:[row(1)],total:1,page:1,pageSize:200});
  const view=render(<BaseProfileSourceExtras source={source(7)}/>);
  await screen.findByDisplayValue('0.123456');
  canCost=false;
  view.rerender(<BaseProfileSourceExtras source={source(7)}/>);
  expect(screen.queryByDisplayValue('0.123456')).toBeNull();
  await screen.findByDisplayValue('合成供应商1');
  expect(screen.queryByDisplayValue('0.123456')).toBeNull();
 });
 it('切公司后迟到首批不继续翻页或显示旧公司来源',async()=>{
  let resolve!:(value:unknown)=>void;
  vi.mocked(resourceApi.list).mockImplementationOnce(()=>new Promise(r=>{resolve=r;}) as never).mockResolvedValue({items:[row(9)],total:1} as never);
  const view=render(<BaseProfileSourceExtras source={source(7)}/>);
  companyId=2;
  view.rerender(<BaseProfileSourceExtras source={source(7)}/>);
  await screen.findByDisplayValue('合成供应商9');
  resolve({items:[row(1)],total:201});
  await waitFor(()=>expect(resourceApi.list).toHaveBeenCalledTimes(2));
  expect(screen.queryByDisplayValue('合成供应商1')).toBeNull();
  expect(screen.getByDisplayValue('合成供应商9')).toBeTruthy();
 });
});

describe('基础编码来源档案的供应商OEM组成',()=>{
 it('完整分页显示包装构成及用量，保留不可读引用，成本按权限隐藏',async()=>{
  const component={...dto(20,{archiveType:'oem_package',purchaseSpec:'张',purchasePrice:8,totalCost:20,weightG:5}),type:'finance-products',title:'合成OEM包装'};
  const line={...dto(30,{componentId:20,qty:2.5}),type:'finance-product-boms'};
  const missing={...dto(31,{componentId:21,qty:1},{componentId:'历史不可读包装'}),type:'finance-product-boms'};
  vi.mocked(resourceApi.list).mockImplementation(async(_type,q)=>({items:q?.page===1?[line]:[missing],total:2,page:q?.page??1,pageSize:200}));
  vi.mocked(resourceApi.get).mockImplementation(async(_type,id)=>{if(id===20)return component;throw new Error('无权读取');});
  const oem={...source(7),data:{archiveType:'purchased',supplyMode:'supplier_oem'}};
  const view=render(<BaseProfileSourceExtras source={oem}/>);
  await screen.findByText('合成OEM包装');
  expect(screen.getByRole('region',{name:'供应商OEM组成'})).toBeTruthy();
  expect(screen.getByText('历史不可读包装')).toBeTruthy();
  expect(screen.getByText('2.5 张')).toBeTruthy();
  expect(screen.getByText('· ¥0.080')).toBeTruthy();
  expect(resourceApi.list).toHaveBeenLastCalledWith('finance-product-boms',expect.objectContaining({fieldValue:7,page:2,showHidden:true}));
  canCost=false;
  view.rerender(<BaseProfileSourceExtras source={oem}/>);
  expect(screen.queryByText('· ¥0.080')).toBeNull();
  await screen.findByText('合成OEM包装');
  expect(screen.queryByText('· ¥0.080')).toBeNull();
 });
});

it('来源只读不能把空续页当成完整清单，失败不显示已读取的部分报价',async()=>{vi.mocked(resourceApi.list).mockImplementation(async(_type,q)=>({items:q?.page===1?Array.from({length:200},(_,i)=>row(i+1)):[],total:201,page:q?.page??1,pageSize:200}));render(<BaseProfileSourceExtras source={source(7)}/>);await screen.findByRole('alert');expect(screen.queryByDisplayValue('合成供应商1')).toBeNull();expect(screen.queryByText('未维护供货来源')).toBeNull();});
