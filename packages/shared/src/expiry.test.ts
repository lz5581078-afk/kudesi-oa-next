import { describe, expect, it } from 'vitest';
import { EXPIRY_SOURCES, dueDateFor, nextAnnualOccurrence, nextMonthlyDay, nextQuarterEndDay, nextReconciliationDate } from './expiry';
import { RESOURCE_DEFS } from './resources';

describe('到期提醒规则（旧系统 expiring.js）', () => {
  it('登记的字段都存在于资料定义里', () => {
    for (const s of EXPIRY_SOURCES) {
      const def = RESOURCE_DEFS.find((d) => d.key === s.resource);
      expect(def, s.resource).toBeTruthy();
      expect(def!.fields.some((f) => f.key === s.field), `${s.resource}.${s.field}`).toBe(true);
      if (s.cycleField) expect(def!.fields.some((f) => f.key === s.cycleField), s.cycleField).toBe(true);
    }
  });
  it('年度循环日期：今年未过取今年，已过取明年，2 月 29 日平年落到 28 日', () => {
    expect(nextAnnualOccurrence('06-30', '2026-06-30')).toBe('2026-06-30');
    expect(nextAnnualOccurrence('06-29', '2026-06-30')).toBe('2027-06-29');
    expect(nextAnnualOccurrence('02-29', '2026-10-01')).toBe('2027-02-28');
    expect(nextAnnualOccurrence('13-01', '2026-10-01')).toBeNull();
  });
  it('每月/每季末月/对账日', () => {
    expect(nextMonthlyDay(31, '2026-02-10')).toBe('2026-02-28');
    expect(nextMonthlyDay(5, '2026-12-10')).toBe('2027-01-05');
    expect(nextQuarterEndDay(15, '2026-10-25')).toBe('2026-12-15');
    expect(nextQuarterEndDay(15, '2026-12-16')).toBe('2027-03-15');
    expect(nextReconciliationDate('monthly', '15', '2026-10-25')).toBe('2026-11-15');
    expect(nextReconciliationDate('quarterly', '15', '2026-10-25')).toBe('2026-12-15');
    expect(nextReconciliationDate('monthly', 'Q-END-20', '2026-10-25')).toBe('2026-12-20');
    expect(nextReconciliationDate('yearly', '03-31', '2026-10-25')).toBe('2027-03-31');
    expect(nextReconciliationDate('monthly', '', '2026-10-25')).toBeNull();
  });
  it('dueDateFor 按种类取日期', () => {
    const lic = EXPIRY_SOURCES.find((s) => s.field === 'annualAuditDay')!;
    expect(dueDateFor(lic, { annualAuditDay: '06-30' }, '2026-10-25')).toBe('2027-06-30');
    const q = EXPIRY_SOURCES.find((s) => s.resource === 'qualifications')!;
    expect(dueDateFor(q, { expiresAt: '2026-11-01' }, '2026-10-25')).toBe('2026-11-01');
    expect(dueDateFor(q, { expiresAt: '' }, '2026-10-25')).toBeNull();
  });
});
