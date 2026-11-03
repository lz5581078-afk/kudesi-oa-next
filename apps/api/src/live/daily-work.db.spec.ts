import 'reflect-metadata';
import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import { StepDef } from '@kudesi/shared';
import { buildDataSourceOptions } from '../database/data-source';
import { AuthUser } from '../common/auth.decorators';
import { Company, Department, Notification, Position, User } from '../entities';
import { buildServices } from '../test-support';
import { FlowService } from '../flow/flow.service';
import { FinanceDocumentsService } from '../resources/finance-documents.service';
import { DailyWorkService } from './daily-work.service';
import {
  dailyRow,
  assertNoDailyWork,
  assertNoDailyPaidOverlap,
  assertNoLivePaidOverlap,
} from './daily-work-core';
import { liveClock } from './live-core';
import { LiveLedgerService } from './live-ledger.service';
import { LiveSettlementService } from './live-settlement.service';
import { UnconfiguredLiveOrderSource } from './live-order-source';
const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
const at = (s: string) => new Date(s.replace(' ', 'T') + '+08:00');
d('排班日常工作（真实MySQL）', () => {
  let ds: DataSource,
    service: DailyWorkService,
    flow: FlowService,
    boss: AuthUser,
    anchor: AuthUser,
    control: AuthUser,
    outsider: AuthUser,
    foreign: AuthUser,
    ledger: LiveLedgerService,
    payroll: LiveSettlementService;
  const original = liveClock.now,
    tag = randomBytes(4).toString('hex');
  const clock = (s: string) => {
    liveClock.now = () => at(s);
  };
  async function person(c: number, name: string, type: string, admin = false) {
    const pos = await ds.manager.save(Position, {
      companyId: c,
      name: type,
      workspaceType: type as never,
    });
    const u = await ds.manager.save(User, {
      companyId: c,
      name,
      account: `daily-${name}-${tag}`,
      passwordHash: 'x',
      positionId: pos.id,
      payType: 'hourly',
      hourlyRate: 6000,
      status: 'active',
      isCompanyAdmin: admin,
    });
    return {
      id: u.id,
      companyId: c,
      name,
      permissions: {
        isCompanyAdmin: admin,
        allow: ['features.live-desk.view'],
        deny: [],
      },
    } as AuthUser;
  }
  const schedule = (u: AuthUser, day: string, start = '09:00', end = '10:00') =>
    service.schedule(boss, {
      userId: u.id,
      role: u.id === control.id ? 'control' : 'anchor',
      startAt: `${day} ${start}:00`,
      endAt: `${day} ${end}:00`,
      content: '整理直播样品',
    });
  beforeAll(async () => {
    ds = await new DataSource({
      ...buildDataSourceOptions({
        ...process.env,
        DB_NAME: process.env.TEST_DB_NAME,
      }),
      migrationsRun: true,
    } as never).initialize();
    const c = await ds.manager.save(Company, {
      code: `daily${tag}`,
      name: '日常工作测试',
      status: 'active',
    });
    const f = await ds.manager.save(Company, {
      code: `foreignDaily${tag}`,
      name: '外公司日常',
      status: 'active',
    });
    boss = await person(c.id, '总经理', 'boss', true);
    anchor = await person(c.id, '主播', 'live_anchor');
    control = await person(c.id, '中控', 'live_control');
    outsider = await person(c.id, '运营', 'operations');
    foreign = await person(f.id, '他司', 'live_anchor', true);
    const dept = await ds.manager.save(Department, {
      companyId: c.id,
      name: '总经理',
    });
    await ds.manager.update(User, boss.id, { departmentId: dept.id });
    const built = buildServices(ds);
    flow = new FlowService(
      ds,
      built.resources,
      new FinanceDocumentsService(ds),
    );
    service = new DailyWorkService(ds, flow);
    ledger = new LiveLedgerService(ds);
    payroll = new LiveSettlementService(
      ds,
      flow,
      new UnconfiguredLiveOrderSource(),
    );
    for (const key of ['live-daily-work-review', 'live-settlement']) {
      const review = key === 'live-settlement' ? 'approve' : 'review';
      const steps: StepDef[] = [
        {
          key: 'apply',
          name: '提交',
          type: 'submit',
          assignee: { source: 'requester' },
        },
        {
          key: review,
          name: '审核',
          type: 'approval',
          assignee: { source: 'employee', id: boss.id },
        },
        { key: 'end', name: '结束', type: 'end' },
      ];
      await flow.saveDraft(boss, key, steps, []);
      await flow.publish(boss, key);
    }
  }, 120000);
  afterAll(async () => {
    liveClock.now = original;
    await ds?.destroy();
  });
  it('无排班、跨公司、非排班本人及无管理权限不能报；拒绝非主播中控、重叠排班', async () => {
    clock('2026-11-10 08:00:00');
    await expect(service.start(anchor, 99999999)).rejects.toThrow(/不存在/);
    await expect(
      service.schedule(anchor, {
        userId: anchor.id,
        role: 'anchor',
        startAt: '2026-11-10 09:00',
        endAt: '2026-11-10 10:00',
        content: '整理',
      }),
    ).rejects.toThrow(/权限/);
    await expect(schedule(outsider, '2026-11-10')).rejects.toThrow(
      /主播或中控/,
    );
    const r = await schedule(anchor, '2026-11-10');
    await expect(service.start(foreign, r.id)).rejects.toThrow(/不存在/);
    await expect(service.start(control, r.id)).rejects.toThrow(/本人/);
    await expect(schedule(anchor, '2026-11-10')).rejects.toThrow(/已有/);
    await expect(service.list(anchor, '2026-11-10')).rejects.toThrow(/权限/);
    expect((await service.list(control, '2026-11-10', true)).rows).toHaveLength(
      0,
    );
  });
  it('只能在排班时间内开始，含开始边界不含结束；开始后时薪冻结，实际计时独立', async () => {
    const r = (await service.list(anchor, '2026-11-10', true)).rows[0];
    clock('2026-11-10 08:59:59');
    await expect(service.start(anchor, r.id)).rejects.toThrow(/排班开始/);
    clock('2026-11-10 09:00:00');
    await service.start(anchor, r.id);
    await expect(service.start(anchor, r.id)).rejects.toThrow(/已开始/);
    await ds.manager.update(User, anchor.id, { hourlyRate: 9000 });
    clock('2026-11-10 09:30:00');
    await service.finish(anchor, r.id, '整理完成');
    const rec = await dailyRow(ds.manager, boss.companyId, r.id);
    expect(Number(rec.minutes)).toBe(30);
    expect(Number(rec.hourly_rate_cents)).toBe(6000);
    expect(Number(rec.amount_cents)).toBe(3000);
    const late = await schedule(control, '2026-11-10');
    clock('2026-11-10 10:00:00');
    await expect(service.start(control, late.id)).rejects.toThrow(/排班开始/);
  });
  it('超计划结束严格超过1小时才通知总经理，关闭页面仍扫描；重复与结束不重复通知', async () => {
    const r = await schedule(control, '2026-11-11');
    clock('2026-11-11 09:00:00');
    await service.start(control, r.id);
    clock('2026-11-11 11:00:00');
    await service.scan();
    expect(
      await ds.manager.count(Notification, {
        where: {
          companyId: boss.companyId,
          title: '日常工作超过排班结束时间1小时',
        },
      }),
    ).toBe(0);
    clock('2026-11-11 11:00:01');
    await Promise.all([service.scan(), service.scan()]);
    expect(
      await ds.manager.count(Notification, {
        where: {
          companyId: boss.companyId,
          userId: boss.id,
          title: '日常工作超过排班结束时间1小时',
        },
      }),
    ).toBe(1);
    await service.finish(control, r.id, '额外整理完成');
    await service.scan();
    expect(
      await ds.manager.count(Notification, {
        where: {
          companyId: boss.companyId,
          title: '日常工作超过排班结束时间1小时',
        },
      }),
    ).toBe(1);
  });
  it('多人可同时工作，但本人直播与日常工作互斥；未结束不能取消，取消后不能开始', async () => {
    const a = await schedule(anchor, '2026-11-12'),
      c = await schedule(control, '2026-11-12');
    clock('2026-11-12 09:00:00');
    await Promise.all([
      service.start(anchor, a.id),
      service.start(control, c.id),
    ]);
    await expect(
      ds.transaction((em) =>
        assertNoDailyWork(
          em,
          boss.companyId,
          [anchor.id],
          '2026-11-12 09:00:00',
        ),
      ),
    ).rejects.toThrow(/先结束/);
    await expect(service.cancel(boss, a.id, '取消')).rejects.toThrow(/未开始/);
    clock('2026-11-12 09:10:00');
    await service.finish(anchor, a.id, '整理完成');
    await service.finish(control, c.id, '整理完成');
    const cancelled = await schedule(anchor, '2026-11-13');
    await service.cancel(boss, cancelled.id, '工作调整');
    clock('2026-11-13 09:00:00');
    await expect(service.start(anchor, cancelled.id)).rejects.toThrow(/取消/);
  });
  it('审核按流程配置；核减必须说明原因，已审核日常工资可独立生成结算，不生成假场次或提成', async () => {
    const r = await schedule(anchor, '2026-11-14');
    clock('2026-11-14 09:00:00');
    await service.start(anchor, r.id);
    clock('2026-11-14 10:00:00');
    await service.finish(anchor, r.id, '样品归类完成');
    const submitted = await service.submit(anchor, r.id);
    let run = await flow.detail(boss, submitted.runId);
    await expect(
      flow.pass(boss, run.id, {
        revision: run.revision,
        stepId: run.activeStep!.id,
        form: { payMinutes: 30 },
      }),
    ).rejects.toThrow(/说明原因|原因/);
    run = await flow.detail(boss, submitted.runId);
    await flow.pass(boss, run.id, {
      revision: run.revision,
      stepId: run.activeStep!.id,
      form: { payMinutes: 30, wageNote: '含30分钟个人休息' },
    });
    const rec = await dailyRow(ds.manager, boss.companyId, r.id);
    expect(rec.status).toBe('approved');
    expect(Number(rec.minutes)).toBe(60);
    expect(Number(rec.approved_minutes)).toBe(30);
    expect(Number(rec.amount_cents)).toBe(4500);
    const wages = await ledger.wages(anchor, {
      from: '2026-11-14',
      to: '2026-11-14',
      role: 'anchor',
    });
    expect(wages.rows[0]).toMatchObject({
      dailyWorkId: r.id,
      amountCents: 4500,
      minutes: 30,
    });
    clock('2026-11-15 10:00:00');
    const settled = await payroll.generate(boss, '2026-11', '日常工资', {
      from: '2026-11-14',
      to: '2026-11-14',
    });
    const detail = await payroll.detail(boss, settled.id);
    expect(detail.payableTotalCents).toBe(4500);
    expect(detail.lines[0].dailyWorkId).toBe(r.id);
    expect(detail.byPerson[0].sessions).toBe(0);
    const pay = await payroll.submit(boss, settled.id);
    const payFlow = await flow.detail(boss, pay.runId);
    await flow.pass(boss, payFlow.id, {
      revision: payFlow.revision,
      stepId: payFlow.activeStep!.id,
      form: {},
    });
    expect((await payroll.detail(boss, settled.id)).status).toBe('approved');
    await expect(
      payroll.generate(boss, '2026-11', '重复', {
        from: '2026-11-14',
        to: '2026-11-14',
      }),
    ).rejects.toThrow(/已.*结算|结算完成/);
    const [counts] = await ds.query(
      'SELECT (SELECT COUNT(*) FROM live_sessions WHERE company_id=?) sessions,(SELECT COUNT(*) FROM live_commission_records WHERE company_id=?) commissions',
      [boss.companyId, boss.companyId],
    );
    expect(Number(counts.sessions) + Number(counts.commissions)).toBe(0);
  });
  it('审核退回可修改完成内容并重提，修改不改变原打卡和时薪；不能改为别人的记录', async () => {
    const r = await schedule(control, '2026-11-16');
    clock('2026-11-16 09:00:00');
    await service.start(control, r.id);
    clock('2026-11-16 09:30:00');
    await service.finish(control, r.id, '整理');
    let submitted = await service.submit(control, r.id),
      run = await flow.detail(boss, submitted.runId);
    await flow.returnBack(boss, run.id, {
      revision: run.revision,
      stepId: run.activeStep!.id,
      reason: '请写清完成内容',
    });
    await expect(
      service.updateReport(anchor, r.id, '冒充修改'),
    ).rejects.toThrow(/本人/);
    await service.updateReport(control, r.id, '设备清洁与样品归类完成');
    const before = await dailyRow(ds.manager, boss.companyId, r.id);
    submitted = await service.submit(control, r.id);
    run = await flow.detail(boss, submitted.runId);
    expect(String(run.payload.summary)).toContain('设备清洁与样品归类完成');
    await flow.pass(boss, run.id, {
      revision: run.revision,
      stepId: run.activeStep!.id,
      form: {},
    });
    const after = await dailyRow(ds.manager, boss.companyId, r.id);
    expect(after.actual_start_text).toBe(before.actual_start_text);
    expect(Number(after.hourly_rate_cents)).toBe(
      Number(before.hourly_rate_cents),
    );
    expect(after.status).toBe('approved');
  });
  it('人工修正工资也检查重叠；相邻工时不冲突，跨公司隔离', async () => {
    await expect(
      ds.transaction((em) =>
        assertNoDailyPaidOverlap(
          em,
          boss.companyId,
          anchor.id,
          '2026-11-14 09:15:00',
          '2026-11-14 09:45:00',
        ),
      ),
    ).rejects.toThrow(/重叠/);
    await ds.transaction((em) =>
      assertNoDailyPaidOverlap(
        em,
        boss.companyId,
        anchor.id,
        '2026-11-14 10:00:00',
        '2026-11-14 11:00:00',
      ),
    );
    await ds.transaction((em) =>
      assertNoDailyPaidOverlap(
        em,
        foreign.companyId,
        anchor.id,
        '2026-11-14 09:00:00',
        '2026-11-14 10:00:00',
      ),
    );
    await ds.query(
      "INSERT INTO live_wage_records(company_id,session_id,user_id,session_date,start_at,end_at,minutes,hourly_rate_cents,rate_source,amount_cents,approved_by,approved_at) VALUES(?,999999,?,'2026-11-17','2026-11-17 09:00:00','2026-11-17 10:00:00',60,6000,'manual',6000,?,'2026-11-18 10:00:00')",
      [boss.companyId, anchor.id, boss.id],
    );
    await expect(
      ds.transaction((em) =>
        assertNoLivePaidOverlap(
          em,
          boss.companyId,
          anchor.id,
          '2026-11-17 09:30:00',
          '2026-11-17 10:30:00',
        ),
      ),
    ).rejects.toThrow(/重叠/);
    await ds.transaction((em) =>
      assertNoLivePaidOverlap(
        em,
        boss.companyId,
        anchor.id,
        '2026-11-17 10:00:00',
        '2026-11-17 11:00:00',
      ),
    );
  });
});
