import { validate } from 'class-validator';
import { CollectorTextDto } from './collector-text.controller';
import { CollectorTextService, TEXT_PROMPTS } from './collector-text.service';

function setup(rows = [{ baseUrl: 'https://api.deepseek.com', enc: 'encrypted', model: 'deepseek-flash' }]) {
  const ds = { query: jest.fn(async (..._args: unknown[]) => rows) };
  const crypto = { decrypt: jest.fn(() => 'test-server-only-key') };
  const service = new CollectorTextService(ds as any, crypto as any);
  const fetcher = jest.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '校正后的正文' } }] })));
  service.fetchFn = fetcher;
  return { service, ds, fetcher };
}

describe('DeepSeek 话术整理（模拟服务，不发送真实文字）', () => {
  it('按公司查密钥，只返回能力和模型；调用使用文字且不接受客户端地址', async () => {
    const { service, ds, fetcher } = setup();
    expect(await service.overview(28)).toEqual({ configured: true, provider: 'DeepSeek', model: 'deepseek-flash', maxCharacters: 20000 });
    expect(ds.query.mock.calls[0][1]).toEqual([28, 'active']);
    expect(await service.organize(28, 7, 'restore', '主播转写原文', '花生种子店')).toEqual({ body: '校正后的正文', model: 'deepseek-flash', mode: 'restore' });
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(options.redirect).toBe('error');
    expect(options.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer test-server-only-key' }));
    const body = JSON.parse(String(options.body));
    expect(body.messages[0].content).toContain('不编造');
    expect(body.messages[1].content).toContain('主播转写原文');
    expect(body.messages[1].content).not.toContain('test-server-only-key');
    expect(body.thinking).toEqual({ type: 'disabled' });
  });
  it('不同模式保留原话和差异；DTO拒绝额外身份、地址、超长文本与非法模式', async () => {
    expect(TEXT_PROMPTS.restore).toContain('循环重复');
    expect(TEXT_PROMPTS.script).toContain('分版本');
    for (const bad of [{ mode: 'raw-chat', text: '文字' }, { mode: 'restore', text: 'x'.repeat(20001) }, { mode: 'restore', text: '文字', companyId: 3 }, { mode: 'script', text: '文字', baseUrl: 'https://evil.test' }]) {
      expect((await validate(Object.assign(new CollectorTextDto(), bad), { whitelist: true, forbidNonWhitelisted: true })).length).toBeGreaterThan(0);
    }
  });
  it('非官方域名、私网、重定向网址和非HTTPS配置不能被用来发送文字', async () => {
    for (const baseUrl of ['http://api.deepseek.com', 'https://api.deepseek.com.evil.test', 'http://127.0.0.1', 'https://api.deepseek.com?key=oops', 'https://user:pass@api.deepseek.com', 'https://api.deepseek.com/other']) {
      const { service, fetcher } = setup([{ baseUrl, enc: 'encrypted', model: null as any }]);
      expect((await service.overview(1)).configured).toBe(false);
      await expect(service.organize(1, 1, 'script', '测试文字', '')).rejects.toThrow('请管理员');
      expect(fetcher).not.toHaveBeenCalled();
    }
  });
  it('余额、权限、网络错误与截断结果明确失败，服务商原始响应和密钥不回传', async () => {
    const { service, fetcher } = setup();
    for (const status of [401, 402, 429, 500]) {
      fetcher.mockImplementationOnce(async () => new Response('test-server-only-key 原始敏感响应', { status }));
      await expect(service.organize(1, 2, 'restore', '测试文字', '')).rejects.not.toThrow('test-server-only-key');
    }
    fetcher.mockImplementationOnce(async () => { throw Error('test-server-only-key'); });
    await expect(service.organize(1, 2, 'restore', '测试文字', '')).rejects.toThrow('连接超时或中断');
    fetcher.mockImplementationOnce(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '半句话' } }] })));
    await expect(service.organize(1, 2, 'script', '测试文字', '')).rejects.toThrow('未完整生成');
    await expect(service.organize(1, 2, 'script', '测试文字', '')).resolves.toHaveProperty('body');
  });
  it('同员工不能重复生成；其他公司独立使用，结束后释放锁', async () => {
    const { service, fetcher } = setup();
    let release!: (value: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }));
    const waiting = service.organize(1, 2, 'restore', '测试文字', '');
    while (!release) await new Promise(resolve => setImmediate(resolve));
    await expect(service.organize(1, 2, 'restore', '测试文字', '')).rejects.toThrow('正在处理中');
    await expect(service.organize(3, 2, 'restore', '其他公司文字', '')).resolves.toHaveProperty('body');
    release(new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '结果' } }] })));
    await waiting;
    await expect(service.organize(1, 2, 'restore', '测试文字', '')).resolves.toHaveProperty('body');
  });
});
