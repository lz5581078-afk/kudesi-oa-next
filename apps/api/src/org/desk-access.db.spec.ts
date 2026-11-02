import 'reflect-metadata';
import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import { allGrantableKeys, cashierWithdrawalPermissions, deskAccessPermissions } from '@kudesi/shared';
import { buildDataSourceOptions } from '../database/data-source';
import { AuditLog, Company, Department, Position, PositionPermission, User, UserPermissionOverride } from '../entities';
import { AuthUser } from '../common/auth.decorators';
import { DeskAccessService } from './desk-access.service';

const db = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
db('岗位功能批量授权（真实数据库）', () => {
  let ds: DataSource, svc: DeskAccessService;
  beforeAll(async () => { ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never); await ds.initialize(); svc = new DeskAccessService(ds); });
  afterAll(async () => { await ds?.destroy(); });
  async function fixture() {
    const tag = randomBytes(6).toString('hex');
    const company = await ds.manager.save(Company, ds.manager.create(Company, { code: `desk-${tag}`, name: `岗位权限测试${tag}`, status: 'active' }));
    const department = async (name: string, parentId: number | null = null) => ds.manager.save(Department, ds.manager.create(Department, { companyId: company.id, name, parentId, status: 'active', sortOrder: 0 }));
    const hr = await department('人事部'), sub = await department('人事助理', hr.id), ops = await department('运营部');
    const position = async (name: string, departmentId: number, workspaceType: 'general' | 'operations' | 'finance') => ds.manager.save(Position, ds.manager.create(Position, { companyId: company.id, name, departmentId, workspaceType, level: 'staff', status: 'active', sortOrder: 0 }));
    const hp = await position('人事主管', sub.id, 'general'), op = await position('运营', ops.id, 'operations'), fp = await position('财务兼岗', ops.id, 'finance');
    const user = async (name: string, positionId: number | null, departmentId: number, isCompanyAdmin = false, extraPositionIds: number[] = []) => ds.manager.save(User, ds.manager.create(User, { companyId: company.id, account: `${tag}-${name}`, name, positionId, departmentId, isCompanyAdmin, extraPositionIds, status: 'active', passwordHash: 'test-only', mustChangePassword: false }));
    const admin = await user('admin', null, ops.id, true), hu = await user('hr', hp.id, hr.id), worker = await user('worker', op.id, ops.id, false, [fp.id]);
    for (const p of [hp, op, fp]) await ds.manager.save(PositionPermission, ds.manager.create(PositionPermission, { positionId: p.id, permission: p.id === hp.id ? 'live.manage' : 'finance.docs.post' }));
    for (const u of [hu, worker, admin]) await ds.manager.save(UserPermissionOverride, ds.manager.create(UserPermissionOverride, { userId: u.id, permission: 'system.integrations.view', effect: 'allow' }));
    const actor: AuthUser = { id: admin.id, companyId: company.id, name: admin.name, permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    return { company, hp, op, fp, hu, worker, admin, actor };
  }
  it('只更新当前公司：人事及下级、个人覆盖、管理员不变；兼岗权限保留为岗位并集', async () => {
    const a = await fixture(), b = await fixture();
    const plan = await svc.preview(a.actor);
    expect(plan.positions.find((p) => p.id === a.hp.id)?.preserved).toBe(true);
    expect(plan.staff.find((u) => u.id === a.hu.id)?.preserved).toBe(true);
    await svc.apply(a.actor, plan.fingerprint);
    expect((await ds.manager.find(PositionPermission, { where: { positionId: a.hp.id } })).map((g) => g.permission)).toEqual(['live.manage']);
    expect(await ds.manager.count(UserPermissionOverride, { where: { userId: a.hu.id } })).toBe(1);
    expect(await ds.manager.count(UserPermissionOverride, { where: { userId: a.admin.id } })).toBe(1);
    expect(await ds.manager.count(UserPermissionOverride, { where: { userId: a.worker.id } })).toBe(0);
    for (const p of [a.op, a.fp]) expect((await ds.manager.find(PositionPermission, { where: { positionId: p.id } })).map((g) => g.permission).sort()).toEqual(deskAccessPermissions(p.workspaceType, p.level));
    expect((await ds.manager.find(PositionPermission, { where: { positionId: b.op.id } })).map((g) => g.permission)).toEqual(['finance.docs.post']);
    const audit = await ds.manager.findOneByOrFail(AuditLog, { companyId: a.company.id, action: 'position.desk-permissions.apply' });
    expect((audit.detail as unknown as { fingerprint: string }).fingerprint).toBe(plan.fingerprint);
    const again = await svc.preview(a.actor); expect(again.changedPositions).toBe(0); expect(again.changedStaff).toBe(0);
  });
  it('非公司管理员不能预览或应用，伪造其他公司身份也不能读计划', async () => {
    const a = await fixture(), b = await fixture();
    const worker = { ...a.actor, id: a.worker.id, permissions: { isCompanyAdmin: false, allow: ['org.structure.edit'], deny: [] } };
    await expect(svc.preview(worker)).rejects.toThrow(/仅公司管理员/);
    await expect(svc.apply(worker, '0'.repeat(64))).rejects.toThrow(/仅公司管理员/);
    await expect(svc.preview({ ...a.actor, companyId: b.company.id })).rejects.toThrow(/仅公司管理员/);
  });
  it('预览后权限或岗位归属改变，拒绝旧计划且不覆盖新修改', async () => {
    const a = await fixture(), plan = await svc.preview(a.actor);
    await ds.manager.update(Position, { id: a.op.id }, { level: 'manager' });
    await expect(svc.apply(a.actor, plan.fingerprint)).rejects.toThrow(/重新预览/);
    expect((await ds.manager.find(PositionPermission, { where: { positionId: a.op.id } })).map((g) => g.permission)).toEqual(['finance.docs.post']);
  });
  it('人事员工兼任的非人事岗位也保留，个人拒绝不会被间接删除', async () => {
    const a = await fixture();
    await ds.manager.update(User, { id: a.hu.id }, { extraPositionIds: [a.fp.id] });
    await ds.manager.save(UserPermissionOverride, ds.manager.create(UserPermissionOverride, { userId: a.hu.id, permission: 'resource.stores.view', effect: 'deny' }));
    const plan = await svc.preview(a.actor); expect(plan.positions.find((p) => p.id === a.fp.id)?.preserved).toBe(true);
    await svc.apply(a.actor, plan.fingerprint);
    expect((await ds.manager.find(PositionPermission, { where: { positionId: a.fp.id } })).map((g) => g.permission)).toEqual(['finance.docs.post']);
    expect(await ds.manager.count(UserPermissionOverride, { where: { userId: a.hu.id } })).toBe(2);
  });
  it('真实部门名为人事综合部时，两个人事岗位完整203项及个人授权保留', async () => {
    const a = await fixture();
    await ds.manager.update(Department, { companyId: a.company.id, name: '人事部' }, { name: '人事综合部' });
    const second = await ds.manager.save(Position, ds.manager.create(Position, { companyId: a.company.id, name: '人事专员', departmentId: a.hp.departmentId, workspaceType: 'general', level: 'staff', status: 'active', sortOrder: 0 }));
    const original = [...allGrantableKeys()].sort().slice(0, 203);
    for (const positionId of [a.hp.id, second.id]) {
      await ds.manager.delete(PositionPermission, { positionId });
      await ds.manager.save(PositionPermission, original.map((permission) => ds.manager.create(PositionPermission, { positionId, permission })));
    }
    const plan = await svc.preview(a.actor);
    expect(plan.protectedDepartments).toContain('人事综合部');
    for (const id of [a.hp.id, second.id]) {
      const p = plan.positions.find((p) => p.id === id)!;
      expect(p.preserved).toBe(true); expect(p.before).toHaveLength(203); expect(p.after).toEqual(p.before);
    }
    await svc.apply(a.actor, plan.fingerprint);
    for (const positionId of [a.hp.id, second.id]) expect((await ds.manager.find(PositionPermission, { where: { positionId } })).map((p) => p.permission).sort()).toEqual(original);
    expect(await ds.manager.count(UserPermissionOverride, { where: { userId: a.hu.id } })).toBe(1);
  });
  it('无法识别人事部门时禁止预览和应用，不会悄悄缩减原权限', async () => {
    const a = await fixture(), plan = await svc.preview(a.actor);
    await ds.manager.update(Department, { companyId: a.company.id, name: '人事部' }, { name: '待核定部门' });
    await expect(svc.preview(a.actor)).rejects.toThrow(/未识别/);
    await expect(svc.apply(a.actor, plan.fingerprint)).rejects.toThrow(/未识别/);
    expect((await ds.manager.find(PositionPermission, { where: { positionId: a.hp.id } })).map((p) => p.permission)).toEqual(['live.manage']);
  });
  it('写审计失败时整批回滚，不产生半数岗位已更新的状态', async () => {
    const a = await fixture(), plan = await svc.preview(a.actor);
    // 强制事务最后一步失败，核对岗位和个人授权均回滚。
    const transaction = ds.transaction.bind(ds);
    const failing = new DeskAccessService({ transaction: (_isolation: unknown, fn: (em: unknown) => Promise<unknown>) => transaction('SERIALIZABLE', async (em) => {
      const originalSave = em.save.bind(em);
      const spy = jest.spyOn(em, 'save').mockImplementation(((target: unknown, ...args: unknown[]) => { if (target === AuditLog) throw new Error('audit unavailable'); return (originalSave as Function)(target, ...args); }) as never);
      try { return await fn(em); } finally { spy.mockRestore(); }
    }) } as unknown as DataSource);
    await expect(failing.apply(a.actor, plan.fingerprint)).rejects.toThrow('audit unavailable');
    expect((await ds.manager.find(PositionPermission, { where: { positionId: a.op.id } })).map((g) => g.permission)).toEqual(['finance.docs.post']);
    expect(await ds.manager.count(UserPermissionOverride, { where: { userId: a.worker.id } })).toBe(1);
  });
  async function cashierFixture() {
    const f = await fixture();
    const cashier = await ds.manager.save(Position, ds.manager.create(Position, { companyId: f.company.id, name: '财务出纳', departmentId: f.fp.departmentId, workspaceType: 'cashier', level: 'staff', status: 'active', sortOrder: 0 }));
    await ds.manager.save(PositionPermission, ds.manager.create(PositionPermission, { positionId: cashier.id, permission: 'finance.cash-bank.view' }));
    await ds.manager.update(User, f.worker.id, { positionId: cashier.id });
    await ds.manager.save(UserPermissionOverride, ds.manager.create(UserPermissionOverride, { userId: f.worker.id, permission: 'finance.session.remote', effect: 'deny' }));
    return { ...f, cashier };
  }
  it('补授出纳只增加当前公司三项权限，保留原授权、个人拒绝和其他岗位，重复应用无变化', async () => {
    const a = await cashierFixture(), b = await cashierFixture();
    const plan = await svc.previewCashier(a.actor);
    expect(plan.positions.map(p => p.id)).toEqual([a.cashier.id]);
    expect(plan.positions[0].removed).toEqual([]);
    expect(plan.positions[0].added).toEqual(cashierWithdrawalPermissions().sort());
    expect(await svc.applyCashier(a.actor, plan.fingerprint)).toEqual({ changedPositions: 1, changedStaff: 0 });
    expect((await ds.manager.findBy(PositionPermission, { positionId: a.cashier.id })).map(p => p.permission).sort()).toEqual(['finance.cash-bank.view', ...cashierWithdrawalPermissions()].sort());
    expect((await ds.manager.findBy(PositionPermission, { positionId: b.cashier.id })).map(p => p.permission)).toEqual(['finance.cash-bank.view']);
    expect((await ds.manager.findBy(PositionPermission, { positionId: a.fp.id })).map(p => p.permission)).toEqual(['finance.docs.post']);
    expect(await ds.manager.countBy(UserPermissionOverride, { userId: a.worker.id })).toBe(2);
    expect(await ds.manager.countBy(AuditLog, { companyId: a.company.id, action: 'position.cashier-withdrawal.grant' })).toBe(1);
    const again = await svc.previewCashier(a.actor);
    expect(again.changedPositions).toBe(0);
    expect(await svc.applyCashier(a.actor, again.fingerprint)).toEqual({ changedPositions: 0, changedStaff: 0 });
  });
  it('出纳补授拒绝非管理员及跨公司身份；岗位停用使旧预览失效', async () => {
    const a = await cashierFixture(), b = await cashierFixture();
    await expect(svc.previewCashier({ ...a.actor, id: a.worker.id })).rejects.toThrow(/仅公司管理员/);
    await expect(svc.previewCashier({ ...a.actor, companyId: b.company.id })).rejects.toThrow(/仅公司管理员/);
    await expect(svc.applyCashier({ ...a.actor, permissions: { isCompanyAdmin: false, allow: [], deny: [] } }, '0'.repeat(64))).rejects.toThrow(/仅公司管理员/);
    const plan = await svc.previewCashier(a.actor);
    await ds.manager.update(Position, a.cashier.id, { status: 'inactive' });
    await expect(svc.applyCashier(a.actor, plan.fingerprint)).rejects.toThrow(/重新预览/);
    expect((await svc.previewCashier(a.actor)).positions).toEqual([]);
    expect(await ds.manager.countBy(PositionPermission, { positionId: a.cashier.id })).toBe(1);
  });

});
