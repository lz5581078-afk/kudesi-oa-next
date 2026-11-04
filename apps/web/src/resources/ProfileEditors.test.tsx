import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCodeProfileEditor } from './BaseCodeProfileEditor';
import { BundleProfileEditor } from './BundleProfileEditor';
import { resourceApi, type ResourceDto } from './api';
import { api } from '../api/client';
vi.mock('../auth/AuthContext',()=>({useAuth:()=>({user:{permissions:{isCompanyAdmin:true,allow:[],deny:[]}}})}));
vi.mock('../api/client',()=>({api:vi.fn()}));
vi.mock('./api',()=>({resourceApi:{list:vi.fn(),get:vi.fn(),confirmBaseProfile:vi.fn(),confirmBundleProfile:vi.fn()}}));
const record = {id:1,type:'finance-base-codes',title:'原料',status:'pending',data:{code:'YL-1',styleCode:'YL',name:'原料',shortName:'原料简称',categoryId:4,weightG:500},refLabels:{categoryId:'原料分类'},files:{},secretConfigured:{},statusReason:null,createdAt:'',updatedAt:''} as ResourceDto;
beforeEach(()=>{vi.mocked(api).mockResolvedValue({lockedFields:[],items:[]});vi.mocked(resourceApi.list).mockResolvedValue({items:[{id:4,title:'原料分类',status:'active',data:{archiveType:'raw'}}],total:1} as never);vi.mocked(resourceApi.confirmBaseProfile).mockResolvedValue(record);vi.mocked(resourceApi.confirmBundleProfile).mockResolvedValue(record);});
afterEach(()=>{cleanup();vi.resetAllMocks();});
describe('独立编辑链路',()=>{
  it('基础编码以kg录入，保留六位克精度；失败保留输入并能重试',async()=>{
    const saved=vi.fn();vi.mocked(resourceApi.confirmBaseProfile).mockRejectedValueOnce(new Error('记录刚被修改'));
    render(<BaseCodeProfileEditor record={record} onClose={()=>{}} onSaved={saved}/>);
    await waitFor(()=>expect((screen.getByLabelText(/重量（kg）/) as HTMLInputElement).disabled).toBe(false));
    expect((screen.getByLabelText(/商品名称/) as HTMLInputElement).maxLength).toBe(500);
    expect((screen.getByLabelText(/商品简称/) as HTMLInputElement).maxLength).toBe(500);
    expect((screen.getByLabelText(/颜色及规格/) as HTMLInputElement).maxLength).toBe(255);
    fireEvent.change(screen.getByLabelText(/重量（kg）/),{target:{value:'0.750123456'}});
    fireEvent.click(screen.getByRole('button',{name:'保存专属资料'}));
    await screen.findByText('记录刚被修改');
    expect((screen.getByLabelText(/重量（kg）/) as HTMLInputElement).value).toBe('0.750123456');
    fireEvent.click(screen.getByRole('button',{name:'保存专属资料'}));
    await waitFor(()=>expect(saved).toHaveBeenCalled());
    expect(resourceApi.confirmBaseProfile).toHaveBeenLastCalledWith(1,expect.objectContaining({weightG:750.123456}));
  });
  it('编码分类只用独立字典ID，保留商品档案分类归属不回写',async()=>{
    vi.mocked(resourceApi.list).mockResolvedValue({items:[{...record,id:7,type:'finance-code-dictionaries',title:'编码分类甲',status:'active',data:{kind:'product_category'}},{...record,id:8,type:'finance-code-dictionaries',title:'编码分类乙',status:'active',data:{kind:'product_category'}}],total:2,page:1,pageSize:200});
    render(<BaseCodeProfileEditor record={{...record,data:{...record.data,codeDictionaryCategoryId:7}}} onClose={()=>{}} onSaved={()=>{}}/>);
    await screen.findByRole('option',{name:'编码分类乙'});
    fireEvent.change(screen.getByRole('combobox',{name:/分类/}),{target:{value:'8'}});fireEvent.click(screen.getByRole('button',{name:'保存专属资料'}));
    await waitFor(()=>expect(resourceApi.confirmBaseProfile).toHaveBeenCalledWith(1,expect.objectContaining({codeDictionaryCategoryId:8})));
    expect(vi.mocked(resourceApi.confirmBaseProfile).mock.calls[0][1]).not.toHaveProperty('categoryId');
  });
  it('来源商品资料名显示原基础信息全称，不用简名代替',async()=>{
    vi.mocked(resourceApi.get).mockResolvedValue({...record,type:'finance-products',title:'苹果',status:'deleted',data:{archiveType:'purchased',basicInfoFullName:'苹果-合成品牌-500-克-袋-原装采购',totalCost:700,purchaseSpec:'袋'}});
    render(<BaseCodeProfileEditor record={{...record,data:{...record.data,productId:8}}} onClose={()=>{}} onSaved={()=>{}}/>);
    await screen.findByText('苹果-合成品牌-500-克-袋-原装采购',{selector:'.base-profile-source-name strong'});
    expect(screen.getByText('来源商品档案已删除，以下为保留的档案资料。')).toBeTruthy();
    expect(screen.getByText('¥7.000 / 袋',{selector:'.base-profile-source-cost strong'})).toBeTruthy();
  });
  it('生效引用锁住身份字段，名称仍可编辑',async()=>{
    vi.mocked(api).mockResolvedValue({lockedFields:['code','styleCode','categoryId','weightG'],items:[]});
    render(<BaseCodeProfileEditor record={record} onClose={()=>{}} onSaved={()=>{}}/>);
    await screen.findByText(/该商品编码已有生效引用/);
    expect((screen.getByLabelText(/重量（kg）/) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText(/商品名称/) as HTMLInputElement).disabled).toBe(false);
  });
  it('组合基础编辑不会提交编码或组成；停用先要求原因',async()=>{
    render(<BundleProfileEditor record={{...record,type:'finance-bundles'}} onClose={()=>{}} onSaved={()=>{}}/>);
    fireEvent.change(screen.getByLabelText('商品名称 *'),{target:{value:'新组合'}});
    fireEvent.change(screen.getByLabelText('状态 *'),{target:{value:'inactive'}});
    fireEvent.click(screen.getByRole('button',{name:'保存修改'}));
    await screen.findByText(/请填写停用原因/);expect(resourceApi.confirmBundleProfile).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('停用原因'),{target:{value:'停止销售'}});
    fireEvent.click(screen.getByRole('button',{name:'保存修改'}));
    await waitFor(()=>expect(resourceApi.confirmBundleProfile).toHaveBeenCalledWith(1,{name:'新组合',shortName:'原料简称',status:'inactive',statusReason:'停止销售'}));
  });
});
it('编码目录缺续页不能当末级；停用子类也使父类不可新选',async()=>{
 const parent={...record,id:7,type:'finance-code-dictionaries',title:'编码父类',status:'active',data:{kind:'product_category'}},child={...record,id:8,type:'finance-code-dictionaries',title:'停用子类',status:'inactive',data:{kind:'product_category',parentId:7}},leaf={...record,id:9,type:'finance-code-dictionaries',title:'可选末级',status:'active',data:{kind:'product_category'}};
 vi.mocked(resourceApi.list).mockResolvedValue({items:[parent,child,leaf],total:3,page:1,pageSize:200});
 const rendered=render(<BaseCodeProfileEditor record={record} onClose={()=>{}} onSaved={()=>{}}/>);
 await screen.findByRole('option',{name:'可选末级'});expect(screen.queryByRole('option',{name:'编码父类'})).toBeNull();expect(screen.queryByRole('option',{name:/停用子类/})).toBeNull();rendered.unmount();
 vi.mocked(resourceApi.list).mockImplementation(async(_,q)=>({items:q?.page===1?[parent]:[],total:2,page:q?.page??1,pageSize:200}));
 render(<BaseCodeProfileEditor record={record} onClose={()=>{}} onSaved={()=>{}}/>);await screen.findByText('分类读取失败，请关闭后重试。');expect((screen.getByRole('button',{name:'保存专属资料'}) as HTMLButtonElement).disabled).toBe(true);expect(resourceApi.confirmBaseProfile).not.toHaveBeenCalled();
});
