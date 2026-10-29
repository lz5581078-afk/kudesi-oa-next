import { ExternalOutcomeUnknown, JushuitanClient, jstSign } from './jushuitan.client';
import { FeishuClient } from './feishu.client';
import { CompanyJstSender } from '../outbox/jushuitan-sender';
import { refundFor } from '../live/jushuitan-order-source';
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
const cfg = { appKey: 'test-key', appSecret: 'test-secret', accessToken: 'test-token', baseUrl: 'https://openapi.jushuitan.com' };
describe('真实外部接口适配器（使用隔离请求，不触达第三方）', () => {
  it('聚水潭按官方参数排序签名，正文不把秘密作为业务字段发送', async () => {
    expect(jstSign('s', { b: '2', a: '1' })).toBe(require('crypto').createHash('md5').update('sa1b2').digest('hex'));
    const fetcher = jest.fn(async () => response({ code: 0, data: { datas: [], has_next: false } }));
    await new JushuitanClient(cfg, fetcher as never).pages('/open/sku/query', { sku_ids: 'SKU1' }, 'datas');
    const p = new URLSearchParams((fetcher.mock.calls[0] as any)[1].body);
    expect(JSON.parse(p.get('biz')!)).toEqual({ sku_ids: 'SKU1', page_index: 1, page_size: 50 });
    expect(p.get('sign')).toBe(jstSign(cfg.appSecret, Object.fromEntries(p)));
    expect(p.has('app_secret')).toBe(false);
  });
  it('拒绝非官方目标及未知操作；禁止重定向泄漏令牌', async () => {
    expect(() => new JushuitanClient({ ...cfg, baseUrl: 'https://attacker.example' })).toThrow(/白名单/);
    const f = jest.fn(); await expect(new JushuitanClient(cfg, f).call('/delete/all', {})).rejects.toThrow(/未允许/); expect(f).not.toHaveBeenCalled();
  });
  it('分页缺失、超过上限都报错，不能将部分退款当作完整结果', async () => {
    const noPage = new JushuitanClient(cfg, (async () => response({ code: 0, data: { datas: [] } })) as never);
    await expect(noPage.pages('/open/refund/single/query', {}, 'datas')).rejects.toThrow(/分页/);
    const tooMany = new JushuitanClient(cfg, (async () => response({ code: 0, data: { datas: [], has_next: true } })) as never);
    await expect(tooMany.pages('/open/refund/single/query', {}, 'datas', 1)).rejects.toThrow(/上限/);
  });
  it('写入网络超时和服务端异常标为结果未知，错误不泄漏上游正文', async () => {
    const f = new JushuitanClient(cfg, (async () => { throw new Error('test-token'); }) as never);
    await expect(f.call('/open/item/combinesku/upload', {})).rejects.toBeInstanceOf(ExternalOutcomeUnknown);
    const bad = new JushuitanClient(cfg, (async () => response({ code: 99, msg: 'test-token' })) as never);
    await expect(bad.call('/open/sku/query', {})).rejects.not.toThrow('test-token');
  });
  it('基本售价更新保留子商品单价、数量以及未知远端字段', async () => {
    const remote = { sku_id: 'B', i_id: 'I', name: '组合', childList: [{ src_sku_id: 'A', qty: 2, sale_price: 3.12 }], custom: 'preserve', compose_sale_price: 10 };
    const client = { pages: jest.fn(async () => [remote]), call: jest.fn(async () => ({})) };
    const s = new CompanyJstSender(client as any, 'target');
    await s.send({ kind: 'bundle_price_update', idempotencyKey: '1', payload: { targetKey: 'target', sku_id: 'B', compose_sale_price: 20 } });
    expect(client.call.mock.calls[0]).toEqual(['/open/item/combinesku/upload', { is_cover: true, is_null_cover: false, items: [{ ...remote, compose_sale_price: 20, is_update_enty_sku_from_combine_sku: false }] }]);
    await expect(s.send({ kind: 'bundle_disable', idempotencyKey: '2', payload: { targetKey: 'other', sku_id: 'B' } })).rejects.toThrow(/身份/);
    expect(client.call).toHaveBeenCalledTimes(1);
  });
  it('飞书使用稳定 uuid 防重，不回传上游秘密或令牌', async () => {
    const f = jest.fn(async (url: string) => url.includes('tenant_access_token') ? response({ code: 0, tenant_access_token: 'secret-token' }) : response({ code: 0, data: { message_id: 'm1' } }));
    const c = new FeishuClient(f as never);
    await c.send({ appId: 'app', appSecret: 'secret' }, 'ou_x', 'open_id', 'test', 'company1:job1');
    const body = JSON.parse((f.mock.calls[1] as any)[1].body);
    expect(body.uuid).toHaveLength(48); expect(body.receive_id).toBe('ou_x'); expect(body.content).toBe(JSON.stringify({ text: 'test' }));
    await c.send({ appId: 'app', appSecret: 'secret' }, 'ou_x', 'open_id', 'test', 'company1:job1');
    expect(JSON.parse((f.mock.calls[3] as any)[1].body).uuid).toBe(body.uuid);
  });
  it('飞书发送超时不可自动重试；授权失败不泄漏 response', async () => {
    const c = new FeishuClient((async () => { throw new Error('secret'); }) as never);
    await expect(c.request('im/v1/messages?receive_id_type=open_id', {})).rejects.toBeInstanceOf(ExternalOutcomeUnknown);
    const denied = new FeishuClient((async () => response({ code: 999, msg: 'secret' })) as never);
    await expect(denied.tenantToken({ appId: 'app', appSecret: 'secret' })).rejects.not.toThrow('secret');
  });
  it('退款去重、排除换货、取消、封顶；缺失唯一编号和冲突都拒绝', () => {
    const r = { as_id: 1, refund: '8.20', status: 'Confirmed', type: '退货退款' };
    expect(refundFor(1000, { status: 'Sent' }, [r, r]).cents).toBe(820);
    expect(refundFor(1000, { status: 'Sent' }, [r, { ...r, as_id: 2 }]).cents).toBe(1000);
    expect(refundFor(1000, { status: 'Cancelled' }, []).source).toBe('cancelled');
    expect(refundFor(1000, {}, [{ ...r, type: '换货' }]).cents).toBe(0);
    expect(() => refundFor(1000, {}, [{ refund: 1 }])).toThrow(/唯一编号/);
    expect(() => refundFor(1000, {}, [r, { ...r, status: 'Cancelled' }])).toThrow(/冲突/);
  });
});

