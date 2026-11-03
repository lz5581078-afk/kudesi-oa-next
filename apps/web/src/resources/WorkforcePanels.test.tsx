import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getResourceDef } from '@kudesi/shared';

const auth = { user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } };
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }));
const apiMock = vi.fn();
vi.mock('../api/client', async (orig) => ({ ...(await orig<typeof import('../api/client')>()), api: (...a: unknown[]) => apiMock(...a) }));
const addStaff = vi.fn();
vi.mock('../pages/org/orgApi', async (orig) => {
  const mod = await orig<typeof import('../pages/org/orgApi')>();
  return { ...mod, orgApi: { ...mod.orgApi, departments: async () => [{ id: 1, name: '仓库', sortOrder: 0, status: 'active', children: [] }], positions: async () => [{ id: 2, name: '打包' }], addStaff: (...a: unknown[]) => addStaff(...a) } };
});
import { AddAccountDialog, UnfiledBanner, WorkforceLoginDialog, WorkforceAccountNote } from './WorkforcePanels';
import { KeyFacts } from './KeyFacts';

beforeEach(() => { apiMock.mockReset(); addStaff.mockReset(); });
afterEach(cleanup);

describe('兼职与临时工专用面板', () => {
  it('未建档提醒：列出人，点“建档”带出这个人', async () => {
    apiMock.mockResolvedValue([{ id: 7, name: '小李', account: 'li', employmentType: 'temp' }]);
    const onFile = vi.fn();
    render(<UnfiledBanner canCreate onFile={onFile} />);
    expect(await screen.findByText(/小李（临时工）/)).toBeTruthy();
    fireEvent.click(screen.getByText('建档'));
    expect(onFile).toHaveBeenCalledWith(7);
    expect(apiMock).toHaveBeenCalledWith('/workforce/unfiled');
  });

  it('没有未建档的人，或没有建档权限：不出现提醒/按钮', async () => {
    apiMock.mockResolvedValue([]);
    const { container } = render(<UnfiledBanner canCreate onFile={() => undefined} />);
    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    expect(container.textContent).toBe('');
    cleanup();
    apiMock.mockResolvedValue([{ id: 1, name: '甲', account: 'a', employmentType: 'part_time' }]);
    render(<UnfiledBanner canCreate={false} onFile={() => undefined} />);
    await screen.findByText(/甲（兼职）/);
    expect(screen.queryByText('建档')).toBeNull();
  });

  it('新增账号并建档：创建后只显示一次临时密码，确认后带着员工进入建档', async () => {
    apiMock.mockResolvedValue({ staff: { id: 11, account: 'zhang' }, initialPassword: 'Tmp-pass-1' });
    const onCreated = vi.fn();
    render(<AddAccountDialog onClose={() => undefined} onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText('登录账号'), { target: { value: 'zhang' } });
    fireEvent.change(screen.getByLabelText('姓名'), { target: { value: '小张' } });
    fireEvent.change(screen.getByLabelText('用工类型'), { target: { value: 'temp' } });
    fireEvent.click(screen.getByText('创建并继续建档'));
    expect(await screen.findByText('Tmp-pass-1')).toBeTruthy();
    expect(apiMock).toHaveBeenCalledWith('/workforce/accounts',{method:'POST',body:expect.objectContaining({account:'zhang',name:'小张',employmentType:'temp'})});
    fireEvent.click(screen.getByText('我已记下，继续建档'));
    expect(onCreated).toHaveBeenCalledWith(11);
  });

  it('账号和姓名没填：不提交', async () => {
    render(<AddAccountDialog onClose={() => undefined} onCreated={() => undefined} />);
    fireEvent.click(screen.getByText('创建并继续建档'));
    expect(await screen.findByText('请填写登录账号和姓名')).toBeTruthy();
    expect(addStaff).not.toHaveBeenCalled();
  });

  it('详情关键信息：用工类型、合作状态、岗位、期限和计薪', () => {
    const def = getResourceDef('workforce')!;
    const rec = { id: 1, type: 'workforce', title: '小李', status: 'active', statusReason: null, data: { employmentType: 'temp', cooperation: 'working', positionName: '打包', contractStartDate: '2026-10-01', contractEndDate: '2026-11-01', payMethod: 'daily', payRate: 20000 }, secretConfigured: {}, refLabels: {}, files: {}, archived: null, createdAt: '', updatedAt: '' };
    render(<MemoryRouter><KeyFacts def={def} record={rec as never} /></MemoryRouter>);
    const text = screen.getByLabelText('关键信息').textContent ?? '';
    for (const s of ['临时工', '合作中', '打包', '2026-10-01', '2026-11-01', '200.00 元/天']) expect(text).toContain(s);
    cleanup();
    // 没有薪资权限：服务端不返回计薪，关键信息里不出现“计薪”
    const masked = { ...rec, data: { ...rec.data, payMethod: undefined, payRate: undefined } };
    render(<MemoryRouter><KeyFacts def={def} record={masked as never} /></MemoryRouter>);
    expect(screen.getByLabelText('关键信息').textContent).not.toContain('计薪');
  });
});

