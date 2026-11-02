import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FeishuAssistantCard } from './FeishuAssistantCard';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('通过真实API客户端将设置序列化一次，保存成功后清空密钥', async () => {
  const settings = { appId: 'cli_test', tenantKey: 'test-tenant', secretConfigured: false, enabled: false, morningEnabled: true, welcomeEnabled: true, morningText: '早上好', welcomeText: '欢迎加入', departmentIds: ['0'], eventConnection: 'not_started', jobs: [] };
  let submitted: Record<string, unknown> | undefined;
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    if (init.method === 'PUT') {
      const body = JSON.parse(init.body);
      // Express's strict JSON parser accepts objects, not a JSON-encoded string.
      if (typeof body !== 'object' || body === null) return new Response(JSON.stringify({ message: 'JSON body must be an object' }), { status: 400 });
      submitted = body;
      return new Response(JSON.stringify({ ...settings, ...body, appSecret: undefined, secretConfigured: true }));
    }
    return new Response(JSON.stringify(settings));
  }));
  render(<FeishuAssistantCard canEdit />);
  const secret = await screen.findByLabelText('App Secret');
  fireEvent.change(secret, { target: { value: 'synthetic-test-secret' } });
  fireEvent.click(screen.getByLabelText('开启自动发送（关闭后停止早安和欢迎消息）'));
  fireEvent.click(screen.getByRole('button', { name: /^保存$/ }));
  await screen.findByText(/已保存。早安每天/);
  expect(submitted).toMatchObject({ appSecret: 'synthetic-test-secret', enabled: true, departmentIds: ['0'] });
  await waitFor(() => expect((secret as HTMLInputElement).value).toBe(''));
  expect(screen.queryByRole('alert')).toBeNull();
});
