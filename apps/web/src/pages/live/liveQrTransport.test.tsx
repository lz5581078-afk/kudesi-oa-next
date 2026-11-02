import { afterEach,describe,expect,it,vi } from 'vitest';
import { api } from '../../api/client';
import { liveApi } from './liveApi';
vi.mock('../../api/client',()=>({api:vi.fn().mockResolvedValue({})}));
afterEach(()=>{vi.clearAllMocks();history.replaceState(null,'','/');});
describe('扫码提交保留当前二维码凭据',()=>{
 it('读取上下播状态及两种提交都携带同一码',async()=>{
  const token='a'.repeat(43);history.replaceState(null,'',`/features/live-desk?room=10&company=8&token=${token}`);
  await liveApi.checkinContext(10,token);await liveApi.start({roomId:10});await liveApi.report(7,{endAt:'2026-11-02 10:00:00',salesCents:0});
  expect(api).toHaveBeenNthCalledWith(1,`/live/checkin-context?roomId=10&token=${token}`);
  expect(api).toHaveBeenNthCalledWith(2,`/live/sessions?qrRoom=10&qrToken=${token}`,expect.objectContaining({method:'POST'}));
  expect(api).toHaveBeenNthCalledWith(3,`/live/sessions/7/report?qrRoom=10&qrToken=${token}`,expect.objectContaining({method:'POST'}));
 });
 it('普通岗位工作台无需二维码',async()=>{
  history.replaceState(null,'','/workspace/desk/1');await liveApi.start({roomId:10});expect(api).toHaveBeenCalledWith('/live/sessions',expect.objectContaining({method:'POST'}));
 });
});