describe('聚水潭改码阶段持久化', () => {
  it('禁用已发生但超时：重新处理只回查，不重复禁用，再创建新码', async () => {
    const remote = new Map<string, any>([['OLD', { sku_id: 'OLD', i_id: 'I', name: '旧品', autoid: 1, enabled: 1 }]]);
    const events: string[] = [];
    let once = true;
    const client = { pages: jest.fn(async (_path: string, p: any) => remote.has(p.sku_ids) ? [remote.get(p.sku_ids)] : []), call: jest.fn(async (_path: string, b: any) => {
      const item = b.items[0]; events.push('write:' + item.sku_id); remote.set(item.sku_id, { ...item, autoid: item.sku_id === 'OLD' ? 1 : 2 });
      if (once) { once = false; throw new ExternalOutcomeUnknown('超时'); } return {};
    }) };
    const save = jest.fn(async (_key: string, p: any) => { events.push('save:' + p.transport.stage); });
    const sender = new CompanyJstSender(client as any, 'target', undefined, save);
    const job = { kind: 'base_code_replace', idempotencyKey: 'replace1', payload: { targetKey: 'target', oldCode: 'OLD', sku_id: 'NEW', i_id: 'I2', name: '新品' } };
    await expect(sender.send(job)).rejects.toBeInstanceOf(ExternalOutcomeUnknown);
    expect(events).toEqual(['save:disable-intent', 'write:OLD']);
    await sender.send(job);
    expect(events.filter(e => e === 'write:OLD')).toHaveLength(1);
    expect(events.filter(e => e === 'write:NEW')).toHaveLength(1);
    expect(remote.get('OLD').enabled).toBe(-1); expect(remote.get('NEW').name).toBe('新品');
    await sender.send(job); expect(client.call).toHaveBeenCalledTimes(2);
  });
  it('批量接口顶层成功、单项失败不能判作成功', async () => {
    const c = new JushuitanClient(cfg, (async () => response({ code: 0, data: { datas: [{ success: false, msg: 'secret' }] } })) as never);
    await expect(c.call('/open/jushuitan/itemsku/upload', {})).rejects.toThrow(/明确拒绝/);
  });
});
