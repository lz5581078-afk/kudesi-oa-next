import { describe, expect, it } from 'vitest';
import { DEFAULT_SUPERVISION_RULES, caseStage, dueState, escalationLevel, parseAfterSalesText } from './service-cases';
import { FLOW_TEMPLATES, validatePostingDecl, validateSteps } from './flow';
import { NAV_SECTIONS } from './navigation';
import { permissionCatalog } from './permission-catalog';

describe('售后与申诉的共用规则', () => {
  it('文字预填：认订单号、类型、金额、原因；认不出的留空', () => {
    expect(parseAfterSalesText('订单 DD202606270001 买家申请退货退款 金额 328 原因 尺寸不合适')).toMatchObject({ orderNo: 'DD202606270001', caseType: 'return_refund', amountCents: 32800, reason: '尺寸不合适' });
    expect(parseAfterSalesText('单号 JD12345678 仅退款 ¥59.9 物流异常')).toMatchObject({ orderNo: 'JD12345678', caseType: 'refund_only', amountCents: 5990, reason: '物流异常' });
    expect(parseAfterSalesText('买家要换货 订单 9988776655').caseType).toBe('exchange');
    expect(parseAfterSalesText('你好')).toEqual({ orderNo: '', caseType: 'other', amountCents: null, reason: '你好' });
  });

  it('剩余时间：超时/即将到期/充裕/已办结/不限时', () => {
    const now = Date.parse('2026-10-27T08:00:00Z');
    expect(dueState('2026-10-27T05:00:00Z', true, now)).toEqual({ text: '已超时 3 小时', tone: 'late' });
    expect(dueState('2026-10-27T12:00:00Z', true, now)).toEqual({ text: '还剩 4 小时', tone: 'soon' });
    expect(dueState('2026-10-29T12:00:00Z', true, now)).toEqual({ text: '还剩 2 天', tone: 'ok' });
    expect(dueState('2026-10-27T08:20:00Z', true, now).text).toBe('还剩 20 分钟');
    expect(dueState('2026-10-01T00:00:00Z', false, now)).toEqual({ text: '已办结', tone: 'done' });
    expect(dueState(null, true, now)).toEqual({ text: '不限时', tone: 'none' });
  });

  it('阶段由流程状态和当前步骤推出', () => {
    expect(caseStage('after-sales', 'running', 'handle')).toBe('handling');
    expect(caseStage('after-sales', 'running', 'review')).toBe('reviewing');
    expect(caseStage('after-sales', 'running', 'apply')).toBe('returned');
    expect(caseStage('after-sales', 'completed', null)).toBe('completed');
    expect(caseStage('order-appeal', 'running', 'submit')).toBe('to_submit');
    expect(caseStage('order-appeal', 'running', 'result')).toBe('submitted');
    expect(caseStage('order-appeal', 'rejected', null)).toBe('rejected');
    expect(caseStage('order-appeal', 'cancelled', null)).toBe('cancelled');
  });

  it('逾期升级：员工 → 主管 → 老板', () => {
    const rule = { supervisorVisibleMinutes: 60, bossVisibleMinutes: 1440 };
    expect(escalationLevel(10, rule)).toBe(1);
    expect(escalationLevel(60, rule)).toBe(2);
    expect(escalationLevel(1440, rule)).toBe(3);
    expect(escalationLevel(0, { supervisorVisibleMinutes: 0, bossVisibleMinutes: 1440 })).toBe(2);
  });

  it('默认监督规则每类一条，老板默认 1440 分钟可见、关闭要写原因（沿用旧系统）', () => {
    expect(DEFAULT_SUPERVISION_RULES.map((r) => r.targetType)).toEqual(['after_sales', 'appeal', 'flow', 'task']);
    expect(DEFAULT_SUPERVISION_RULES.every((r) => r.bossVisibleMinutes === 1440 && r.closeRequiresReason)).toBe(true);
  });

  it('流程模板合法；业务流程步骤受保护；入口页面登记在导航里', () => {
    for (const key of ['after-sales', 'order-appeal']) {
      const t = FLOW_TEMPLATES.find((x) => x.key === key)!;
      expect(validatePostingDecl(t)).toEqual([]);
      const filled = t.steps.map((s) => (s.type === 'submit' || s.type === 'end' ? s : { ...s, assignee: { source: 'employee' as const, id: 1 } }));
      expect(validateSteps(t, filled)).toEqual([]);
      expect(validateSteps(t, filled.filter((s) => s.key !== t.steps[1].key)).join()).toContain('缺少业务必须的步骤');
      const pages = NAV_SECTIONS.flatMap((s) => s.pages.map((p) => p.path));
      expect(pages).toContain(t.entry!.path);
    }
  });

  it('导航：售后、监督分区和页面权限键在权限目录里', () => {
    const sections = NAV_SECTIONS.map((s) => s.id);
    expect(sections).toEqual(expect.arrayContaining(['after-sales', 'supervision']));
    const keys = permissionCatalog().flatMap((g) => g.items.map((i) => i.key));
    expect(keys).toEqual(expect.arrayContaining(['after-sales.table.view', 'after-sales.appeals.view', 'supervision.center.view', 'supervision.manage']));
  });
});
