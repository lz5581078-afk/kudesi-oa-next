import { JushuitanClient } from '../integrations/jushuitan.client';
import { CompanyJstSender } from './jushuitan-sender';

const queryPath = '/open/category/query';
function clientWithCall(call: jest.Mock) {
  const client = new JushuitanClient({ appKey: 'test', appSecret: 'test', accessToken: 'test', baseUrl: 'https://dev-api.jushuitan.com/' });
  jest.spyOn(client, 'call').mockImplementation(call);
  return client;
}
const row = (id: number, name: string, parent = 0) => ({ c_id: id, name, parent_c_id: parent });

it('reads the full category directory when the API returns page count or string pagination flags', async () => {
  const call = jest.fn()
    .mockResolvedValueOnce({ datas: [row(7, '种子')], page_count: '3' })
    .mockResolvedValueOnce({ datas: [row(8, '油菜', 7)], has_next: 'true' })
    .mockResolvedValueOnce({ datas: [row(9, '杂交油菜', 8)], has_next: 'false' });
  const sender = new CompanyJstSender(clientWithCall(call), 'test-target');
  expect(await sender.readCategories()).toEqual([
    { id: '7', name: '种子', parentId: '0', sort: null, enable: null },
    { id: '8', name: '油菜', parentId: '7', sort: null, enable: null },
    { id: '9', name: '杂交油菜', parentId: '8', sort: null, enable: null },
  ]);
  expect(call.mock.calls).toEqual([1, 2, 3].map(page => [queryPath, { page_index: page, page_size: 100 }]));
});

it('rejects overlapping pages so a partial or ambiguous tree cannot be used for a write plan', async () => {
  const call = jest.fn()
    .mockResolvedValueOnce({ datas: [row(7, '种子')], has_next: true })
    .mockResolvedValueOnce({ datas: [row(7, '种子')], has_next: false });
  await expect(new CompanyJstSender(clientWithCall(call), 'test-target').readCategories()).rejects.toThrow('重复 ID');
});

it('keeps an update with an unconfirmed receipt in readback-only state', async () => {
  const call = jest.fn()
    .mockResolvedValueOnce({ datas: [row(7, '原名')], has_next: false })
    .mockResolvedValueOnce({});
  const persist = jest.fn();
  const sender = new CompanyJstSender(clientWithCall(call), 'test-target', undefined, persist);
  const payload = { targetKey: 'test-target', remoteId: '7', op: 'update', desired: { name: '新名' } };
  const job = { kind: 'category_sync', idempotencyKey: 'category-7', payload };
  await expect(sender.send(job)).rejects.toMatchObject({ outcomeUnknown: true });
  expect(payload).toMatchObject({ transport: { stage: 'category-write-intent', remoteId: '7' } });

  call.mockResolvedValueOnce({ datas: [row(7, '新名')], has_next: false });
  await expect(sender.send(job)).resolves.toEqual({ remoteId: '7' });
  expect(call.mock.calls.filter(([path]) => path.endsWith('addorupdate'))).toHaveLength(1);
});
