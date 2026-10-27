import { describe, expect, it } from 'vitest';
import { dueHint, dwell } from './flowUi';

const NOW = new Date('2026-01-10T12:00:00Z').getTime();

describe('到期提示', () => {
  it('没有截止时间是不限时', () => {
    expect(dueHint(null, NOW)).toEqual({ text: '不限时', late: false });
  });
  it('未到期按分钟、小时、天说明还剩多久', () => {
    expect(dueHint('2026-01-10T12:30:00Z', NOW)).toEqual({ text: '30 分钟后截止', late: false });
    expect(dueHint('2026-01-10T17:00:00Z', NOW)).toEqual({ text: '5 小时后截止', late: false });
    expect(dueHint('2026-01-14T12:00:00Z', NOW)).toEqual({ text: '4 天后截止', late: false });
  });
  it('已超时标红并说明超了多久', () => {
    expect(dueHint('2026-01-10T09:00:00Z', NOW)).toEqual({ text: '已超时 3 小时', late: true });
    expect(dueHint('2026-01-07T12:00:00Z', NOW).text).toBe('已超时 3 天');
  });
  it('步骤停留时间', () => {
    expect(dwell('2026-01-10T11:59:40Z', NOW)).toBe('刚刚');
    expect(dwell('2026-01-10T11:00:00Z', NOW)).toBe('1 小时');
    expect(dwell('2026-01-05T12:00:00Z', NOW)).toBe('5 天');
    expect(dwell(null, NOW)).toBe('');
  });
});
