import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';
import {afterEach,expect,it,vi} from 'vitest';
import {ApplyPage} from './ApplyPage';
import {flowApi} from './flowApi';

vi.mock('./flowApi',async original=>({...await original<typeof import('./flowApi')>(),flowApi:{templates:vi.fn(),start:vi.fn()}}));
vi.mock('./SkuApplicationCenter',()=>({SkuApplicationCenter:({onClose}:{onClose:()=>void})=><div role="dialog" aria-label="SKU批量申请"><button onClick={onClose}>关闭申请中心</button></div>}));
afterEach(()=>{cleanup();vi.clearAllMocks();});

it.each([true,false])('流程入口与商品组合编码打开同一 SKU 申请中心，模板启用=%s',async active=>{
  vi.mocked(flowApi.templates).mockResolvedValue([{key:'sku-batch-apply',label:'SKU 批量申请',description:'',active,fields:[],stepFields:{},version:1,steps:[]}]);
  render(<MemoryRouter><ApplyPage/></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button',{name:'发起申请'}));
  expect(screen.getByRole('dialog',{name:'SKU批量申请'})).toBeTruthy();
  expect(screen.queryByRole('button',{name:'提交申请'})).toBeNull();
  expect(flowApi.start).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'关闭申请中心'}));
  expect(screen.queryByRole('dialog')).toBeNull();
});