describe('兼职临时工账号密码设置',()=>{
  it('新增时可手动设置密码，提交给兼职专用接口',async()=>{
    apiMock.mockResolvedValue({staff:{id:21,account:'part21'},initialPassword:'New-pass-21'});
    render(<AddAccountDialog onClose={()=>{}} onCreated={()=>{}}/>);
    fireEvent.change(screen.getByLabelText('登录账号'),{target:{value:'part21'}});fireEvent.change(screen.getByLabelText('姓名'),{target:{value:'兼职甲'}});
    fireEvent.change(screen.getByLabelText('登录密码'),{target:{value:'New-pass-21'}});fireEvent.change(screen.getByLabelText('确认密码'),{target:{value:'New-pass-21'}});
    fireEvent.click(screen.getByText('创建并继续建档'));await screen.findByText('New-pass-21');
    expect(apiMock).toHaveBeenCalledWith('/workforce/accounts',expect.objectContaining({body:expect.objectContaining({password:'New-pass-21',employmentType:'part_time'})}));
  });
  it('修改账号时密码留空不提交密码；重新设置密码须确认且成功后关闭',async()=>{
    apiMock.mockResolvedValue({ok:true});const saved=vi.fn();render(<WorkforceLoginDialog recordId={9} currentAccount="old" canPassword onClose={()=>{}} onSaved={saved}/>);
    fireEvent.change(screen.getByLabelText('登录账号'),{target:{value:'new_login'}});fireEvent.click(screen.getByText('保存登录设置'));
    await waitFor(()=>expect(saved).toHaveBeenCalled());expect(apiMock).toHaveBeenLastCalledWith('/workforce/9/login',{method:'PUT',body:{account:'new_login'}});
    saved.mockClear();apiMock.mockClear();fireEvent.change(screen.getByLabelText('新密码'),{target:{value:'Custom-987'}});fireEvent.click(screen.getByText('保存登录设置'));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent','两次密码不一致');expect(apiMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('确认新密码'),{target:{value:'Custom-987'}});fireEvent.click(screen.getByText('保存登录设置'));await waitFor(()=>expect(saved).toHaveBeenCalled());
    expect(apiMock).toHaveBeenLastCalledWith('/workforce/9/login',{method:'PUT',body:{account:'new_login',password:'Custom-987'}});
  });
  it('详情可直接设置登录，已归档档案不提供设置入口',()=>{
    const view=render(<WorkforceAccountNote recordId={9} account="old" onChanged={()=>{}}/>);fireEvent.click(screen.getByText('设置登录账号和密码'));expect(screen.getByRole('dialog')).toBeTruthy();
    view.unmount();render(<WorkforceAccountNote recordId={9} account="old" onChanged={()=>{}} editable={false}/>);expect(screen.queryByRole('button')).toBeNull();
  });
});
