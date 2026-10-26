import { describe, expect, it } from 'vitest';
import { freshnessTone } from './freshness';

describe('余额新旧分档', () => {
  const now = Date.parse('2026-10-26T12:00:00+08:00');
  const ago = (h: number) => new Date(now - h * 3_600_000).toISOString();
  it('按 1/2/3/7/15/30 天分档，没有记录是 unknown', () => {
    expect(freshnessTone(ago(2), now)).toBe('fresh');
    expect(freshnessTone(ago(24), now)).toBe('fresh');
    expect(freshnessTone(ago(30), now)).toBe('two-days');
    expect(freshnessTone(ago(60), now)).toBe('three-days');
    expect(freshnessTone(ago(24 * 5), now)).toBe('seven-days');
    expect(freshnessTone(ago(24 * 10), now)).toBe('fifteen-days');
    expect(freshnessTone(ago(24 * 20), now)).toBe('thirty-days');
    expect(freshnessTone(ago(24 * 40), now)).toBe('stale');
    expect(freshnessTone(null, now)).toBe('unknown');
    expect(freshnessTone('不是时间', now)).toBe('unknown');
    expect(freshnessTone(ago(-5), now)).toBe('fresh'); // 未来时间当刚更新
  });
});
