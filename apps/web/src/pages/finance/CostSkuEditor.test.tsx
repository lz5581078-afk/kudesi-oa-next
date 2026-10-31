import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { CostSkuEditor } from './CostSkuEditor';
import { costVersionsApi } from './costVersionsApi';
import { resourceApi,type ResourceDto } from '../../resources/api';

vi.mock('./costVersionsApi',()=>({costVersionsApi:{skuOptions:vi.fn()}}));
vi.mock('../../resources/api',()=>({resourceApi:{create:vi.fn(),update:vi.fn()}}));
const version:ResourceDto={id:1,type:'finance-cost-versions',title:'秋季',status:'draft',statusReason:null,data:{defaultMarkupPercent:20},refLabels:{},secretConfigured:{},files:{},createdAt:'',updatedAt:''};
const option={skuType:'base_code',skuId:8,code:'BC-8',name:'参考商品',weightG:1234.56789,buckets:{purchase:111.1234},warnings:[]};
beforeEach(()=>{vi.mocked(costVersionsApi.skuOptions).mockResolvedValue({rows:[option],total:1,page:1,pageSize:30});vi.mocked(resourceApi.create).mockResolvedValue({} as ResourceDto);});
afterEach(()=>{cleanup();vi.resetAllMocks();});
describe('SKU计算设置',()=>{
  it('选择已验证SKU，六科目只读，重量与加价率留空按来源和版本默认保存',async()=>{
    const onSaved=vi.fn();render(<CostSkuEditor version={version} record={null} onClose={()=>{}} onSaved={onSaved}/>);
    expect(screen.getByRole('button',{name:'保存SKU计算设置'}).hasAttribute('disabled')).toBe(true);
    fireEvent.click(await screen.findByRole('button',{name:'选择'}));
    expect(screen.getByLabelText('采购成本').hasAttribute('readonly')).toBe(true);
    fireEvent.click(screen.getByRole('button',{name:'保存SKU计算设置'}));
    await waitFor(()=>expect(resourceApi.create).toHaveBeenCalledWith('finance-cost-skus',expect.objectContaining({versionId:1,skuType:'base_code',baseCodeId:8,estimatedWeightG:null,markupPercent:null})));
    expect(Object.keys(vi.mocked(resourceApi.create).mock.calls[0][1])).not.toContain('purchaseCost');expect(onSaved).toHaveBeenCalledOnce();
  });
  it('六位小数公斤转换到克，既有快照不随设置保存被覆盖',async()=>{
    const record={...version,id:10,title:'既有商品',data:{versionId:1,skuType:'base_code',baseCodeId:8,skuCode:'BC-8',purchaseCost:112.3456,weightManual:true,estimatedWeightG:2000}} as ResourceDto;
    render(<CostSkuEditor version={version} record={record} onClose={()=>{}} onSaved={()=>{}}/>);
    expect((screen.getByLabelText('采购成本') as HTMLInputElement).value).toBe('1.123456');
    fireEvent.change(screen.getByLabelText('预计重量覆盖（kg）'),{target:{value:'0.123456'}});
    fireEvent.click(screen.getByRole('button',{name:'保存SKU计算设置'}));
    await waitFor(()=>expect(resourceApi.update).toHaveBeenCalledWith('finance-cost-skus',10,expect.objectContaining({estimatedWeightG:123.456})));
    expect(Object.keys(vi.mocked(resourceApi.update).mock.calls[0][2])).not.toContain('purchaseCost');
  });
  it('无效重量不能提交，切换编码类型后必须重新选择',async()=>{
    render(<CostSkuEditor version={version} record={null} onClose={()=>{}} onSaved={()=>{}}/>);
    fireEvent.click(await screen.findByRole('button',{name:'选择'}));fireEvent.change(screen.getByLabelText('预计重量覆盖（kg）'),{target:{value:'-1'}});
    fireEvent.click(screen.getByRole('button',{name:'保存SKU计算设置'}));expect((await screen.findByRole('alert')).textContent).toContain('不能为负数');expect(resourceApi.create).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('编码类型'),{target:{value:'bundle'}});expect(screen.getByRole('button',{name:'保存SKU计算设置'}).hasAttribute('disabled')).toBe(true);
  });
});
