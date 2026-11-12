import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ResourceRecord } from '../entities';
import { CatalogApiService } from './catalog-api.service';
import { CostService } from './cost.service';
import { LegacyVerifiedFeedController } from './data-tools.controller';

describe('客服旧接口包含待重新验证SKU', () => {
  const companyId = 71;
  const rows = [
    { bundleId: 1, code: 'A', name: '已验证', status: 'verified', categoryId: null, weightG: null },
    { bundleId: 2, code: 'B', name: '需重验', status: 'reverify', categoryId: null, weightG: null, costState: 'incomplete' },
    { bundleId: 3, code: 'C', name: '未验证', status: 'pending', categoryId: null, weightG: null },
  ];
  let catalog: CatalogApiService;
  let find: jest.Mock;
  let allRows: jest.Mock;
  beforeEach(() => {
    find = jest.fn(async (_entity: unknown, q: { where: { companyId: number; type: string } }) => {
      expect(q.where.companyId).toBe(companyId);
      return q.where.type === 'finance-bundles'
        ? rows.map((r) => ({ id: r.bundleId, companyId, status: r.status, data: { styleCode: 'STYLE', shortName: r.name } })) : [];
    });
    allRows = jest.fn(async (user: { companyId: number }) => {
      expect(user.companyId).toBe(companyId);
      return { rows };
    });
    catalog = new CatalogApiService({ manager: { find }, query: jest.fn(async () => []) } as unknown as DataSource,
      { allRows } as unknown as CostService);
  });
  it('不传参数和显式false均保持旧调用方只读已验证的契约', async () => {
    expect((await catalog.legacyFeed(companyId, {})).rows.map((r) => r.code)).toEqual(['A']);
    expect((await catalog.legacyAll(companyId, { includeReverify: 'false' })).total).toBe(1);
  });
  it('包含待重验项并保持跨页总数、游标与真实状态，不放入未验证项', async () => {
    const first = await catalog.legacyFeed(companyId, { includeReverify: 'true', limit: 1 });
    const second = await catalog.legacyFeed(companyId, { includeReverify: 'true', limit: 1, afterId: first.nextCursor! });
    expect(first.total).toBe(2); expect(first.nextCursor).toBe(1);
    expect(second.total).toBe(2); expect(second.nextCursor).toBeNull();
    expect(second.rows[0]).toMatchObject({ code: 'B', verification: { status: 'reverify' }, details: { profile: { final_code: 'B', final_style_code: 'STYLE' } } });
  });
  it('成本资料不完整也不阻止客服身份资料同步，响应不附带成本字段', async () => {
    const result = await catalog.legacyByCode(companyId, 'B', { includeReverify: 'true' });
    expect(result?.verification.status).toBe('reverify');
    expect(JSON.stringify(result)).not.toMatch(/costState|preShipCost|minimumSellingPrice/);
  });
  it('all和按编码查询使用同一包含待重验项的范围', async () => {
    expect((await catalog.legacyAll(companyId, { includeReverify: 'true' })).total).toBe(2);
    expect(await catalog.legacyByCode(companyId, 'B')).toBeNull();
    expect(await catalog.legacyByCode(companyId, 'C', { includeReverify: 'true' })).toBeNull();
    expect(await catalog.legacyByCode(companyId, 'B', { includeReverify: 'true' })).not.toBeNull();
    expect(find).toHaveBeenCalledWith(ResourceRecord, expect.objectContaining({ where: expect.objectContaining({ companyId, type: 'finance-bundles' }) }));
  });
  it('读取失败向调用方报错，不伪造空成功响应', async () => {
    allRows.mockRejectedValueOnce(new Error('synthetic read failure'));
    await expect(catalog.legacyFeed(companyId, { includeReverify: 'true' })).rejects.toThrow('synthetic read failure');
  });
  const dto = Reflect.getMetadata('design:paramtypes', LegacyVerifiedFeedController.prototype, 'page')[1];
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
  it('HTTP查询白名单接受true和false并转换游标数字', async () => {
    for (const includeReverify of ['true', 'false']) {
      await expect(pipe.transform({ afterId: '1', limit: '100', includeReverify }, { type: 'query', metatype: dto }))
        .resolves.toMatchObject({ afterId: 1, limit: 100, includeReverify });
    }
  });
  it('HTTP查询拒绝未知状态或其他多余参数', async () => {
    await expect(pipe.transform({ includeReverify: 'yes' }, { type: 'query', metatype: dto })).rejects.toThrow();
    await expect(pipe.transform({ includeReverify: 'true', companyId: 99 }, { type: 'query', metatype: dto })).rejects.toThrow();
  });
});
