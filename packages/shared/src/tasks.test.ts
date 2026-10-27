import { describe, expect, it } from 'vitest';
import { dueEndOfDay, routineMatches, validateFeedback, validateRoutine, weekdayOf } from './tasks';

describe('周期任务', () => {
  it('周几按日历日期算', () => {
    expect(weekdayOf('2026-10-25')).toBe(7); // 周日
    expect(weekdayOf('2026-10-26')).toBe(1);
  });
  it('每天/每周/每月是否今天生成', () => {
    expect(routineMatches({ frequency: 'daily' }, '2026-02-03')).toBe(true);
    expect(routineMatches({ frequency: 'weekly', weekday: 1 }, '2026-10-26')).toBe(true);
    expect(routineMatches({ frequency: 'weekly', weekday: 1 }, '2026-10-27')).toBe(false);
    expect(routineMatches({ frequency: 'monthly', monthDay: 5 }, '2026-11-05')).toBe(true);
    expect(routineMatches({ frequency: 'monthly', monthDay: 5 }, '2026-11-06')).toBe(false);
  });
  it('校验：每月只能 1–28 号；期限 1–30 天', () => {
    expect(validateRoutine({ frequency: 'monthly', monthDay: 31 }, '对账', 1)).toHaveLength(1);
    expect(validateRoutine({ frequency: 'weekly' }, '盘点', 1)).toHaveLength(1);
    expect(validateRoutine({ frequency: 'daily' }, '', 0)).toHaveLength(2);
    expect(validateRoutine({ frequency: 'daily' }, '检查库存', 1)).toEqual([]);
  });
  it('截止时间是北京时间当天（或第 N 天）的 23:59:59', () => {
    expect(dueEndOfDay('2026-10-25', 1).toISOString()).toBe('2026-10-25T15:59:59.000Z');
    expect(dueEndOfDay('2026-10-25', 3).toISOString()).toBe('2026-10-27T15:59:59.000Z');
  });
});

describe('任务反馈校验', () => {
  it('至少填一项；数字、选项、未知字段都要拦住', () => {
    expect(validateFeedback('simple', {})).toEqual(['请至少填写一项反馈内容']);
    expect(validateFeedback('simple', { result: '已处理' })).toEqual([]);
    expect(validateFeedback('operation_daily', { salesAmount: 'abc' })).toEqual(['销售额要填数字']);
    expect(validateFeedback('phone_check', { isConnected: '不知道' })).toEqual(['是否畅通请从选项里选']);
    expect(validateFeedback('simple', { result: 'x', evil: '1' })).toEqual(['没有“evil”这个反馈项']);
    expect(validateFeedback('nope', { a: 1 })).toEqual(['反馈模板不存在']);
  });
});
