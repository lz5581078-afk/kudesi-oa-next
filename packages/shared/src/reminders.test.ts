import { describe, expect, it } from 'vitest';
import { nextAnnualOccurrence, nextReconciliationDate, normalizeReconcileDay } from './reminders';

describe('周期提醒日', () => {
  it('年审 MM-DD 取今天或之后第一次，2 月 29 日平年落到 28 日', () => {
    expect(nextAnnualOccurrence('03-20', '2026-03-20')).toBe('2026-03-20');
    expect(nextAnnualOccurrence('03-20', '2026-10-27')).toBe('2027-03-20');
    expect(nextAnnualOccurrence('02-29', '2026-10-27')).toBe('2027-02-28');
    expect(nextAnnualOccurrence('13-01', '2026-10-27')).toBeNull();
  });
  it('对账：月、季度末月第 N 天、年', () => {
    expect(nextReconciliationDate('monthly', '15', '2026-10-27')).toBe('2026-11-15');
    expect(nextReconciliationDate('quarterly', 'Q-END-15', '2026-10-27')).toBe('2026-12-15');
    expect(nextReconciliationDate('quarterly', 'Q-END-31', '2026-02-01')).toBe('2026-03-31');
    expect(nextReconciliationDate('quarterly', 'Q-END-31', '2026-06-30')).toBe('2026-06-30');
    expect(nextReconciliationDate('yearly', '12-01', '2026-12-02')).toBe('2027-12-01');
  });
  it('提醒日规范化', () => {
    expect(normalizeReconcileDay('quarterly', '15').value).toBe('Q-END-15');
    expect(normalizeReconcileDay('quarterly', 'q-end-3').value).toBe('Q-END-3');
    expect(normalizeReconcileDay('yearly', '2-3').error).toBeTruthy();
    expect(normalizeReconcileDay('monthly', '').value).toBeUndefined();
  });
});
