import { afterEach, describe, expect, it, vi } from 'vitest';
import { todayInChina } from './finance-documents';

afterEach(() => { vi.restoreAllMocks(); });
describe('北京时间日期在不同浏览器中保持 ISO 格式', () => {
  it.each([
    ['2026-11-02T15:59:59.999Z', '2026-11-02'],
    ['2026-11-02T16:00:00.000Z', '2026-11-03'],
    ['2026-12-31T16:00:00.000Z', '2027-01-01'],
    ['2024-02-28T16:00:00.000Z', '2024-02-29'],
    ['2024-02-29T16:00:00.000Z', '2024-03-01'],
    ['2025-02-28T16:00:00.000Z', '2025-03-01'],
    ['2026-10-31T16:00:00.000Z', '2026-11-01'],
  ])('%s → %s，按东八区换日', (instant, expected) => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(instant));
    expect(todayInChina()).toBe(expected);
  });
  it('浏览器缺少瑞典语日期包或Intl时也不依赖地区格式', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-02T01:00:00Z'));
    const locale = vi.spyOn(Date.prototype, 'toLocaleDateString').mockReturnValue('11/2/2026');
    const formatter = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => { throw new Error('locale unavailable'); });
    expect(todayInChina()).toBe('2026-11-02');
    expect(locale).not.toHaveBeenCalled();
    expect(formatter).not.toHaveBeenCalled();
  });
});
