import { beijingClock, morningDue, MORNING_TEXT } from './greetings';
import { FeishuClient } from '../integrations/feishu.client';
import { ExternalOutcomeUnknown } from '../integrations/jushuitan.client';

describe('OA助手北京时间与批量发送', () => {
  it('UTC午夜对应北京时间8点，跨年及夏令时不受服务器时区影响', () => {
    expect(beijingClock(new Date('2026-12-31T23:59:00Z'))).toEqual({ date: '2027-01-01', hour: 7, minute: 59 });
    expect(beijingClock(new Date('2026-07-01T00:00:00Z'))).toEqual({ date: '2026-07-01', hour: 8, minute: 0 });
  });
  it('只在8点到8点10分的恢复窗口触发，不补发历史早安', () => {
    const enabled = '2026-11-01T12:00:00Z';
    expect(morningDue(new Date('2026-11-02T00:00:00Z'), enabled)).toBe(true);
    expect(morningDue(new Date('2026-11-02T00:09:59Z'), enabled)).toBe(true);
    expect(morningDue(new Date('2026-11-02T00:10:00Z'), enabled)).toBe(false);
    expect(morningDue(new Date('2026-11-01T23:59:59Z'), enabled)).toBe(false);
    expect(morningDue(new Date('2026-11-02T00:05:00Z'), '2026-11-02T00:01:00Z')).toBe(false);
    expect(MORNING_TEXT).not.toContain('记得查看');
  });
  it('使用指定部门范围，批量消息正文为对象，不泄漏密钥', async () => {
    const f = jest.fn(async (url: string) => ({ ok: true, status: 200, json: async () => url.includes('tenant_access_token') ? { code: 0, tenant_access_token: 'test-token' } : { code: 0, data: { message_id: 'bm-test' } } }));
    const c = new FeishuClient(f as never);
    expect(await c.batchSend({ appId: 'app', appSecret: 'secret' }, ['0'], MORNING_TEXT)).toBe('bm-test');
    expect(JSON.parse((f.mock.calls[1] as any)[1].body)).toEqual({ department_ids: ['0'], msg_type: 'text', content: { text: MORNING_TEXT } });
  });
  it('超时、未返回消息ID或存在无效部门时不把部分发送当作成功', async () => {
    const c = new FeishuClient((async (url: string) => {
      if (!url.includes('tenant_access_token')) throw new Error('private token');
      return { ok: true, status: 200, json: async () => ({ code: 0, tenant_access_token: 'test' }) };
    }) as never);
    await expect(c.batchSend({ appId: 'a', appSecret: 'b' }, ['0'], 'hi')).rejects.toBeInstanceOf(ExternalOutcomeUnknown);
    const f = new FeishuClient((async (url: string) => ({ ok: true, status: 200, json: async () => url.includes('tenant_access_token') ? { code: 0, tenant_access_token: 'test' } : { code: 0, data: { message_id: 'bm-test', invalid_department_ids: ['0'] } } })) as never);
    await expect(f.batchSend({ appId: 'a', appSecret: 'b' }, ['0'], 'hi')).rejects.toBeInstanceOf(ExternalOutcomeUnknown);
  });
});
