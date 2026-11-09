import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {SkuAiFillPanel} from './SkuAiFillPanel';
const mocks=vi.hoisted(()=>({api:vi.fn(),names:vi.fn()}));
vi.mock('../../api/client',()=>({api:mocks.api,ApiError:class extends Error{}}));
vi.mock('./SkuApply',()=>({skuApi:{catalog:vi.fn(),catalogNames:mocks.names}}));
vi.mock('./SkuProductPicker',()=>({SkuProductPicker:({label,onChoose}:{label:string;onChoose:(rows:unknown[])=>void})=><button type="button" onClick={()=>onChoose(label.includes('赠品')?[{id:9,code:'G',name:'小袋',spec:'100g'}]:[{id:1,code:'A',name:'大袋',spec:'200g'},{id:2,code:'B',name:'中袋',spec:'100g'}])}>{label}确认</button>}));
afterEach(()=>{cleanup();vi.clearAllMocks();});

it('选主商品和赠品后：按规格名称重量凑数量，品牌取主商品，凑不出来的留空并提示，应用时交给上一层',async()=>{
 mocks.api.mockResolvedValue({items:[{name:'500g',mainGrams:500,giftGrams:200},{name:'450g',mainGrams:450,giftGrams:null}]});
 mocks.names.mockResolvedValue({items:[{id:1,brandId:7},{id:2,brandId:7}]});
 const apply=vi.fn();render(<SkuAiFillPanel names={['500g','450g']} onApply={apply} onClose={()=>undefined}/>);
 expect((screen.getByText('开始填写') as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getAllByText('选择主商品')[0]);fireEvent.click(await screen.findByText('选择主商品构成确认'));
 fireEvent.click(screen.getByText('选择赠品'));fireEvent.click(await screen.findByText('选择赠品构成确认'));
 fireEvent.click(screen.getByText('开始填写'));
 await screen.findByText(/大袋.*× 2；中袋.*× 1/);
 expect(screen.getByText(/小袋.*× 2/)).toBeTruthy();
 expect(screen.getByText(/需确认：主商品 450g.*凑不出来/)).toBeTruthy();
 expect(screen.getByText('默认品牌：取自所选主商品')).toBeTruthy();
 expect(mocks.api).toHaveBeenCalledWith('/flow/sku-apply/ai-parse',{body:{names:['500g','450g']}});
 fireEvent.click(screen.getByText('应用到申请'));
 await waitFor(()=>expect(apply).toHaveBeenCalledTimes(1));
 const out=apply.mock.calls[0][0];
 expect(out.brandId).toBe(7);
 expect(out.specs[0]).toMatchObject({main:[{baseCodeId:1,qty:2},{baseCodeId:2,qty:1}],gift:[{baseCodeId:9,qty:2}]});
 expect(out.specs[1].main).toEqual([]);
});
it('主商品品牌不一致时默认品牌留空',async()=>{
 mocks.api.mockResolvedValue({items:[{name:'300g',mainGrams:300,giftGrams:null}]});mocks.names.mockResolvedValue({items:[{id:1,brandId:7},{id:2,brandId:8}]});
 render(<SkuAiFillPanel names={['300g']} onApply={()=>undefined} onClose={()=>undefined}/>);
 fireEvent.click(screen.getAllByText('选择主商品')[0]);fireEvent.click(await screen.findByText('选择主商品构成确认'));fireEvent.click(screen.getByText('开始填写'));
 await screen.findByText('默认品牌：所选主商品没有统一品牌，留空');
});
