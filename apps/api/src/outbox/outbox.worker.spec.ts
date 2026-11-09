import { OutboxService } from './outbox.service';

it('聚水潭后台任务不受旧的全局出站环境配置限制', () => {
  const original = { NODE_ENV: process.env.NODE_ENV, OUTBOX_WORKER: process.env.OUTBOX_WORKER };
  jest.useFakeTimers();
  const outbox = new OutboxService({} as never, {} as never);
  const processQueue = jest.spyOn(outbox, 'processAll').mockResolvedValue();
  try {
    process.env.NODE_ENV = 'production';
    process.env.OUTBOX_WORKER = 'off';
    outbox.onModuleInit();
    jest.advanceTimersByTime(30_000);
    expect(processQueue).toHaveBeenCalledTimes(1);
  } finally {
    outbox.onModuleDestroy();
    jest.useRealTimers();
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
