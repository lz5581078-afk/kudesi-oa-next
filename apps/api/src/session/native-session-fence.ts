import { CanActivate, ConflictException, ExecutionContext, Injectable } from '@nestjs/common';

/** During an explicit legacy cutover, the previous engine cannot keep accepting
 * login/remote mutations. Financial documents and their voucher APIs stay intact. */
@Injectable()
export class NativeSessionFence implements CanActivate {
  canActivate(context: ExecutionContext) {
    if (process.env.KUDESI_SESSION_ENGINE !== 'legacy') return true;
    const req = context.switchToHttp().getRequest();
    const path = String(req.originalUrl ?? req.url).split('?')[0];
    if (/^\/api\/session\/(?:vouchers(?:\/|$)|docs\/)/.test(path)) return true;
    throw new ConflictException('店铺登录已切换到兼容助手，请使用当前OA页面入口；原资料和本机登录态仍保留');
  }
}
