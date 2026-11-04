import { CompanyJstSender } from './jushuitan-sender';
import { JushuitanClient } from '../integrations/jushuitan.client';

describe('普通商品三身份只读查重', () => {
  it('只用官方明确的sku_ids/i_ids/exactly_name条件，分别分页后归并必要字段', async () => {
    const row = { sku_id: 'A', i_id: 'B', name: 'C', properties_value: '规格', category: '分类', cost_price: 123, app_secret: 'synthetic-not-output' };
    const client = { pages: jest.fn().mockResolvedValue([row]), call: jest.fn() };
    const sender = new CompanyJstSender(client as never, 'synthetic-target');
    expect(await sender.searchNormal({ skuId: 'A', styleId: 'B', name: 'C' })).toEqual([{ skuId: 'A', styleId: 'B', name: 'C', spec: '规格', category: '分类' }]);
    expect(client.pages.mock.calls).toEqual([['/open/sku/query', { sku_ids: 'A' }, 'datas'], ['/open/sku/query', { i_ids: ['B'] }, 'datas'], ['/open/sku/query', { exactly_name: 'C' }, 'datas']]);
    expect(client.call).not.toHaveBeenCalled();
  });
  it('任一字段分页失败，整体未完成，不能当空命中', async () => {
    const client = { pages: jest.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('合成不完整分页')).mockResolvedValueOnce([]) };
    await expect(new CompanyJstSender(client as never, 'synthetic-target').searchNormal({ skuId: 'A', styleId: 'B', name: 'C' })).rejects.toThrow('合成不完整分页');
  });
  it('真实客户端遇到缺has_next的响应会明确失败，不向外写入或无限扫描', async () => {
    const fetcher = jest.fn(async () => ({ ok: true, json: async () => ({ code: 0, data: { datas: [] } }) }) as Response);
    const client = new JushuitanClient({ appKey: 'synthetic-key', appSecret: 'synthetic-secret', accessToken: 'synthetic-token', baseUrl: 'https://openapi.jushuitan.com' }, fetcher as typeof fetch);
    await expect(new CompanyJstSender(client, 'synthetic-target').searchNormal({ skuId: 'A', styleId: 'B', name: 'C' })).rejects.toThrow(/分页标记/);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.every(call => String((call as unknown[])[0]).includes('/open/sku/query'))).toBe(true);
  });
});
