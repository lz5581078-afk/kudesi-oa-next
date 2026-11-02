import 'reflect-metadata';
import { FeishuNoticeService } from './feishu-notice.service';
describe('飞书通知独立发送任务',()=>{
  const saved={NODE_ENV:process.env.NODE_ENV,OUTBOX_WORKER:process.env.OUTBOX_WORKER,FEISHU_NOTICE_WORKER:process.env.FEISHU_NOTICE_WORKER};
  let svc:FeishuNoticeService;
  beforeEach(()=>{jest.useFakeTimers();process.env.NODE_ENV='production';process.env.OUTBOX_WORKER='off';delete process.env.FEISHU_NOTICE_WORKER;svc=new FeishuNoticeService({} as never);jest.spyOn(svc,'processAll').mockResolvedValue();});
  afterEach(()=>{svc.onModuleDestroy();jest.useRealTimers();jest.restoreAllMocks();for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  it('可单独启用飞书，不开启其他出站任务，销毁后停止',()=>{process.env.FEISHU_NOTICE_WORKER='on';svc.onModuleInit();jest.advanceTimersByTime(30000);expect(svc.processAll).toHaveBeenCalledTimes(1);expect(process.env.OUTBOX_WORKER).toBe('off');svc.onModuleDestroy();jest.advanceTimersByTime(60000);expect(svc.processAll).toHaveBeenCalledTimes(1);});
  it('不设置独立开关时保留原暂停行为',()=>{svc.onModuleInit();jest.advanceTimersByTime(60000);expect(svc.processAll).not.toHaveBeenCalled();});
  it('不设置独立开关时保留原启用行为',()=>{delete process.env.OUTBOX_WORKER;svc.onModuleInit();jest.advanceTimersByTime(30000);expect(svc.processAll).toHaveBeenCalledTimes(1);});
  it.each(['off','test'])('显式关闭或测试环境不发送：%s',mode=>{process.env.OUTBOX_WORKER='on';process.env.FEISHU_NOTICE_WORKER=mode==='test'?'on':'off';if(mode==='test')process.env.NODE_ENV='test';svc.onModuleInit();jest.advanceTimersByTime(60000);expect(svc.processAll).not.toHaveBeenCalled();});
});
