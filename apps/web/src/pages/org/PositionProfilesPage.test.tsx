import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = { user: { permissions: { isCompanyAdmin: true, allow: [] as string[], deny: [] as string[] } } };
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => auth }));
import { orgApi } from './orgApi';
import { PositionProfilesPage } from './PositionProfilesPage';

const tree = [{ id: 1, name: '总部', sortOrder: 10, status: 'active', children: [
  { id: 2, name: '运营部', sortOrder: 10, status: 'active', children: [] },
  { id: 3, name: '财务部', sortOrder: 20, status: 'active', children: [] },
] }] as never;
const pos = (id: number, name: string, departmentId: number | null, extra: object = {}) => ({ id, name, departmentId, workspaceType: 'operations', permissions: [], userCount: 1, level: 'staff', supervisorPositionId: null, description: null, status: 'active', dutyCount: 3, ...extra });

beforeEach(() => {
  localStorage.clear();
  auth.user.permissions={isCompanyAdmin:true,allow:[],deny:[]};
  vi.spyOn(orgApi, 'departments').mockResolvedValue(tree);
  vi.spyOn(orgApi, 'catalog').mockResolvedValue([]);
  vi.spyOn(orgApi, 'positions').mockResolvedValue([
    pos(11, '运营专员', 2), pos(12, '运营主管', 2, { level: 'manager', userCount: 0 }), pos(13, '会计', 3, { workspaceType: 'finance' }), pos(14, '老板', null, { workspaceType: 'blank' }), pos(15, '旧岗', 3, { status: 'inactive' }),
  ] as never);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const page = () => render(<MemoryRouter><PositionProfilesPage /></MemoryRouter>);

describe('岗位档案：左部门右岗位', () => {
  it('没有大标题；按部门分组，每组一张表，列含默认工作台/在岗人数/职责数量；没有部门的在“未分配部门”', async () => {
    page();
    await screen.findByText('运营专员');
    expect(document.querySelector('.res-page h1, .res-page .page-title')).toBeNull();
    const heads = Array.from(document.querySelectorAll('.pp-group-head')).map((h) => h.textContent ?? '');
    expect(heads.length).toBe(3);
    expect(heads[0]).toContain('运营部');
    expect(heads[2]).toContain('未分配部门');
    expect(screen.getAllByText('默认工作台').length).toBeGreaterThan(0);
    expect(screen.getAllByText('在岗人数').length).toBeGreaterThan(0);
    expect(screen.getAllByText('职责数量').length).toBeGreaterThan(0);
    expect(screen.queryByText('旧岗')).toBeNull(); // 默认只看启用
  });
  it('默认工作台来自显式的岗位类型字段，不按名称猜：blank 显示“无”', async () => {
    page();
    const row = (await screen.findByRole('button', { name: '老板' })).closest('tr') as HTMLElement;
    expect(row.textContent).toContain('无');
    const acc = screen.getByRole('button', { name: '会计' }).closest('tr') as HTMLElement;
    expect(acc.textContent).toContain('财务工作台');
  });
  it('分组可折叠；选部门含下级；“无人在岗”只留没人的岗位；状态选“全部”能看到停用岗位', async () => {
    page();
    await screen.findByText('运营专员');
    fireEvent.click(document.querySelectorAll('.pp-group-head')[0] as HTMLElement);
    expect(screen.queryByText('运营专员')).toBeNull();
    fireEvent.click(document.querySelectorAll('.pp-group-head')[0] as HTMLElement);
    expect(screen.getByText('运营专员')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /无人在岗/ }));
    expect(screen.queryByText('运营专员')).toBeNull();
    expect(screen.getByText('运营主管')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /无人在岗/ }));
    fireEvent.change(screen.getByDisplayValue('启用'), { target: { value: '' } });
    expect(await screen.findByText('旧岗')).toBeTruthy();
    fireEvent.click(within(screen.getByLabelText('选择部门')).getByRole('button',{name:/总部/}));
    expect(screen.getByText('会计')).toBeTruthy();
  });
  it('点岗位名进入整页档案，可返回列表', async () => {
    vi.spyOn(orgApi, 'positionProfile').mockResolvedValue({
      position: { id: 13, name: '会计', positionKey: null, departmentId: 3, departmentName: '财务部', workspaceType: 'finance', level: 'staff', supervisorPositionId: null, supervisorPositionName: null, description: null, status: 'active', },
      staff: [], duties: [], permissions: [], logs: [],
    } as never);
    page();
    fireEvent.click(await screen.findByRole('button', { name: '会计' }));
    expect(await screen.findByRole('button', { name: /返回列表/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /返回列表/ }));
    await waitFor(() => expect(within(document.body).getByText('运营专员')).toBeTruthy());
  });
  it('左侧包含空部门和未分配，选择部门后右侧只显示该部门及下级岗位',async()=>{
    vi.spyOn(orgApi,'departments').mockResolvedValue([{id:1,name:'总部',sortOrder:10,status:'active',children:[{id:2,name:'运营部',sortOrder:10,status:'active',children:[]},{id:3,name:'财务部',sortOrder:20,status:'active',children:[]},{id:4,name:'空部门',sortOrder:30,status:'active',children:[]}]}] as never);
    page();await screen.findByText('运营专员');const nav=within(screen.getByLabelText('选择部门'));
    fireEvent.click(nav.getByRole('button',{name:/运营部/}));
    const content=within(screen.getByLabelText('岗位内容'));
    expect(content.getByRole('button',{name:'运营专员'})).toBeTruthy();expect(content.queryByRole('button',{name:'会计'})).toBeNull();
    fireEvent.click(nav.getByRole('button',{name:/总部/}));expect(content.getByRole('button',{name:'会计'})).toBeTruthy();expect(content.queryByRole('button',{name:'老板'})).toBeNull();
    fireEvent.click(nav.getByRole('button',{name:/未分配部门/}));expect(content.getByRole('button',{name:'老板'})).toBeTruthy();
    fireEvent.click(nav.getByRole('button',{name:/空部门/}));expect(content.getByText(/没有符合条件的岗位/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:/新增岗位/}));const dialog=await screen.findByRole('dialog');expect((within(dialog).getByLabelText('所属部门') as HTMLSelectElement).value).toBe('4');
  });

  it('岗位详情保留部门列表，可以直接切到另一个部门',async()=>{
    vi.spyOn(orgApi,'positionProfile').mockResolvedValue({position:{...pos(13,'会计',3),departmentName:'财务部'},staff:[],duties:[],permissions:[],logs:[]} as never);
    page();fireEvent.click(await screen.findByRole('button',{name:'会计'}));await screen.findByRole('button',{name:'返回列表'});
    fireEvent.click(within(screen.getByLabelText('选择部门')).getByRole('button',{name:/运营部/}));
    expect(screen.queryByRole('button',{name:'返回列表'})).toBeNull();expect(screen.getByRole('button',{name:'运营专员'})).toBeTruthy();
  });

  it('岗位在岗人员可编辑完整资料，保留主岗、兼任、上级和薪资，保存刷新',async()=>{
    const profile={position:{...pos(11,'运营专员',2),departmentName:'运营部'},staff:[{id:21,name:'小王',status:'active',concurrent:false}],duties:[],permissions:[],logs:[]};
    vi.spyOn(orgApi,'positionProfile').mockResolvedValue(profile as never);
    const person={id:21,account:'wang',name:'小王',departmentId:2,positionId:11,positionName:'运营专员',status:'active',isCompanyAdmin:false,lastLoginAt:null,managerId:22,title:'资深',extraPositionIds:[13],employmentType:'part_time',payType:'hourly',hourlyRate:7500,baseSalary:null,allow:[],deny:[]};
    vi.spyOn(orgApi,'staffOne').mockResolvedValue(person as never);
    vi.spyOn(orgApi,'staff').mockResolvedValue([person,{...person,id:22,name:'主管'}] as never);
    const update=vi.spyOn(orgApi,'updateStaff').mockResolvedValue({...person,name:'新小王'} as never);
    page();fireEvent.click(await screen.findByRole('button',{name:'运营专员'}));fireEvent.click(await screen.findByRole('button',{name:'编辑员工 小王'}));
    await screen.findByLabelText('姓名');const dlg=screen.getByRole('dialog',{name:'编辑员工'});
    expect((within(dlg).getByLabelText('时薪（元/小时）') as HTMLInputElement).value).toBe('75');
    fireEvent.change(within(dlg).getByLabelText('姓名'),{target:{value:'新小王'}});
    vi.mocked(orgApi.positionProfile).mockResolvedValue({...profile,staff:[{...profile.staff[0],name:'新小王'}]} as never);
    fireEvent.click(within(dlg).getByRole('button',{name:'保存'}));
    await waitFor(()=>expect(update).toHaveBeenCalledWith(21,expect.objectContaining({name:'新小王',positionId:11,extraPositionIds:[13],managerId:22,hourlyRate:7500})));
    expect(await screen.findByRole('button',{name:'编辑员工 新小王'})).toBeTruthy();
  });

  it('只有岗位编辑权限不能编辑员工资料',async()=>{
    auth.user.permissions={isCompanyAdmin:false,allow:['org.structure.edit'] as never,deny:[]};
    vi.spyOn(orgApi,'positionProfile').mockResolvedValue({position:{...pos(11,'运营专员',2),departmentName:'运营部'},staff:[{id:21,name:'小王',status:'active',concurrent:false}],duties:[],permissions:[],logs:[]} as never);
    page();fireEvent.click(await screen.findByRole('button',{name:'运营专员'}));await screen.findByText(/在岗人员（/);
    expect(screen.queryByRole('button',{name:'编辑员工 小王'})).toBeNull();
  });

});
