import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChangePasswordPage } from './ChangePasswordPage';
import { feishuApi } from '../auth/feishuApi';
const {refresh}=vi.hoisted(()=>({refresh:vi.fn()}));
vi.mock('../auth/AuthContext',()=>({useAuth:()=>({user:{id:1,companyId:2,feishuBindingPending:true},refresh})}));
beforeEach(()=>{
 refresh.mockResolvedValue(undefined);
 vi.spyOn(feishuApi,'status').mockResolvedValue({bound:false,configured:true,allNotificationsEnabled:false,notificationsEnabled:false});
 vi.spyOn(feishuApi,'start').mockResolvedValue({authorizationUrl:'https://accounts.feishu.cn/test-only'});
 vi.spyOn(feishuApi,'redirect').mockImplementation(()=>{});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('修改密码页显示独立绑定卡，未填密码也能发起绑定',async()=>{
 render(<MemoryRouter><ChangePasswordPage/></MemoryRouter>);
 expect(screen.getByRole('heading',{name:'修改密码'})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'绑定我的飞书'}));
 await waitFor(()=>expect(feishuApi.redirect).toHaveBeenCalledWith('https://accounts.feishu.cn/test-only'));
 expect((screen.getByLabelText('当前密码') as HTMLInputElement).value).toBe('');
});
it('状态接口异常时保留入口，绑定启动接口仍可独立重试',async()=>{
 vi.mocked(feishuApi.status).mockRejectedValue(new Error('test offline'));
 render(<MemoryRouter><ChangePasswordPage/></MemoryRouter>);
 await screen.findByRole('alert');fireEvent.click(screen.getByRole('button',{name:'绑定我的飞书'}));
 await waitFor(()=>expect(feishuApi.start).toHaveBeenCalled());
});
it('已有绑定展示状态，不要求重复绑定',async()=>{
 vi.mocked(feishuApi.status).mockResolvedValue({bound:true,configured:true,allNotificationsEnabled:true,notificationsEnabled:true});
 render(<MemoryRouter><ChangePasswordPage/></MemoryRouter>);
 await screen.findByText('已绑定');expect(screen.queryByRole('button',{name:'绑定我的飞书'})).toBeNull();
});
