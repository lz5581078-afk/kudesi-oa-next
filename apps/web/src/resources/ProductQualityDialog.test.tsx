import { cleanup, fireEvent, render, screen, waitFor,within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth/AuthContext',()=>({useAuth:()=>({user:{id:1,companyId:1,permissions:{isCompanyAdmin:true,allow:[],deny:[]}}})}));
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  resourceApi: { list: vi.fn().mockResolvedValue({ items: [{id:1,type:'finance-zero-reasons',title:'产地自提',data:{reason:'产地自提'},status:'active'},{id:2,type:'finance-zero-reasons',title:'客户自备',data:{reason:'客户自备'},status:'active'}],total:2 }),create:vi.fn(),update:vi.fn(),remove:vi.fn() },
}));
import { ProductQualityDialog } from './ProductQualityDialog';
import {archiveQualityContext,type SourceQualityFacts} from '@kudesi/shared';

afterEach(cleanup);
const raw = { archiveType: 'raw', name: '苹果', purchaseSpec: '千克', purchasePrice: 1000, freight: 0, handlingFee: 0 };
const sourceFacts=():SourceQualityFacts=>({version:1,productId:3,parent:{...raw,code:'YL-PG-1KG',categoryId:4,specQty:1,specUnit:'KG',weightG:1000,weightUnit:'kg',freight:10,handlingFee:10},sources:[{key:'id:9',id:9,status:'active',supplierId:5,originArea:'山东',systemSpec:'千克',purchasePrice:''},{key:'id:10',id:10,status:'active',supplierId:6,originArea:'河北',systemSpec:'千克',purchasePrice:0}],composition:[]});

describe('核算资料确认：完整面板', () => {
  it('逐个确认实际来源，空采购价回填0；原因和行身份分别交给同一保存表单',async()=>{
    const facts=sourceFacts(),onConfirm=vi.fn();
    render(<ProductQualityDialog values={facts.parent} options={{canCost:true,sourceFacts:facts}} onCancel={()=>undefined} onConfirm={onConfirm}/>);
    await waitFor(()=>expect((screen.getByLabelText('来源1采购价零值原因') as HTMLInputElement).disabled).toBe(false));
    for(const [label,reason] of [['来源1采购价','产地自提'],['来源2采购价','客户自备']]){
      fireEvent.change(screen.getByLabelText(label+'零值原因'),{target:{value:reason}});
      const input=screen.getByLabelText(label+'零值原因');
      fireEvent.click(within(input.closest('.product-quality-row') as HTMLElement).getByRole('button',{name:'确认该项为0'}));
    }
    const save=screen.getByRole('button',{name:'确认并保存'});expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save);await waitFor(()=>expect(onConfirm).toHaveBeenCalledOnce());
    const result=onConfirm.mock.calls[0][0];expect(result['source:id:9:purchasePrice']).toBe(0);expect(result['source:id:10:purchasePrice']).toBe(0);
    expect(result.__sourceQuality.confirmations).toEqual({'source:id:9:purchasePrice':{reason:'产地自提',context:archiveQualityContext(facts)},'source:id:10:purchasePrice':{reason:'客户自备',context:archiveQualityContext(facts)}});
    expect(result.zeroValueReason??'').not.toContain('来源');
  });

  it('旧文本和旧上下文均不能代替当前来源的确认',async()=>{
    const facts=sourceFacts();facts.sources[0].purchasePrice=0;facts.sources[1].purchasePrice=100;facts.parent.zeroValueReason='来源1采购价：自提';
    const oldContext=archiveQualityContext(facts);facts.sources[0].supplierId=88;
    render(<ProductQualityDialog values={facts.parent} options={{canCost:true,sourceFacts:facts,confirmations:{'source:id:9:purchasePrice':{reason:'自提',context:oldContext}}}} onCancel={()=>undefined} onConfirm={()=>undefined}/>);
    expect(screen.getByText('来源1采购价为0，尚未明确确认')).toBeTruthy();expect(screen.queryByText('已确认：自提')).toBeNull();
    expect((screen.getByRole('button',{name:'确认并保存'}) as HTMLButtonElement).disabled).toBe(true);
  });

  it('列出采购价、运费、装卸费，填 0 的要写原因才能确认；原因库里的原因可直接选；未完成项目在下方列出', async () => {
    const onConfirm = vi.fn();
    render(<ProductQualityDialog values={raw} options={{ canCost: true }} onCancel={() => undefined} onConfirm={onConfirm} />);
    expect(screen.getByText('采购价')).toBeTruthy();
    expect(screen.getByText('10')).toBeTruthy();
    expect(screen.getByText('尚未完成的项目')).toBeTruthy();
    expect(screen.getByText('运费为0，尚未明确确认')).toBeTruthy();
    const confirm = screen.getByRole('button', { name: '确认并保存' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await waitFor(()=>expect((screen.getByLabelText('运费零值原因') as HTMLInputElement).disabled).toBe(false));
    fireEvent.focus(screen.getByLabelText('运费零值原因'));
    fireEvent.click(await screen.findByRole('option',{name:'产地自提'}));
    fireEvent.click(screen.getAllByRole('button', { name: '确认该项为0' })[0]);
    expect(screen.getByText('已确认：产地自提')).toBeTruthy();
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('装卸费零值原因'), { target: { value: ' 客户自备 ' } });
    fireEvent.click(screen.getByRole('button', { name: '确认该项为0' }));
    expect(document.querySelector('datalist')).toBeNull();
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(onConfirm.mock.calls[0][0].zeroValueReason).toMatch(/运费：产地自提/);
    expect(onConfirm.mock.calls[0][0].zeroValueReason).toMatch(/装卸费：客户自备/);
  });

  it('人工修正的重量为 0：确认不计重量；没填的项目要先返回修改', async () => {
    render(<ProductQualityDialog values={{ ...raw, purchaseSpec: '', freight: 10, handlingFee: 10, weightManual: true, weightG: 0 }} options={{ canCost: true }} onCancel={() => undefined} onConfirm={() => undefined} />);
    expect(screen.getByText('系统规格未填写')).toBeTruthy();
    await waitFor(()=>expect((screen.getByLabelText('重量零值原因') as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText('重量零值原因'), { target: { value: '赠品不计重' } });
    fireEvent.click(screen.getByRole('button', { name: '确认不计重量' }));
    expect(screen.getByText('已确认：赠品不计重')).toBeTruthy();
    expect((screen.getByRole('button', { name: '确认并保存' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('自制品已有构成但没有包装组成：确认不需要', async () => {
    const made = { archiveType: 'self_made', name: '礼盒', brandId: 1, productPackagingSpec: '500G袋', freight: 0, handlingFee: 0, zeroValueReason: '运费：无\n装卸费：无' };
    const onConfirm = vi.fn();
    render(<ProductQualityDialog values={made} options={{ canCost: true, composition: { packaging: 0, labor: 1 } }} onCancel={() => undefined} onConfirm={onConfirm} />);
    await waitFor(()=>expect((screen.getByLabelText('包装组成零值原因') as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText('包装组成零值原因'), { target: { value: '裸装发货' } });
    fireEvent.click(screen.getByRole('button', { name: '确认不需要' }));
    fireEvent.click(screen.getByRole('button', { name: '确认并保存' }));
    expect(onConfirm.mock.calls[0][0].zeroValueReason).toContain('包装组成：裸装发货');
  });
});
