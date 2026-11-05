import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {MemoryRouter,Outlet,Route,Routes,useLocation} from 'react-router-dom';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createChecker} from '@kudesi/shared';
import {Shell} from './Shell';
import {TabHost,type HostTab} from './TabHost';
vi.mock('./NotificationBell',()=>({NotificationBell:()=>null}));
vi.mock('../pages/workspace/workspaceApi',()=>({workspaceApi:{catalog:async()=>({positions:[]})}}));
let deny:string[]=[];
vi.mock('../auth/AuthContext',()=>({useAuth:()=>({user:{id:1,companyId:1,name:'示例',account:'preview',companyName:'示例公司'},can:createChecker({isCompanyAdmin:false,allow:['finance.*','resource.*','workbench.*'],deny}),logout:vi.fn()})}));
const tabs:HostTab[]=[
 {id:'finance-bundles',ref:'finance-bundles',label:'商品组合编码',permission:'resource.finance-bundles.view',Component:()=> <p>组合主列表</p>},
 {id:'finance-platforms',ref:'finance-platforms',label:'销售平台',permission:'resource.finance-platforms.view',Component:()=> <p>平台列表</p>},
 {id:'finance-scenarios',ref:'finance-scenarios',label:'销售场景',permission:'resource.finance-scenarios.view',Component:()=> <p>场景列表</p>},
];
function Location(){const value=useLocation();return <output aria-label="当前地址">{value.pathname}{value.search}</output>;}
function mount(path='/finance/finance-bundles?keyword=保留',primaryCount:number|null=1){return render(<MemoryRouter initialEntries={[path]}><Routes><Route element={<Shell/>}><Route path="*" element={<><TabHost tabs={tabs} primaryCount={primaryCount??undefined}/><Location/></>}/></Route></Routes></MemoryRouter>);}
beforeEach(()=>{deny=[];});afterEach(cleanup);
describe('财务页面标题与辅助维护入口',()=>{
 it('主页面只显示一个标题，维护页仍可进入并返回，查询条件保留',async()=>{
  mount();expect(screen.getByRole('heading',{level:1,name:'商品组合编码'})).toBeTruthy();expect(screen.queryByRole('tablist',{name:'页面分区'})).toBeNull();
  fireEvent.click(screen.getByText('资料维护',{selector:'summary'}));fireEvent.click(screen.getByRole('tab',{name:'销售平台'}));
  expect(screen.getByRole('heading',{level:1,name:'销售平台'})).toBeTruthy();expect(screen.getByText('平台列表')).toBeTruthy();expect(screen.getByLabelText('当前地址').textContent).toContain('keyword=');
  fireEvent.click(screen.getByText('资料维护 · 销售平台',{selector:'summary'}));fireEvent.click(screen.getByRole('button',{name:'返回商品组合编码'}));expect(screen.getByText('组合主列表')).toBeTruthy();expect(screen.getByLabelText('当前地址').textContent).not.toContain('tab=');expect(screen.getByLabelText('当前地址').textContent).toContain('keyword=');
 });
 it('无权限的辅助页不提供入口，伪造tab参数不改变标题或内容',()=>{
  deny=['resource.finance-platforms.view'];
  mount('/finance/finance-bundles?tab=finance-platforms');
  expect(screen.getByRole('heading',{level:1,name:'商品组合编码'})).toBeTruthy();expect(screen.getByText('组合主列表')).toBeTruthy();
  fireEvent.click(screen.getByText('资料维护',{selector:'summary'}));expect(screen.queryByRole('tab',{name:'销售平台'})).toBeNull();expect(screen.getByRole('tab',{name:'销售场景'})).toBeTruthy();
 });
 it('未分组的原有页面分区仍保留正常页签导航',()=>{
  mount('/finance/finance-bundles',null);const nav=screen.getByRole('tablist',{name:'页面分区'});expect(within(nav).getAllByRole('tab')).toHaveLength(3);expect(screen.queryByText('资料维护',{selector:'summary'})).toBeNull();
 });
 it('非财务页面不会套用财务标题与内容样式',()=>{
  mount('/account/password');expect(document.querySelector('main.finance-page-content')).toBeNull();expect(within(screen.getByLabelText('当前位置')).queryByRole('heading')).toBeNull();
 });
});
