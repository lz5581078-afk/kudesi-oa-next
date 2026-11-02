import 'reflect-metadata';
import { AssistantService } from './assistant.service';

describe('OA助手独立后台生命周期', () => {
  const oldEnv = { node: process.env.NODE_ENV, legacy: process.env.OUTBOX_WORKER, assistant: process.env.FEISHU_ASSISTANT_WORKER };
  let service: AssistantService;
  beforeEach(() => {
    jest.useFakeTimers();
    process.env.NODE_ENV = 'production';
    process.env.OUTBOX_WORKER = 'off';
    delete process.env.FEISHU_ASSISTANT_WORKER;
    service = new AssistantService({} as never, {} as never, {} as never);
    jest.spyOn(service, 'tick').mockResolvedValue();
  });
  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
    for (const [key, value] of Object.entries({ NODE_ENV: oldEnv.node, OUTBOX_WORKER: oldEnv.legacy, FEISHU_ASSISTANT_WORKER: oldEnv.assistant })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  it('原有出站worker暂停时，仍可按助手自己的配置轮询，销毁后停止', () => {
    service.onModuleInit();
    expect(service.tick).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(15000);
    expect(service.tick).toHaveBeenCalledTimes(2);
    service.onModuleDestroy();
    jest.advanceTimersByTime(30000);
    expect(service.tick).toHaveBeenCalledTimes(2);
  });
  it.each(['dedicated-off', 'test'])('助手独立关闭或测试环境不启动：%s', mode => {
    if (mode === 'test') process.env.NODE_ENV = 'test'; else process.env.FEISHU_ASSISTANT_WORKER = 'off';
    service.onModuleInit();
    jest.advanceTimersByTime(30000);
    expect(service.tick).not.toHaveBeenCalled();
  });
});
