import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StaffFeishuUnbindDialog } from './StaffFeishuUnbind';
import { orgApi, type StaffDto } from './orgApi';
import { ApiError } from '../../api/client';
const {refresh}=vi.hoisted(()=>({refresh:vi.fn(async()=>{})}));
vi.mock('../../auth/AuthContext',()=>({useAuth:()=>({refresh})}));
const staff={id:42,name:'员工示例',account:'staff42'} as StaffDto;
const plan={userId:42,name:staff.name,account:staff.account,bindingCount:1,includesSelf:false,fingerprint:'a'.repeat(64)};
afterEach(()=>{cleanup();vi.restoreAllMocks();refresh.mockClear();});
describe('单人解绑飞书',()=>{
  it('预览明确显示单个目标，确认后才执行，成功刷新人员状态',async()=>{
    vi.spyOn(orgApi,'staffFeishuUnbindPreview').mockResolvedValue(plan);
    const unbind=vi.spyOn(orgApi,'staffFeishuUnbind').mockResolvedValue({userId:42,bindingCount:1,includesSelf:false}),onDone=vi.fn(async()=>{});
    render(<StaffFeishuUnbindDialog staff={staff} onClose={vi.fn()} onDone={onDone}/>);
    await screen.findByText('员工示例',{selector:'strong'});expect(screen.getByText(/OA 账号：staff42/)).toBeTruthy();expect(unbind).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'确认解绑此员工'}));await screen.findByText('已解绑 员工示例 的飞书账号。');
    expect(unbind).toHaveBeenCalledTimes(1);expect(unbind).toHaveBeenCalledWith(42,plan.fingerprint);expect(refresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'完成并刷新'}));expect(onDone).toHaveBeenCalledOnce();
  });
  it('取消不执行，未绑定员工不给确认入口',async()=>{
    vi.spyOn(orgApi,'staffFeishuUnbindPreview').mockResolvedValue({...plan,bindingCount:0});const close=vi.fn(),unbind=vi.spyOn(orgApi,'staffFeishuUnbind');
    render(<StaffFeishuUnbindDialog staff={staff} onClose={close} onDone={vi.fn()}/>);await screen.findByText(/无需解绑/);
    expect(screen.queryByRole('button',{name:'确认解绑此员工'})).toBeNull();fireEvent.click(screen.getByRole('button',{name:'取消'}));expect(close).toHaveBeenCalledOnce();expect(unbind).not.toHaveBeenCalled();
  });
  it('范围变化或未知响应后必须重新读取，防止用旧确认覆盖新绑定',async()=>{
    const preview=vi.spyOn(orgApi,'staffFeishuUnbindPreview').mockResolvedValue(plan);
    const unbind=vi.spyOn(orgApi,'staffFeishuUnbind').mockRejectedValueOnce(new ApiError(409,'绑定情况已变化')).mockRejectedValueOnce(new ApiError(503,'结果未知'));
    render(<StaffFeishuUnbindDialog staff={staff} onClose={vi.fn()} onDone={vi.fn()}/>);
    fireEvent.click(await screen.findByRole('button',{name:'确认解绑此员工'}));await screen.findByText('绑定情况已变化');expect(screen.queryByRole('button',{name:'确认解绑此员工'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'刷新绑定状态'}));fireEvent.click(await screen.findByRole('button',{name:'确认解绑此员工'}));await screen.findByText('结果未知');
    expect(screen.queryByRole('button',{name:'确认解绑此员工'})).toBeNull();expect(preview).toHaveBeenCalledTimes(2);expect(unbind).toHaveBeenCalledTimes(2);
  });
  it('解绑自己明确提示，完成后刷新本人认证状态',async()=>{
    vi.spyOn(orgApi,'staffFeishuUnbindPreview').mockResolvedValue({...plan,includesSelf:true});vi.spyOn(orgApi,'staffFeishuUnbind').mockResolvedValue({userId:42,bindingCount:1,includesSelf:true});
    render(<StaffFeishuUnbindDialog staff={staff} onClose={vi.fn()} onDone={vi.fn()}/>);await screen.findByText(/这是你当前使用的账号/);
    fireEvent.click(screen.getByRole('button',{name:'确认解绑此员工'}));fireEvent.click(await screen.findByRole('button',{name:'完成并刷新'}));expect(refresh).toHaveBeenCalledOnce();
  });
});
