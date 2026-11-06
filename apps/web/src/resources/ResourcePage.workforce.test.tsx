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
 request.mockImplementation(async(path:string)=>path==='/workforce/unfiled'?[{id:80,name:'试播小白',account:null,employmentType:'part_time',trial:true}]:path==='/workforce/login-display'?[{id:70,account:'oa70',loginPassword:'Preview-only-123',feishuBound:false},{id:80,account:null,loginPassword:'未设置',feishuBound:true}]:[]);
});
afterEach(()=>{cleanup();vi.clearAllMocks();});
describe('用工列表姓名账号及试播人员',()=>{
 it('姓名与OA账号分列，明文密码显示；未建档试播同表标黄且不可批量选择',async()=>{
  render(<MemoryRouter><ResourcePage type="workforce"/></MemoryRouter>);
  const trial=await screen.findByText('试播小白');
  expect(trial.closest('tr')?.classList.contains('workforce-incomplete')).toBe(true);
  expect(screen.getAllByText('试播主播').length).toBeGreaterThan(0);
  expect(screen.getByText('oa70')).toBeTruthy();expect(screen.getByText('Preview-only-123')).toBeTruthy();
  expect(screen.queryByText('登录账号（员工）')).toBeNull();
  expect((screen.getByRole('checkbox',{name:'勾选 试播小白'}) as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox',{name:'本页全选'}));
  expect((screen.getByRole('checkbox',{name:'勾选 试播小白'}) as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByRole('button',{name:'建立账号'}));
  expect(await screen.findByText('员工编辑80')).toBeTruthy();
 });
 it('按员工编号预览待补资料人员的绑定，已建档未绑定人员没有解绑按钮',async()=>{
  const preview=vi.spyOn(orgApi,'staffFeishuUnbindPreview').mockResolvedValue({userId:80,name:'试播小白',account:'',bindingCount:1,includesSelf:false,fingerprint:'a'.repeat(64)});
  render(<MemoryRouter><ResourcePage type="workforce"/></MemoryRouter>);
  const trial=within((await screen.findByText('试播小白')).closest('tr')!);
  expect(trial.getByText('已绑定')).toBeTruthy();
  expect(within(screen.getByText('正式建档主播').closest('tr')!).getByText('未绑定')).toBeTruthy();
  expect(screen.getAllByRole('button',{name:'解绑飞书'})).toHaveLength(1);
  fireEvent.click(trial.getByRole('button',{name:'解绑飞书'}));
  await screen.findByRole('dialog',{name:'解绑员工飞书'});
  expect(preview).toHaveBeenCalledWith(80);preview.mockRestore();
 });
 it('试播和已建档人员都进入同一个员工编辑，取消网格和独立账号设置',async()=>{
  render(<MemoryRouter><ResourcePage type="workforce"/></MemoryRouter>);
  const trial=await screen.findByText('试播小白');
  fireEvent.click(within(trial.closest('tr')!).getByRole('button',{name:'建立账号'}));
  expect(await screen.findByText('员工编辑80')).toBeTruthy();
  fireEvent.click(within(screen.getByText('正式建档主播').closest('tr')!).getByRole('button',{name:'编辑'}));
  expect(await screen.findByText('员工编辑70')).toBeTruthy();
  expect(screen.queryByRole('button',{name:'设置账号密码'})).toBeNull();
  expect(screen.queryByRole('button',{name:'表格编辑'})).toBeNull();
  fireEvent.change(screen.getByLabelText('搜索'),{target:{value:'不匹配'}});
  await waitFor(()=>expect(screen.queryByText('试播小白')).toBeNull());
 });
 it('没有密码管理权限时不渲染密码列',async()=>{
  auth.user.permissions={isCompanyAdmin:false,allow:['resource.workforce.view'],deny:[]};
  render(<MemoryRouter><ResourcePage type="workforce"/></MemoryRouter>);
  await screen.findByText('试播小白');
  expect(screen.queryByRole('button',{name:'解绑飞书'})).toBeNull();expect(screen.getByText('已绑定')).toBeTruthy();expect(screen.queryByText('登录密码')).toBeNull();expect(screen.queryByText('Preview-only-123')).toBeNull();
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
