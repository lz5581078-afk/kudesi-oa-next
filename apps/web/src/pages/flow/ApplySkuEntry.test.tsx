import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';
import {afterEach,expect,it,vi} from 'vitest';
import {ApplyPage,EmployeeFlowShortcut} from './ApplyPage';
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

it('员工旧快捷链接只显示指定表单，不能打开通用申请中心', async () => {
  vi.mocked(flowApi.templates).mockResolvedValue([{key:'account-rename',label:'账号名称改名',description:'',active:true,fields:[],stepFields:{},version:1,steps:[]}]);
  render(<MemoryRouter initialEntries={['/flow/apply?template=account-rename']}><EmployeeFlowShortcut/></MemoryRouter>);
  expect(await screen.findByRole('dialog',{name:'发起账号名称改名'})).toBeTruthy();
  expect(screen.queryByRole('heading',{name:'申请中心'})).toBeNull();
  cleanup();
  render(<MemoryRouter initialEntries={['/flow/apply']}><EmployeeFlowShortcut/></MemoryRouter>);
  expect(screen.getByRole('heading',{name:'没有访问权限'})).toBeTruthy();
});
