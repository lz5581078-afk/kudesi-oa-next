import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resourceApi } from './api';
import { orgApi } from '../pages/org/orgApi';
const auth={user:{permissions:{isCompanyAdmin:true,allow:[] as string[],deny:[] as string[]}}};
vi.mock('../auth/AuthContext',()=>({useAuth:()=>auth}));
vi.mock('./RecordForm',()=>({RecordForm:()=> <div>补资料表单</div>,loadRefOptions:async()=>[]}));
vi.mock('./RecordDetail',()=>({RecordDetail:({id}:{id:number})=><div>详情{id}</div>,useResourceCan:()=>()=>true}));
vi.mock('../pages/org/StaffEditorDialog', () => ({ StaffEditorDialog: ({ id }: { id: number }) => <div>员工编辑{id}</div> }));
vi.mock('./CategoryTree',()=>({CategoryTree:()=>null}));
vi.mock('./api',async orig=>{const mod=await orig<typeof import('./api')>();return {...mod,resourceApi:{...mod.resourceApi,list:vi.fn(),users:vi.fn().mockResolvedValue([]),departments:vi.fn().mockResolvedValue([])}};});
const request=vi.fn();
vi.mock('../api/client',async orig=>({...await orig<typeof import('../api/client')>(),api:(...args:unknown[])=>request(...args)}));
import { ResourcePage } from './ResourcePage';
const row={id:7,type:'workforce',title:'正式建档主播',status:'active',statusReason:null,data:{userId:70,name:'正式建档主播',employmentType:'part_time',account:'oa70'},refLabels:{userId:'正式建档主播'},secretConfigured:{},files:{},createdAt:'',updatedAt:''};
beforeEach(()=>{
 localStorage.clear();auth.user.permissions={isCompanyAdmin:true,allow:[],deny:[]};
 vi.mocked(resourceApi.list).mockResolvedValue({items:[row],total:1,page:1,pageSize:20,tabCounts:{}});
 request.mockImplementation(async(path:string)=>path==='/workforce/unfiled'?[{id:80,name:'试播小白',account:null,employmentType:'part_time'}]:path==='/workforce/login-display'?[{id:70,account:'oa70',loginPassword:'Preview-only-123'},{id:80,account:null,loginPassword:'未设置'}]:[]);
});
afterEach(()=>{cleanup();vi.clearAllMocks();});
describe('用工列表姓名账号及试播人员',()=>{
 it('姓名与OA账号分列，明文密码显示；未建档试播同表标黄且不可批量选择',async()=>{
  render(<MemoryRouter><ResourcePage type="workforce"/></MemoryRouter>);
  const trial=await screen.findByText('试播小白');
  expect(trial.closest('tr')?.classList.contains('workforce-incomplete')).toBe(true);
  expect(screen.getAllByText('待补资料').length).toBeGreaterThan(0);
  expect(screen.getByText('oa70')).toBeTruthy();expect(screen.getByText('Preview-only-123')).toBeTruthy();
  expect(screen.queryByText('登录账号（员工）')).toBeNull();
  expect((screen.getByRole('checkbox',{name:'勾选 试播小白'}) as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox',{name:'本页全选'}));
  expect((screen.getByRole('checkbox',{name:'勾选 试播小白'}) as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByRole('button',{name:'补资料'}));
  expect(await screen.findByText('员工编辑80')).toBeTruthy();
 });
 it('搜索过滤试播，未建档账号设置使用人员ID而不伪造档案ID',async()=>{
  render(<MemoryRouter><ResourcePage type="workforce"/></MemoryRouter>);
  const trial=await screen.findByText('试播小白');
  fireEvent.click(within(trial.closest('tr')!).getByRole('button',{name:'设置账号密码'}));
  // The action opens the same login dialog for a user without a resource record.
  expect(await screen.findByRole('dialog',{name:'设置登录账号和密码'})).toBeTruthy();
  fireEvent.change(screen.getByLabelText('登录账号'),{target:{value:'trial80'}});
  fireEvent.click(screen.getByRole('button',{name:'保存登录设置'}));
  await waitFor(()=>expect(request).toHaveBeenCalledWith('/workforce/users/80/login',{method:'PUT',body:{account:'trial80'}}));
  await waitFor(()=>expect(screen.queryByRole('dialog',{name:'设置登录账号和密码'})).toBeNull());
  fireEvent.change(screen.getByLabelText('搜索'),{target:{value:'不匹配'}});
  await waitFor(()=>expect(screen.queryByText('试播小白')).toBeNull());
 });
 it('没有密码管理权限时不渲染密码列',async()=>{
  auth.user.permissions={isCompanyAdmin:false,allow:['resource.workforce.view'],deny:[]};
  render(<MemoryRouter><ResourcePage type="workforce"/></MemoryRouter>);
  await screen.findByText('试播小白');
  expect(screen.queryByText('登录密码')).toBeNull();expect(screen.queryByText('Preview-only-123')).toBeNull();
 });

 it('显示停用后可找到未建档员工并用真实员工ID启用',async()=>{
  request.mockImplementation(async(path:string)=>path.startsWith('/workforce/unfiled')?(path.includes('showDisabled=true')?[{id:80,name:'停用试播',account:'trial80',employmentType:'part_time',status:'disabled'}]:[]):path==='/workforce/login-display'?[{id:70,account:'oa70'},{id:80,account:'trial80'}]:[]);
  const enable=vi.spyOn(orgApi,'setStatus').mockResolvedValue({} as never);
  render(<MemoryRouter><ResourcePage type="workforce"/></MemoryRouter>);
  await screen.findByText('正式建档主播');
  expect(screen.queryByText('停用试播')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:/筛选/}));
  fireEvent.click(screen.getByLabelText('显示已停用'));
  const employee=await screen.findByText('停用试播');
  fireEvent.click(within(employee.closest('tr')!).getByRole('button',{name:'启用'}));
  await waitFor(()=>expect(enable).toHaveBeenCalledWith(80,'active',undefined));
 });

});
