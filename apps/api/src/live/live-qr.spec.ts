import { GoneException } from '@nestjs/common';
import { LiveController } from './live.controller';
import { AuthUser } from '../common/auth.decorators';

describe('扫码入口及上下播提交必须重新校验二维码',()=>{
 const user={id:1,companyId:2} as AuthUser;
 const assert=jest.fn(),sessions={checkinContext:jest.fn(),start:jest.fn(),report:jest.fn()};
 const controller=new LiveController(null as never,null as never,null as never,null as never,{assert} as never,null as never,sessions as never,null as never,null as never);
 beforeEach(()=>{jest.resetAllMocks();assert.mockResolvedValue(undefined);});
 it('通用扫码缺少令牌也不能读取场次',async()=>{
  assert.mockRejectedValue(new GoneException('二维码已失效'));
  await expect(controller.checkinContext(user,undefined,undefined,'1')).rejects.toThrow(/失效/);expect(sessions.checkinContext).not.toHaveBeenCalled();
 });
 it('已打开页面在换码后上下播都不能再提交',async()=>{
  assert.mockRejectedValue(new GoneException('二维码已失效'));
  await expect(controller.start(user,{} as never,'1','old')).rejects.toThrow(/失效/);
  await expect(controller.report(user,7,{} as never,'1','old')).rejects.toThrow(/失效/);
  expect(sessions.start).not.toHaveBeenCalled();expect(sessions.report).not.toHaveBeenCalled();
 });
 it('普通本人工作台不依赖二维码；新码上下播仍走原有业务权限',async()=>{
  await controller.checkinContext(user);await controller.start(user,{} as never);expect(assert).not.toHaveBeenCalled();
  await controller.start(user,{} as never,'1','new');await controller.report(user,7,{} as never,'1','new');
  expect(assert).toHaveBeenCalledWith(user,'new');expect(sessions.start).toHaveBeenLastCalledWith(user,{actualCheckin:true,startAt:null});expect(sessions.report).toHaveBeenCalledWith(user,7,{});
 });
});
