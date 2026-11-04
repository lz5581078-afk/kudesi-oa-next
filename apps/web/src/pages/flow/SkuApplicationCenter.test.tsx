import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {MemoryRouter,useLocation} from 'react-router-dom';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {RunList,TemplateInfo} from './flowApi';
const mocks=vi.hoisted(()=>({templates:vi.fn(),runs:vi.fn(),start:vi.fn(),split:vi.fn(),identity:{companyId:2,id:4,permissions:{isCompanyAdmin:true,allow:[] as string[],deny:[] as string[]}}}));
vi.mock('../../auth/AuthContext',()=>({useAuth:()=>({user:mocks.identity,can:()=>true})}));
vi.mock('./flowApi',async original=>({...await original<typeof import('./flowApi')>(),flowApi:{templates:(...args:unknown[])=>mocks.templates(...args),runs:(...args:unknown[])=>mocks.runs(...args),start:(...args:unknown[])=>mocks.start(...args)}}));
vi.mock('./SkuApply',async original=>({...await original<typeof import('./SkuApply')>(),skuApi:{startSplit:(...args:unknown[])=>mocks.split(...args)}}));
vi.mock('./SkuBatchPanel',()=>({SkuBatchPanel:({batchKey,onClose}:{batchKey:string;onClose:()=>void})=><div role="dialog" aria-label="真实批量办理面板">{batchKey}<button onClick={onClose}>关闭办理</button></div>}));
vi.mock('./FlowFields',()=>({FlowFieldsForm:({templateKey,onChange}:{templateKey:string;onChange:(key:string,value:unknown)=>void})=><button type="button" onClick={()=>{onChange('specs',[{name:'规格A'},{name:'规格B'}]);onChange('splitSpecs',true);}}>填写{templateKey}</button>}));
import {SkuApplicationCenter} from './SkuApplicationCenter';
import {RunsPage} from './RunsPage';
const template:TemplateInfo={key:'sku-batch-apply',label:'SKU批量申请',description:'真实SKU申请',active:true,version:1,fields:[],stepFields:{},steps:[{name:'运营申请',type:'submit'},{name:'仓库完善',type:'execute'},{name:'财务审核',type:'finance'}]};
const list=(title='我的合成申请'):RunList=>({total:1,page:1,pageSize:20,rows:[{id:21,batchRef:'Btest1',templateKey:template.key,templateLabel:template.label,title,status:'running',requesterName:'合成运营',handlers:[],stepName:null,dueAt:null,createdAt:'2026-11-04T00:00:00Z',finishedAt:null,overdue:false,specCount:3,completedSpecs:1,progress:[{name:'仓库完善',handlers:['合成仓库'],count:2,returned:false}]}]});
beforeEach(()=>{mocks.identity={companyId:2,id:4,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};mocks.templates.mockResolvedValue([template]);mocks.runs.mockResolvedValue(list());mocks.split.mockResolvedValue({batchKey:'Bnew',runs:[{id:91,specName:'规格A'},{id:92,specName:'规格B'}],failed:[]});});
afterEach(()=>{cleanup();vi.clearAllMocks();});
function Location(){return <output aria-label="页面地址">{useLocation().search}</output>;}
const Page=()=> <MemoryRouter initialEntries={['/finance-bundles?sort=code']}><SkuApplicationCenter onClose={()=>undefined}/><Location/></MemoryRouter>;
it('打开入口先查mine整申请列表，显式新建才展示现SKU表单，成功沿startSplit并刷新/进入批量面板',async()=>{
 render(<Page/>);await screen.findByText('我的合成申请');expect(mocks.runs).toHaveBeenCalledWith(expect.objectContaining({view:'started',templateKey:'sku-batch-apply',groupSku:true}));expect(mocks.start).not.toHaveBeenCalled();expect(mocks.split).not.toHaveBeenCalled();expect(screen.queryByRole('dialog',{name:'发起SKU批量申请'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'新建申请'}));const dialog=await screen.findByRole('dialog',{name:'发起SKU批量申请'});fireEvent.click(within(dialog).getByRole('button',{name:'填写sku-batch-apply'}));fireEvent.click(within(dialog).getByRole('button',{name:'提交申请'}));
 await screen.findByRole('dialog',{name:'真实批量办理面板'});expect(screen.getByText('Bnew')).toBeTruthy();expect(mocks.split).toHaveBeenCalledWith({specs:[{name:'规格A'},{name:'规格B'}]},expect.any(String));expect(mocks.start).not.toHaveBeenCalled();await waitFor(()=>expect(mocks.runs.mock.calls.length).toBeGreaterThan(1));
});
it('查看申请进入既有SkuBatchPanel且不改组合页面查询参数，关闭返回mine列表',async()=>{
 render(<Page/>);await screen.findByText('我的合成申请');fireEvent.click(screen.getByRole('button',{name:'查看申请'}));expect(await screen.findByText('Btest1')).toBeTruthy();expect(screen.getByLabelText('页面地址').textContent).toBe('?sort=code');fireEvent.click(screen.getByRole('button',{name:'关闭办理'}));expect(screen.queryByRole('dialog',{name:'真实批量办理面板'})).toBeNull();expect(screen.getByText('我的合成申请')).toBeTruthy();
});
it('身份更换使旧列表请求失效，旧公司申请不会覆盖新身份列表',async()=>{
 let resolve!:(value:RunList)=>void;mocks.runs.mockReturnValueOnce(new Promise<RunList>(done=>{resolve=done;})).mockResolvedValueOnce(list('新公司申请'));
 const view=render(<Page/>);await waitFor(()=>expect(mocks.runs).toHaveBeenCalledTimes(1));mocks.identity={...mocks.identity,companyId:9,id:10};view.rerender(<Page/>);await screen.findByText('新公司申请');await act(async()=>resolve(list('旧公司申请')));expect(screen.queryByText('旧公司申请')).toBeNull();expect(screen.getByText('新公司申请')).toBeTruthy();
});
it('默认我发起的页面仍走普通流程列表，不默认限制SKU或整申请分组',async()=>{
 render(<MemoryRouter><RunsPage view="started"/></MemoryRouter>);await screen.findByRole('heading',{name:'我发起的'});expect(mocks.runs).toHaveBeenCalledWith(expect.objectContaining({view:'started',templateKey:''}));expect(mocks.runs.mock.calls[0][0]).not.toHaveProperty('groupSku');expect(screen.getByRole('columnheader',{name:'标题'})).toBeTruthy();
});

