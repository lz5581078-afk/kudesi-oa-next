import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StaffPage } from './StaffPage';
import { StaffTestNoticeDialog } from './StaffFeishu';
import { orgApi, type StaffDto, type StaffTestNotice } from './orgApi';
import { resourceApi } from '../../resources/api';
import { ApiError } from '../../api/client';
vi.mock('../../auth/AuthContext',()=>({useAuth:()=>({user:{permissions:{isCompanyAdmin:true,allow:[],deny:[]}}})}));
const person=(id:number,name:string,type='regular')=>({id,name,account:String(id),departmentId:null,positionId:null,positionName:null,extraPositionIds:[],isCompanyAdmin:false,status:'active',lastLoginAt:null,managerId:null,title:null,employmentType:type}) as StaffDto;
const regular=person(1,'正式示例'),part=person(2,'兼职示例','part_time');
const bound={userId:2,bound:true,boundAt:null,notificationsEnabled:true,canTest:true,testBlockedReason:null};
const job=(status:StaffTestNotice['status']='pending')=>({jobId:7,userId:2,status,message:status==='done'?'飞书接口已确认发送成功':'测试通知已加入队列',createdAt:'now',doneAt:null});
beforeEach(()=>{
  vi.spyOn(orgApi,'staff').mockResolvedValue([regular,part]);vi.spyOn(orgApi,'departments').mockResolvedValue([]);vi.spyOn(orgApi,'positions').mockResolvedValue([]);vi.spyOn(orgApi,'catalog').mockResolvedValue([]);
  vi.spyOn(orgApi,'staffFeishu').mockResolvedValue({rows:[{...bound,userId:1,bound:false,canTest:false,testBlockedReason:'尚未绑定本人飞书'},bound]});
  vi.spyOn(resourceApi,'list').mockResolvedValue({items:[]} as never);
});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
describe('人员绑定状态与测试通知',()=>{
  it('正式和兼职统一显示，可按用工和绑定筛选，未绑定不伪装成已绑定',async()=>{
    render(<StaffPage/>);await screen.findByText('兼职示例');await waitFor(()=>expect(within(screen.getByText('兼职示例').closest('tr')!).getByText('已绑定')).toBeTruthy());
    expect(within(screen.getByText('兼职示例').closest('tr')!).getByText('已绑定')).toBeTruthy();
    expect(within(screen.getByText('正式示例').closest('tr')!).getByText('未绑定')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('用工类型'),{target:{value:'part_time'}});expect(screen.queryByText('正式示例')).toBeNull();
    fireEvent.change(screen.getByLabelText('飞书绑定状态'),{target:{value:'unbound'}});expect(screen.queryByText('兼职示例')).toBeNull();
  });
  it('状态读取失败显示未知且可刷新，不把加载失败当未绑定',async()=>{
    vi.mocked(orgApi.staffFeishu).mockRejectedValueOnce(new Error('网络错误'));
    render(<StaffPage/>);await screen.findByText('兼职示例');await screen.findByText(/读取失败/);
    expect(screen.getAllByRole('row').some(r=>r.textContent?.includes('未绑定'))).toBe(false);expect(screen.getAllByText('未读取')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button',{name:'刷新绑定状态'}));await waitFor(()=>expect(within(screen.getByText('兼职示例').closest('tr')!).getByText('已绑定')).toBeTruthy());
  });
  it('先展示接收人和固定文本，确认后发一次；入队与发送成功分开显示',async()=>{
    const send=vi.spyOn(orgApi,'staffTestNotice').mockResolvedValue(job());vi.spyOn(orgApi,'staffTestNoticeStatus').mockResolvedValue(job('done'));
    render(<StaffTestNoticeDialog staff={part} status={bound} onClose={vi.fn()}/>);
    fireEvent.change(screen.getByLabelText('消息标题'),{target:{value:'自定义标题'}});fireEvent.change(screen.getByLabelText('消息正文'),{target:{value:'第一行\n第二行'}});
    expect(send).not.toHaveBeenCalled();expect(screen.getByText(/发送飞书通知给 兼职示例/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'预览消息'}));fireEvent.click(screen.getByRole('button',{name:'确认发送'}));await screen.findByText(/已加入队列/);
    expect(send).toHaveBeenCalledTimes(1);expect(send).toHaveBeenCalledWith(2,expect.any(String),{title:'自定义标题',body:'第一行\n第二行'});expect(screen.queryByText(/确认发送成功/)).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'刷新发送状态'}));await screen.findByText('飞书接口已确认发送成功');
  });
  it('未绑定时解释原因并禁止发送；提交结果未知时重试复用同一请求编号',async()=>{
    const send=vi.spyOn(orgApi,'staffTestNotice').mockRejectedValueOnce(new ApiError(503,'连接中断')).mockResolvedValueOnce(job());
    const view=render(<StaffTestNoticeDialog staff={part} status={{...bound,canTest:false,testBlockedReason:'公司通知开关已关闭'}} onClose={vi.fn()}/>);
    expect((screen.getByRole('button',{name:'预览消息'}) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<StaffTestNoticeDialog staff={part} status={bound} onClose={vi.fn()}/>);
    fireEvent.click(screen.getByRole('button',{name:'预览消息'}));fireEvent.click(screen.getByRole('button',{name:'确认发送'}));await screen.findByText('连接中断');
    fireEvent.click(screen.getByRole('button',{name:'重试确认发送'}));await screen.findByText(/已加入队列/);
    await waitFor(()=>expect(send).toHaveBeenCalledTimes(2));expect(send.mock.calls[0][1]).toBe(send.mock.calls[1][1]);
  });
});
