import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import { NotificationsTab } from './NotificationsTab';
vi.mock('../../api/client',()=>({api:vi.fn()}));
const call=vi.mocked(api);
const data={enabled:true,digestEnabled:false,digestHour:9,businessRecipients:[],systemRecipients:[2],configured:false,people:[{id:1,name:'直播负责人',business:true,system:false},{id:2,name:'系统负责人',business:false,system:true}]};
afterEach(()=>{cleanup();vi.resetAllMocks();});
describe('直播通知设置',()=>{
  it('日报必须选收件人；按权限分组选择并保存时间，不提交额外返回字段',async()=>{
    call.mockResolvedValueOnce(data);render(<NotificationsTab/>);await screen.findByText('直播负责人');
    fireEvent.click(screen.getByLabelText('开启经营日报'));
    expect((screen.getByRole('button',{name:'保存通知设置'}) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('直播负责人'));
    fireEvent.change(screen.getByLabelText('经营日报发送时间'),{target:{value:'10'}});
    call.mockResolvedValueOnce({...data,configured:true,digestEnabled:true,businessRecipients:[1],digestHour:10});
    fireEvent.click(screen.getByRole('button',{name:'保存通知设置'}));
    await screen.findByRole('status');
    expect(call).toHaveBeenLastCalledWith('/live/notification-settings',{method:'PUT',body:{enabled:true,digestEnabled:true,digestHour:10,businessRecipients:[1],systemRecipients:[2]}});
  });
  it('保存失败保留选择并显示错误，可再次保存',async()=>{
    call.mockResolvedValueOnce(data);render(<NotificationsTab/>);await screen.findByText('直播负责人');
    fireEvent.click(screen.getByLabelText('直播负责人'));call.mockRejectedValueOnce(new Error('接口失败'));
    fireEvent.click(screen.getByRole('button',{name:'保存通知设置'}));await waitFor(()=>expect(screen.getByRole('alert').textContent).toBe('接口失败'));
    expect((screen.getByLabelText('直播负责人') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('button',{name:'保存通知设置'}) as HTMLButtonElement).disabled).toBe(false);
  });
});
