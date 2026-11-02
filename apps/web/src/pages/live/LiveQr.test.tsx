import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { LiveQr } from './LiveQr';
import { liveApi } from './liveApi';
import { liveRoomTarget,rememberLiveRoom,consumeLiveRoom,clearLiveRoom } from '../../auth/liveRoomIntent';
vi.mock('../../auth/AuthContext',()=>({useAuth:()=>({user:{id:1,companyId:8}})}));
vi.mock('./liveApi',()=>({liveApi:{checkinQr:vi.fn(),generateCheckinQr:vi.fn()}}));
const a=vi.mocked(liveApi),first='a'.repeat(43),second='b'.repeat(43);
beforeEach(()=>{vi.resetAllMocks();a.checkinQr.mockResolvedValue({token:first,version:1});a.generateCheckinQr.mockResolvedValue({token:second,version:2});});
afterEach(()=>{cleanup();clearLiveRoom();history.replaceState(null,'','/');});
describe('公司通用上下播长期二维码',()=>{
 it('查看与重新打开保持同一个码，不隐式重新生成',async()=>{
  const view=render(<LiveQr/>);const link=await screen.findByRole('link',{name:'通用上下播入口'});
  expect(link.getAttribute('href')).toContain(`company=8&token=${first}`);expect(link.getAttribute('href')).not.toContain('room=');expect(screen.getAllByRole('img')).toHaveLength(1);expect(a.generateCheckinQr).not.toHaveBeenCalled();
  view.unmount();render(<LiveQr/>);expect((await screen.findByRole('link')).getAttribute('href')).toContain(first);
 });
 it('首次生成及换码确认/取消，新码替换打印和扫码入口',async()=>{
  a.checkinQr.mockResolvedValue({token:null,version:0});a.generateCheckinQr.mockResolvedValueOnce({token:first,version:1});
  render(<LiveQr/>);fireEvent.click(await screen.findByRole('button',{name:'生成上下播二维码'}));await screen.findByRole('link');expect(a.generateCheckinQr).toHaveBeenCalledWith(0);
  fireEvent.click(screen.getByRole('button',{name:'重新生成二维码'}));fireEvent.click(screen.getByRole('button',{name:'取消'}));expect(a.generateCheckinQr).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button',{name:'重新生成二维码'}));fireEvent.click(screen.getByRole('button',{name:'确认重新生成'}));
  await waitFor(()=>expect(screen.getByRole('link').getAttribute('href')).toContain(second));expect(a.generateCheckinQr).toHaveBeenLastCalledWith(1);
 });
 it('网络响应不明时回读当前码，保留错误并显示服务器已生效的新码',async()=>{
  render(<LiveQr/>);await screen.findByRole('link');a.checkinQr.mockResolvedValue({token:second,version:2});a.generateCheckinQr.mockRejectedValue(new Error('网络中断'));
  fireEvent.click(screen.getByRole('button',{name:'重新生成二维码'}));fireEvent.click(screen.getByRole('button',{name:'确认重新生成'}));
  expect((await screen.findByRole('alert')).textContent).toContain('网络中断');await waitFor(()=>expect(screen.getByRole('link').getAttribute('href')).toContain(second));
 });
 it('首次读取失败可以重试，不会误生成新码',async()=>{
  a.checkinQr.mockRejectedValueOnce(new Error('读取失败'));render(<LiveQr/>);await screen.findByRole('alert');fireEvent.click(screen.getByRole('button',{name:'重新读取二维码'}));await screen.findByRole('link');expect(a.generateCheckinQr).not.toHaveBeenCalled();
 });
 it('登录和飞书绑定回跳保留同一码，拒绝外站和非法令牌',()=>{
  const target=`/features/live-desk?company=8&token=${first}`;history.replaceState(null,'',target);rememberLiveRoom();history.replaceState(null,'','/feishu-bind');expect(consumeLiveRoom()).toBe(target);
  expect(liveRoomTarget(`https://evil.example${target}`)).toBeNull();expect(liveRoomTarget('/features/live-desk?company=8&token=wrong')).toBeNull();
 });
});
