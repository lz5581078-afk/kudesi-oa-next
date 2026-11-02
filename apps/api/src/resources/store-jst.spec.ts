import { storeJstShops, validateStoreJst, parseStoreJstExpiry } from './store-jst';
import { ExternalConfigService } from '../integrations/external-config.service';
import { JushuitanClient } from '../integrations/jushuitan.client';

afterEach(() => jest.restoreAllMocks());
const shops = [{ id: '123', name: '聚水潭甲店', platform: '淘宝' }];

describe('店铺聚水潭关联', () => {
  it('仅查询令牌公司的授权企业并只返回店铺摘要，去掉重复及无编号项', async () => {
    const jst = jest.fn().mockResolvedValue({ coid: 88, baseUrl: 'https://openapi.jushuitan.com' });
    const pages = jest.spyOn(JushuitanClient.prototype, 'pages').mockResolvedValue([
      { co_id: 88, shop_id: 123, shop_name: '甲店', shop_site: '淘宝', session_expired: '2027-03-17 12:00:00', access_token: 'must-not-return' },
      { co_id: '88', shop_id: 123, shop_name: '甲店', shop_site: '淘宝', session_expired: '2027-03-17 12:00:00' },
      { co_id: 99, shop_id: 124, shop_name: '另一家公司' },
      { co_id: 88, shop_name: '无编号' },
    ]);
    expect(await storeJstShops({ jst } as unknown as ExternalConfigService, 7)).toEqual([{ id: '123', name: '甲店', platform: '淘宝', expiresAt: '2027-03-17', expiryStatus: 'dated' }]);
    expect(jst).toHaveBeenCalledWith(7);
    expect(pages).toHaveBeenCalledWith('/open/shops/query', {}, 'datas');
  });
  it('保存核实编号，店名由服务端权威列表生成', async () => {
    const data = { jushuitanShopId: ' 123 ', jushuitanShopName: '伪造名称' };
    await validateStoreJst(data, undefined, async () => shops);
    expect(data).toEqual({ jushuitanShopId: '123', jushuitanShopName: '聚水潭甲店', jushuitanExpireAt: null, jushuitanExpiryStatus: 'unknown' });
  });
  it('拒绝不属于本公司授权范围的编号', async () => {
    await expect(validateStoreJst({ jushuitanShopId: 'other-company' }, undefined, async () => shops)).rejects.toThrow('不在当前公司授权范围内');
  });
  it('外部失败不保存新关联', async () => {
    await expect(validateStoreJst({ jushuitanShopId: '123' }, undefined, async () => { throw new Error('授权过期'); })).rejects.toThrow('授权过期');
  });
  it('保持旧编号/名称及清除关联时不查外部接口，历史编号无需补名称也可保留', async () => {
    const load = jest.fn();
    const same = { jushuitanShopId: '123', jushuitanShopName: '伪造' };
    await validateStoreJst(same, { jushuitanShopId: '123', jushuitanShopName: '原店' }, load);
    expect(same.jushuitanShopName).toBe('原店');
    const legacy = { jushuitanShopId: '456', jushuitanShopName: '伪造' };
    await validateStoreJst(legacy, { jushuitanShopId: '456' }, load);
    expect(legacy).toEqual({ jushuitanShopId: '456' });
    const clear = { jushuitanShopId: '', jushuitanShopName: '原店' };
    await validateStoreJst(clear, { jushuitanShopId: '123' }, load);
    expect(clear).toEqual({});
    expect(load).not.toHaveBeenCalled();
  });
});


describe('店铺授权期限解析', () => {
  it.each([
    ['2027-03-17 15:30:00', '2027-03-17'],
    ['2028/02/29', '2028-02-29'],
    ['2027/3/7 9:30:00', '2027-03-07'],
    ['2027-03-17T23:30:00Z', '2027-03-18'],
    ['2027-03-17T15:30:00+08:00', '2027-03-17'],
  ])('日期/时间 %s 按中国日期存入现有日期字段', (raw, expected) => {
    expect(parseStoreJstExpiry(raw)).toEqual({ expiresAt: expected, expiryStatus: 'dated' });
  });
  it.each(['------永久授权------', '永久有效', '长期有效'])('识别明确永久值 %s', raw => {
    expect(parseStoreJstExpiry(raw)).toEqual({ expiresAt: null, expiryStatus: 'permanent' });
  });
  it.each([undefined, null, '', '2027-02-29', '2027-03-17 25:30:00', 'not a date', 0, '0000-00-00'])('缺失或非法值 %s 不猜测永久授权', raw => {
    expect(parseStoreJstExpiry(raw)).toEqual({ expiresAt: null, expiryStatus: 'unknown' });
  });
  it('新关联写入 API 日期，解绑清除同步值，其他资料编辑保留已有日期', async () => {
    const data: Record<string, unknown> = { jushuitanShopId: '123', jushuitanExpireAt: '2000-01-01' };
    await validateStoreJst(data, undefined, async () => [{ ...shops[0], expiresAt: '2027-03-17', expiryStatus: 'dated' }]);
    expect(data.jushuitanExpireAt).toBe('2027-03-17');
    await validateStoreJst(data, { ...data }, async () => { throw new Error('offline'); });
    expect(data.jushuitanExpireAt).toBe('2027-03-17');
    const clear = { ...data, jushuitanShopId: '' };
    await validateStoreJst(clear, data, async () => []);
    expect(clear).toEqual({});
  });
});