it('拆分全失败不打开空汇总，保留原表单和同一requestKey以便重试',async()=>{
 mocks.split.mockResolvedValueOnce({batchKey:'Bempty',runs:[],failed:[{specName:'规格A',message:'合成失败A'},{specName:'规格B',message:'合成失败B'}]});render(<Page/>);await screen.findByText('我的合成申请');fireEvent.click(screen.getByRole('button',{name:'新建申请'}));const dialog=await screen.findByRole('dialog',{name:'发起SKU批量申请'});fireEvent.click(within(dialog).getByRole('button',{name:'填写sku-batch-apply'}));fireEvent.click(within(dialog).getByRole('button',{name:'提交申请'}));
 await within(dialog).findByText(/所有规格均未发起成功/);expect(screen.queryByRole('dialog',{name:'真实批量办理面板'})).toBeNull();expect(screen.getByRole('dialog',{name:'发起SKU批量申请'})).toBeTruthy();expect(mocks.split.mock.calls[0][0]).toEqual({specs:[{name:'规格A'},{name:'规格B'}]});
 fireEvent.click(within(dialog).getByRole('button',{name:'提交申请'}));await screen.findByRole('dialog',{name:'真实批量办理面板'});expect(mocks.split.mock.calls[1]).toEqual(mocks.split.mock.calls[0]);
});
