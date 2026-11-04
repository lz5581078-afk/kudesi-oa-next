import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BaseProfileSourceDetails, sourcePurchasePrice } from './BaseProfileSourceDetails';
import type { ResourceDto } from './api';
vi.mock('../auth/AuthContext',()=>({useAuth:()=>({user:{id:1,companyId:1,permissions:{isCompanyAdmin:true,allow:[],deny:[]}}})}));
vi.mock('./api',()=>({resourceApi:{list:vi.fn().mockResolvedValue({items:[],total:0,page:1,pageSize:200})}}));
vi.mock('./BaseProfileSource',()=>({BaseProfileSourceExtras:({source}:{source:ResourceDto})=>source.data.archiveType==='purchased'?<section aria-label="供应商OEM组成">2.5 张 合成OEM包装</section>:null}));
const source:ResourceDto={id:102,type:'finance-products',title:'合成OEM成品',status:'active',statusReason:null,refLabels:{categoryId:'供应商OEM成品 / 合成分类',brandId:'合成品牌'},data:{archiveType:'purchased',supplyMode:'supplier_oem',name:'合成OEM成品',code:'WG-HC-500G',specQty:'500',specUnit:'G',purchaseSpec:'袋',weightG:525,purchasePrice:650,freight:20,handlingFee:10,totalCost:700},files:{},secretConfigured:{},createdAt:'',updatedAt:''};
afterEach(cleanup);
it('来源OEM按原只读表单顺序显示分类/供货方式、kg重量及实际总采购价',()=>{
 render(<BaseProfileSourceDetails source={source} canCost/>);
 expect(screen.getAllByRole('region').map(region=>region.getAttribute('aria-label'))).toEqual(['所属分类','基础资料','供应商 OEM 成品编号','供应商OEM组成','采购计价','运费与装卸费','总成本价（含运费、装卸费）']);
 expect(screen.getByText('供应商OEM成品 / 合成分类')).toBeTruthy();
 expect(screen.getByText('供应商OEM')).toBeTruthy();expect(screen.getByText('克')).toBeTruthy();
 expect((screen.getByLabelText('称重重量') as HTMLInputElement).value).toBe('0.525');
 expect((screen.getByLabelText('总采购价（元/袋）') as HTMLInputElement).value).toBe('6.7');
 expect(screen.getAllByText('¥6.700')).toHaveLength(2);
 expect(screen.getByText('¥7.000')).toBeTruthy();
 const weight = screen.getByLabelText('称重重量'), purchase = screen.getByLabelText('总采购价（元/袋）');
 expect(weight.closest('.base-source-procurement')?.contains(purchase)).toBe(false);
 const pricePanel=purchase.closest('.base-source-purchase-stats');
 expect(pricePanel?.children).toHaveLength(4);
 expect(pricePanel?.textContent).toContain('上次总采购价');
 expect(pricePanel?.textContent).toContain('3个月平均总采购价');
 expect(pricePanel?.contains(screen.getByRole('button',{name:'历史采购价'}))).toBe(true);
 expect([...document.querySelectorAll<HTMLInputElement>('input')].every(input=>input.readOnly)).toBe(true);
});
it('缺少完整成本事实不把原料价650当作总采购价670，撤销成本权限不显示价格区',()=>{
 expect(sourcePurchasePrice({...source,data:{...source.data,totalCost:null}})).toBeNull();
 render(<BaseProfileSourceDetails source={source} canCost={false}/>);
 expect(screen.queryByLabelText('总采购价（元/袋）')).toBeNull();
 expect(screen.queryByRole('region',{name:'运费与装卸费'})).toBeNull();
 expect(screen.queryByRole('region',{name:'总成本价（含运费、装卸费）'})).toBeNull();
 expect((screen.getByLabelText('称重重量') as HTMLInputElement).value).toBe('0.525');
});

it('包装来源按编号/基础/容量/生产重量/库存分段，沿档案重量输入单位显示',()=>{
 const packaging={...source,data:{archiveType:'oem_package',name:'合成包装',code:'PK-1',packagingCategory:'袋',capacities:'500ML\n1KG',dimensions:'10×20',dimensionUnit:'CM',printingCompany:'合成印刷',purchaseSpec:'张',weightG:5,weightUnit:'g',orderStock:12,actualStock:3,purchasePrice:8,freight:1,handlingFee:1,totalCost:10}};
 render(<BaseProfileSourceDetails source={packaging} canCost/>);
 expect(screen.getAllByRole('region').map(region=>region.getAttribute('aria-label'))).toEqual(['OEM包装编号','包装基础信息','容量组','生产与重量','库存','运费与装卸费','总成本价（含运费、装卸费）']);
 expect(screen.getByText('5 克')).toBeTruthy();expect(screen.getByText('500ML')).toBeTruthy();expect(screen.getByText('1KG')).toBeTruthy();expect(screen.getByText('¥0.080 / 张')).toBeTruthy();
 expect(screen.queryByText('名称规格')).toBeNull();
});
