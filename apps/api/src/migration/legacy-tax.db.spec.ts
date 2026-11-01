import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, ResourceRecord, User } from '../entities';
import { buildServices } from '../test-support';
import type { AuthUser } from '../common/auth.decorators';
import { runLegacyImport } from './runner';
import { legacyRef, type LegacyArchive } from './protocol';
import { readSourceRow } from './source-rows';

const suite = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
suite('税务旧异常资料独立保留，不伪造执照或合并税务内容', () => {
  let ds: DataSource, svc: ReturnType<typeof buildServices>, admin: AuthUser;
  beforeAll(async () => {
    ds = await new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true }).initialize();
    svc = buildServices(ds);
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: randomBytes(6).toString('hex'), name: '税务历史测试', status: 'active' }));
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: randomBytes(6).toString('hex'), name: '管理员', passwordHash: 'x', status: 'active', isCompanyAdmin: true, mustChangePassword: false }));
    admin = { id: u.id, companyId: c.id, name: u.name, permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
  });
  afterAll(async () => { await ds?.destroy(); });
  const original = (id: string, license_id: string | null, taxpayer_name: string) => ({ id, company_id: 3, license_id, taxpayer_name, tax_category: 'operation', status: 'normal' });
  it('空跑完整回滚；正式导入原缺执照和多份同类税务，保留原名、原状态和加密来源', async () => {
    const raw = [original('orphan', null, '原未关联税务'), original('one', 'l1', '第一份税务原名'), original('two', 'l2', '第二份不同税务原名')];
    const records = [
      { type: 'licenses', id: 'l1', data: { category: 'operation', companyName: '同一主体', creditCode: 'TAX-SAME-LICENSE', legalPerson: '原法人' } },
      { type: 'licenses', id: 'l2', data: { category: 'operation', companyName: '同一主体', creditCode: 'TAX-SAME-LICENSE', legalPerson: '原法人' } },
      ...raw.map(r => ({ type: 'tax-profiles', id: r.id, status: r.status, sourceTaxRow: r, data: { taxCategory: 'operation', taxpayerName: r.taxpayer_name, ...(r.license_id ? { licenseId: legacyRef('licenses', r.license_id) } : {}) } })),
    ];
    const archive: LegacyArchive = { company: { id: 3, name: '税务历史测试' }, departments: [], positions: [], employees: [], employeePositions: [], positionPermissions: [], records, exclusions: [], loadFile: async () => Buffer.alloc(0) };
    const opts = { companyId: admin.companyId, actorId: admin.id, expectedName: archive.company.name, preserveLegacyStates: true, sourceRowsCrypto: svc.crypto };
    const dry = await runLegacyImport(ds, svc.resources, svc.files, archive, { ...opts, apply: false }); expect(dry.failures).toEqual([]);
    expect(await ds.manager.count(ResourceRecord, { where: { companyId: admin.companyId, type: 'tax-profiles' } })).toBe(0);
    expect(await readSourceRow(ds.manager, svc.crypto, { companyId: admin.companyId, sourceCompanyId: 3, table: 'tax_profiles', key: 'orphan' })).toBeNull();
    const applied = await runLegacyImport(ds, svc.resources, svc.files, archive, { ...opts, apply: true, expectedReport: dry }); expect(applied.failures).toEqual([]);
    const taxes = await ds.manager.find(ResourceRecord, { where: { companyId: admin.companyId, type: 'tax-profiles' } });
    expect(taxes).toHaveLength(3); expect(taxes.every(t => t.status === 'normal')).toBe(true);
    const orphan = taxes.find(t => t.title === '原未关联税务')!;
    expect(orphan.data.licenseId).toBeUndefined(); expect(orphan.data.migrationNotice).toContain('未关联');
    const one = taxes.find(t => t.title === '第一份税务原名')!, two = taxes.find(t => t.title === '第二份不同税务原名')!;
    expect(one.id).not.toBe(two.id); expect(one.data.licenseId).toBe(two.data.licenseId); expect(two.data.migrationNotice).toContain('多份');
    for (const r of raw) expect(await readSourceRow(ds.manager, svc.crypto, { companyId: admin.companyId, sourceCompanyId: 3, table: 'tax_profiles', key: r.id })).toEqual(r);
    // Unrelated edits work without changing the old incomplete identity.
    await svc.resources.update(admin, 'tax-profiles', orphan.id, { note: '核对中' });
    await svc.resources.update(admin, 'tax-profiles', two.id, { note: '保留第二份原资料' });
    const fixed = await svc.resources.update(admin, 'tax-profiles', two.id, { taxCategory: 'ecommerce' });
    expect(fixed.data.migrationNotice).toBeUndefined(); expect(fixed.data._legacyTaxIssue).toBeUndefined();
    // Neither ordinary creation nor edited identities can forge the exception.
    await expect(svc.resources.create(admin, 'tax-profiles', { taxpayerName: '伪造', _legacyTaxIssue: { missingLicense: true }, migrationNotice: '伪造' })).rejects.toThrow('营业执照');
    await expect(svc.resources.create(admin, 'tax-profiles', { licenseId: one.data.licenseId, taxCategory: 'operation', taxpayerName: '新重复', _legacyTaxIssue: { duplicateLicenseId: one.data.licenseId, duplicateCategory: 'operation' } })).rejects.toThrow('同类别');
    await expect(svc.resources.update(admin, 'tax-profiles', two.id, { taxCategory: 'operation' })).rejects.toThrow('同类别');
    const again = await runLegacyImport(ds, svc.resources, svc.files, archive, { ...opts, apply: true }); expect(again.created).toEqual({});
    expect((await svc.resources.get(admin, 'tax-profiles', two.id)).data.taxCategory).toBe('ecommerce');
  });
  it('原始公司、名称或执照不一致时拒绝，不扩大例外', async () => {
    const archive: LegacyArchive = { company: { id: 3, name: '税务历史测试' }, departments: [], positions: [], employees: [], employeePositions: [], positionPermissions: [], records: [{ type: 'tax-profiles', id: 'forged', data: { taxpayerName: '不同名字', taxCategory: 'operation' }, sourceTaxRow: original('forged', null, '原名字') }], exclusions: [], loadFile: async () => Buffer.alloc(0) };
    const dry = await runLegacyImport(ds, svc.resources, svc.files, archive, { companyId: admin.companyId, actorId: admin.id, expectedName: archive.company.name, apply: false, preserveLegacyStates: true, sourceRowsCrypto: svc.crypto });
    expect(dry.failures).toContainEqual(expect.objectContaining({ id: 'forged', reason: expect.stringContaining('证据不一致') }));
  });
});
