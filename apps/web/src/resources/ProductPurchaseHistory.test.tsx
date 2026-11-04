import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PurchasePriceHistory, purchasePriceStats } from './ProductPurchaseHistory';
import { resourceApi, type ResourceDto } from './api';
const identity=vi.hoisted(()=>({companyId:1}));
vi.mock('../auth/AuthContext',()=>({useAuth:()=>({user:{id:1,companyId:identity.companyId,permissions:{isCompanyAdmin:true,allow:[],deny:[]}}})}));
vi.mock('./api',()=>({resourceApi:{list:vi.fn()}}));
const row=(id:number,value:number):ResourceDto=>({id,type:'finance-product-purchase-history',title:'合成采购历史',status:'active',statusReason:null,data:{productId:10,purchasePrice:value,recordedAtKey:new Date().toISOString()},files:{},refLabels:{},secretConfigured:{},createdAt:'',updatedAt:''});
const product:ResourceDto={...row(10,100),type:'finance-products',data:{archiveType:'purchased',supplyMode:'supplier_oem'}};
beforeEach(()=>{identity.companyId=1;});afterEach(()=>{cleanup();vi.resetAllMocks();});
it('完整201条独立变价事实计算90天平均并全部展开，绝不读取运费快照',async()=>{
 const records=Array.from({length:201},(_,i)=>row(i+1,i===200?200:100));
 vi.mocked(resourceApi.list).mockImplementation(async(_type,q)=>({items:q?.page===1?records.slice(0,200):records.slice(200),total:201,page:q?.page??1,pageSize:200}));
 render(<PurchasePriceHistory record={product} total/>);
 await screen.findByText('¥2.000');
 expect(screen.getByText('上次总采购价')).toBeTruthy();expect(screen.getByText('3个月平均总采购价')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'历史采购价（201）'}));
 expect(document.querySelectorAll('.base-source-purchase-history-list>div')).toHaveLength(201);
 expect(resourceApi.list).toHaveBeenLastCalledWith('finance-product-purchase-history',expect.objectContaining({page:2,fieldValue:10}));
 expect(vi.mocked(resourceApi.list).mock.calls.every(([type])=>type==='finance-product-purchase-history')).toBe(true);
});
it('空历史显示暂无，失败不冒充空记录且可重试；0是真实采购价',async()=>{
 vi.mocked(resourceApi.list).mockRejectedValueOnce(new Error('失败')).mockResolvedValue({items:[],total:0,page:1,pageSize:200});
 render(<PurchasePriceHistory record={product}/>);
 await screen.findByRole('alert');expect(screen.queryAllByText('暂无')).toHaveLength(0);
 fireEvent.click(screen.getByRole('button',{name:'重试'}));await waitFor(()=>expect(screen.getAllByText('暂无')).toHaveLength(2));
 expect(purchasePriceStats([row(1,0)]).last).toBe(0);
 fireEvent.click(screen.getByRole('button',{name:'历史采购价'}));expect(screen.getByText('暂无历史采购价。')).toBeTruthy();
});
it('切公司隐藏旧历史，迟到旧首批不继续翻页',async()=>{
 let resolve!:(value:unknown)=>void;
 vi.mocked(resourceApi.list).mockImplementationOnce(()=>new Promise(r=>{resolve=r;}) as never).mockResolvedValue({items:[],total:0,page:1,pageSize:200});
 const view=render(<PurchasePriceHistory record={product}/>);
 identity.companyId=2;view.rerender(<PurchasePriceHistory record={product}/>);
 await waitFor(()=>expect(screen.getAllByText('暂无')).toHaveLength(2));
 resolve({items:[row(1,999)],total:201,page:1,pageSize:200});
 await waitFor(()=>expect(resourceApi.list).toHaveBeenCalledTimes(2));
 expect(screen.queryByText('¥9.990')).toBeNull();
});

it('空续页未达总数不计算部分均价，重试可完整读取',async()=>{
 vi.mocked(resourceApi.list).mockResolvedValueOnce({items:[row(1,999)],total:2,page:1,pageSize:200}).mockResolvedValueOnce({items:[],total:2,page:2,pageSize:200}).mockResolvedValue({items:[row(1,100),row(2,200)],total:2,page:1,pageSize:200});
 render(<PurchasePriceHistory record={product}/>);
 await screen.findByRole('alert');expect(screen.queryByText('¥9.990')).toBeNull();expect(screen.queryAllByText('暂无')).toHaveLength(0);
 fireEvent.click(screen.getByRole('button',{name:'重试'}));await screen.findByText('¥1.500');
 expect(screen.getByRole('button',{name:'历史采购价（2）'})).toBeTruthy();
});
it.each([
 ['负数总数',[{items:[],total:-1}]],
 ['非整数总数',[{items:[],total:0.5}]],
 ['总数漂移',[{items:[row(1,999)],total:2},{items:[row(2,100)],total:3}]],
 ['重复身份',[{items:[row(1,999)],total:2},{items:[row(1,999)],total:2}]],
 ['超过总数',[{items:[row(1,999),row(2,100)],total:1}]],
])('%s保留错误可重试且不发布部分采购事实',async(_name,pages)=>{
 let page=0;
 vi.mocked(resourceApi.list).mockImplementation(async()=>({...pages[Math.min(page++,pages.length-1)],page,pageSize:200}));
 render(<PurchasePriceHistory record={product}/>);
 await screen.findByRole('alert');expect(screen.queryByText('¥9.990')).toBeNull();expect(screen.queryAllByText('暂无')).toHaveLength(0);
 expect(screen.getByRole('button',{name:'重试'})).toBeTruthy();
});
