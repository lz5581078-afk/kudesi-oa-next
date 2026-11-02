import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StaffFeishuResetDialog } from './StaffFeishuReset';
import { orgApi } from './orgApi';
import { ApiError } from '../../api/client';
const {refresh}=vi.hoisted(()=>({refresh:vi.fn(async()=>{})}));
vi.mock('../../auth/AuthContext',()=>({useAuth:()=>({refresh})}));
const plan={companyName:'本公司',bindingCount:3,employeeCount:2,includesSelf:true,fingerprint:'a'.repeat(64),employees:[{id:1,name:'管理员示例',status:'active',employmentType:'regular'},{id:2,name:'兼职示例',status:'active',employmentType:'part_time'}]};
afterEach(()=>{cleanup();vi.restoreAllMocks();refresh.mockClear();});
describe('取消全员飞书关联',()=>{
  it('先显示公司、人数与本人影响，勾选后才能执行，成功明确显示结果',async()=>{
    vi.spyOn(orgApi,'staffFeishuResetPreview').mockResolvedValue(plan);const reset=vi.spyOn(orgApi,'staffFeishuReset').mockResolvedValue({bindingCount:3,employeeCount:2,includesSelf:true,remainingBindings:0});
    render(<StaffFeishuResetDialog onClose={vi.fn()}/>);await screen.findByText('本公司');
    const button=screen.getByRole('button',{name:'确认取消全员关联'}) as HTMLButtonElement;expect(button.disabled).toBe(true);expect(reset).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(button);
    await screen.findByText(/已取消 2 人的 3 条飞书关联/);expect(reset).toHaveBeenCalledOnce();expect(reset).toHaveBeenCalledWith(plan.fingerprint);expect(refresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'刷新登录状态并重新绑定'}));expect(refresh).toHaveBeenCalledOnce();
  });
  it('范围变化必须重新预览，不能盲重试；未知结果引导核对登录状态',async()=>{
    vi.spyOn(orgApi,'staffFeishuResetPreview').mockResolvedValue(plan);const reset=vi.spyOn(orgApi,'staffFeishuReset').mockRejectedValueOnce(new ApiError(409,'绑定情况已变化')).mockRejectedValueOnce(new ApiError(503,'结果未知'));
    render(<StaffFeishuResetDialog onClose={vi.fn()}/>);await screen.findByText('本公司');fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'确认取消全员关联'}));
    await screen.findByText('绑定情况已变化');expect(screen.queryByRole('button',{name:'确认取消全员关联'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'刷新预览'}));await screen.findByText('本公司');fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'确认取消全员关联'}));
    await screen.findByText('结果未知');expect(screen.queryByRole('button',{name:'确认取消全员关联'})).toBeNull();expect(reset).toHaveBeenCalledTimes(2);
  });
});
