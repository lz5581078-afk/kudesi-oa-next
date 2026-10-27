import { describe, expect, it } from 'vitest';
import { normalizeReconcileDay } from './reminders';

describe('对账提醒日录入', () => {
  it('规范化：季度写成 Q-END-N，年 MM-DD，月 1-31', () => {
    expect(normalizeReconcileDay('quarterly', '15').value).toBe('Q-END-15');
    expect(normalizeReconcileDay('quarterly', 'q-end-3').value).toBe('Q-END-3');
    expect(normalizeReconcileDay('quarterly', '03-15').value).toBe('03-15');
    expect(normalizeReconcileDay('yearly', '2-3').error).toBeTruthy();
    expect(normalizeReconcileDay('monthly', '32').error).toBeTruthy();
    expect(normalizeReconcileDay('monthly', '').value).toBeUndefined();
  });
});
