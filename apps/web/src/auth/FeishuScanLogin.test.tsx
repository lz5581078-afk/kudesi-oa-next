import { StrictMode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FeishuLogin } from './FeishuLogin';
import { api } from '../api/client';
import { feishuApi } from './feishuApi';
import { pendingLiveRoom } from './liveRoomIntent';
vi.mock('../api/client', () => ({ api: vi.fn(), tokenStore: { set: vi.fn() } }));
const target = '/features/live-desk?company=8&token=' + 'a'.repeat(43);
beforeEach(() => {
  sessionStorage.clear(); history.replaceState(null,'',target);
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Lark/7.0');
  vi.spyOn(feishuApi,'redirect').mockImplementation(() => {});
  vi.mocked(api).mockImplementation(async (path) => (path==='/auth/feishu/companies' ? [{id:1,name:'另一公司'},{id:8,name:'扫码公司'}] : {authorizationUrl:'https://accounts.feishu.cn/authorized'}) as never);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.mocked(api).mockReset(); history.replaceState(null,'','/'); sessionStorage.clear(); });
it('飞书扫描公司通用码自动选择码所属公司并只发起一次授权，保留原码回跳', async () => {
  render(<StrictMode><FeishuLogin /></StrictMode>);
  await waitFor(() => expect(feishuApi.redirect).toHaveBeenCalledWith('https://accounts.feishu.cn/authorized'));
  const calls=vi.mocked(api).mock.calls.filter(([path])=>path==='/auth/feishu/start');
  expect(calls).toEqual([['/auth/feishu/start',{body:{companyId:8}}]]);
  expect(pendingLiveRoom()).toBe(target);
});
it.each(['/login','/features/live-desk?company=999&token='+'a'.repeat(43),'/features/live-desk?company=8&token=invalid','/login?error=cancelled'])('普通登录、错误企业及坏码不自动授权：%s', async (url) => {
  history.replaceState(null,'',url); render(<FeishuLogin />);
  await screen.findByRole('button',{name:'飞书授权登录'});
  expect(api).not.toHaveBeenCalledWith('/auth/feishu/start',expect.anything()); expect(feishuApi.redirect).not.toHaveBeenCalled();
});
it('外部浏览器扫描保留手动登录入口，不误触发飞书授权', async () => {
  vi.spyOn(navigator,'userAgent','get').mockReturnValue('Mozilla/5.0 Chrome'); render(<FeishuLogin />);
  await screen.findByRole('button',{name:'飞书授权登录'}); expect(feishuApi.redirect).not.toHaveBeenCalled();
});
it('自动授权失败展示原因并停止，不重复跳转', async () => {
  vi.mocked(api).mockImplementation(async path => {
    if(path==='/auth/feishu/companies')return [{id:8,name:'扫码公司'}] as never;
    throw Error('飞书暂不可用，请手动登录');
  });
  render(<FeishuLogin />); expect(await screen.findByRole('alert')).toHaveProperty('textContent','飞书暂不可用，请手动登录');
  expect(vi.mocked(api).mock.calls.filter(([p])=>p==='/auth/feishu/start')).toHaveLength(1);
});

it('离开扫码登录页后，迟到的授权响应不会强行跳转', async () => {
  let finish!: (v: unknown) => void;
  vi.mocked(api).mockImplementation(path => path==='/auth/feishu/companies' ? Promise.resolve([{id:8,name:'扫码公司'}]) as never : new Promise(r=>{ finish=r; }) as never);
  const view=render(<FeishuLogin />);
  await waitFor(()=>expect(api).toHaveBeenCalledWith('/auth/feishu/start',{body:{companyId:8}}));
  view.unmount(); finish({authorizationUrl:'https://accounts.feishu.cn/authorized'});
  await Promise.resolve(); expect(feishuApi.redirect).not.toHaveBeenCalled();
});
