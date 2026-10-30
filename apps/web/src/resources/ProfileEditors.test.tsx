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
    fireEvent.change(screen.getByLabelText(/重量（kg）/),{target:{value:'0.750123456'}});
    fireEvent.click(screen.getByRole('button',{name:'保存专属资料'}));
    await screen.findByText('记录刚被修改');
    expect((screen.getByLabelText(/重量（kg）/) as HTMLInputElement).value).toBe('0.750123456');
    fireEvent.click(screen.getByRole('button',{name:'保存专属资料'}));
    await waitFor(()=>expect(saved).toHaveBeenCalled());
    expect(resourceApi.confirmBaseProfile).toHaveBeenLastCalledWith(1,expect.objectContaining({weightG:750.123456,categoryId:4}));
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
