import { EntityManager } from 'typeorm';
import { deriveProductReferenceList } from './product-reference-list';
import { deriveProductReferenceSortIds, orderProductReferenceIds, PRODUCT_REFERENCE_SORT_KEYS, type ProductReferenceSortKey } from './product-reference-sort';
jest.mock('./product-reference-list', () => ({ deriveProductReferenceList: jest.fn() }));
const product = (id: number, data: Record<string, unknown> = {}) => ({ id, companyId: 1, type: 'finance-products', data });
const em = {} as EntityManager;
afterEach(() => jest.resetAllMocks());
describe('原商品虚拟列全候选排序', () => {
  it('205条全候选先排序才分页，四个来源键都使用同一批量派生值，不读取当前页或缓存', async () => {
    const records = Array.from({ length: 205 }, (_, index) => product(index + 1));
    const values = new Map(records.map(record => [record.id, { __sourceCount: 206 - record.id, __sourceSupplier: `供应商${206 - record.id}`, __sourceOrigin: `产区${206 - record.id}`, __categoryCode: `C${206 - record.id}` }]));
    jest.mocked(deriveProductReferenceList).mockResolvedValue(values);
    for (const key of PRODUCT_REFERENCE_SORT_KEYS.filter(key => key !== '__freightHandling')) {
      const ids = await deriveProductReferenceSortIds(em, 1, records, key, 'asc');
      expect(ids).toHaveLength(205); expect(ids.slice(0, 20)).toEqual(Array.from({ length: 20 }, (_, index) => 205 - index)); expect(ids[ids.length - 1]).toBe(1);
      expect(deriveProductReferenceList).toHaveBeenLastCalledWith(em, 1, records);
    }
    expect(records[0].id).toBe(1); expect(values.get(205)?.__sourceCount).toBe(1);
  });
  it('null、空串、短横线与非有限数两向都放最后，0可排序且相同值保持原候选顺序', () => {
    const records = [product(9), product(3), product(7), product(4), product(1), product(6), product(5), product(2)];
    const values = new Map(records.map((record, index) => [record.id, { __sourceCount: [null, '', '-', NaN, 0, 2, '2 条', 10][index] }]));
    expect(orderProductReferenceIds(records, values, '__sourceCount', 'asc')).toEqual([1, 6, 5, 2, 9, 3, 7, 4]);
    expect(orderProductReferenceIds(records, values, '__sourceCount', 'desc')).toEqual([2, 6, 5, 1, 9, 3, 7, 4]);
  });
  it('中文使用numeric/base排序，数字文本按数值而非字典序，等值不按ID重排', () => {
    const records = [product(30), product(2), product(10), product(1)];
    const values = new Map([[30, { __sourceSupplier: '供应商10', __categoryCode: '02' }], [2, { __sourceSupplier: '供应商2', __categoryCode: '2' }], [10, { __sourceSupplier: '供应商02', __categoryCode: '10' }], [1, { __sourceSupplier: '供应商1', __categoryCode: '' }]]);
    expect(orderProductReferenceIds(records, values, '__sourceSupplier', 'asc')).toEqual([1, 2, 10, 30]);
    expect(orderProductReferenceIds(records, values, '__sourceSupplier', 'desc')).toEqual([30, 2, 10, 1]);
    expect(orderProductReferenceIds(records, values, '__categoryCode', 'asc')).toEqual([30, 2, 10, 1]);
  });
  it('运装按源至少3位并保留额外精度的金额/规格文本排序，不擅自改成纯金额大小', () => {
    const records = [product(1, { freight: 110.01, handlingFee: 0, purchaseSpec: '箱' }), product(2, { freight: 110.1, handlingFee: 0, purchaseSpec: '箱' }), product(3, { freight: 110.1, handlingFee: 0, purchaseSpec: '箱2' }), product(4, { freight: 110.1, handlingFee: 0, purchaseSpec: '箱10' })];
    // ¥1.101 sorts before ¥1.1001 in the source's numeric text collator; do not round either to 3 decimals.
    expect(orderProductReferenceIds(records, new Map(), '__freightHandling', 'asc')).toEqual([2, 3, 4, 1]);
    expect(orderProductReferenceIds(records, new Map(), '__freightHandling', 'desc')).toEqual([1, 4, 3, 2]);
  });
  it('合计复用定点sum，未知金额不造0、全0显示空；规格优先级与稳定同值不变，金额无需读库', async () => {
    const records = [product(7, { freight: 0.1, handlingFee: 0.2, freightSystemSpecification: '规格2', purchaseSpec: '忽略后备' }), product(5, { freight: 0.3, handlingFee: 0, purchaseSpec: '规格2' }), product(6, { freight: null, handlingFee: 0.3, purchaseSpec: '规格2' }), product(9, { freight: null, handlingFee: null }), product(1, { freight: 0, handlingFee: 0 }), product(11, { freight:20.000001, handlingFee:0 }), product(12, { freight:NaN, handlingFee:0 }), product(8, { freight: 0.3, handlingFee: 0, purchaseSpec: '规格10' })];
    expect(await deriveProductReferenceSortIds(em, 1, records, '__freightHandling', 'asc')).toEqual([7, 5, 8, 11, 6, 9, 1, 12]);
    expect(await deriveProductReferenceSortIds(em, 1, records, '__freightHandling', 'desc')).toEqual([11, 8, 7, 5, 6, 9, 1, 12]);
    expect(deriveProductReferenceList).not.toHaveBeenCalled();
  });
  it('极细八位元合计参与源文本排序，精确同值稳定、非法第九位与缺失两向末',()=>{
    const records=[product(4,{freight:0.000001,handlingFee:0.000002,purchaseSpec:'规格'}),product(2,{freight:0.000002,handlingFee:0,purchaseSpec:'规格'}),product(3,{freight:0.000003,handlingFee:0,purchaseSpec:'规格'}),product(1,{freight:0.000001,handlingFee:0,purchaseSpec:'规格'}),product(9,{freight:0.0000001,handlingFee:0}),product(8,{freight:null,handlingFee:0})];
    expect(orderProductReferenceIds(records,new Map(),'__freightHandling','asc')).toEqual([1,2,4,3,9,8]);expect(orderProductReferenceIds(records,new Map(),'__freightHandling','desc')).toEqual([4,3,2,1,9,8]);
  });
  it('只返回同公司有效商品ID，重复候选不重复，非法字段/方向在查询前拒绝', async () => {
    const valid = product(8);
    jest.mocked(deriveProductReferenceList).mockResolvedValue(new Map([[8, { __sourceCount: 0 }]]));
    const records = [valid, valid, { ...product(9), companyId: 2 }, { ...product(10), type: 'finance-customers' }, product(-1)];
    expect(await deriveProductReferenceSortIds(em, 1, records, '__sourceCount', 'asc')).toEqual([8]);
    expect(deriveProductReferenceList).toHaveBeenCalledWith(em, 1, [valid]);
    jest.mocked(deriveProductReferenceList).mockClear();
    await expect(deriveProductReferenceSortIds(em, 1, records, 'purchasePrice' as ProductReferenceSortKey, 'asc')).rejects.toThrow(/排序/);
    await expect(deriveProductReferenceSortIds(em, 1, records, '__sourceCount', 'sideways' as 'asc')).rejects.toThrow(/排序/);
    expect(deriveProductReferenceList).not.toHaveBeenCalled();
  });
});
