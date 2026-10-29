import { describe, expect, it } from 'vitest';
import { broadbandExpiry, monthlyEquivalentCents, nextRechargeDate, parentLinkProblem, rechargeState } from './fees';

describe('折算月均', () => {
  it('月=原值，季÷3，半年÷6，年÷12，缺省按月', () => {
    expect(monthlyEquivalentCents(3000, 'monthly')).toBe(3000);
    expect(monthlyEquivalentCents(9000, 'quarterly')).toBe(3000);
    expect(monthlyEquivalentCents(18000, 'halfyear')).toBe(3000);
    expect(monthlyEquivalentCents(36000, 'yearly')).toBe(3000);
    expect(monthlyEquivalentCents(3000, undefined)).toBe(3000);
  });
  it('结果是整数分，四舍五入', () => {
    expect(monthlyEquivalentCents(10000, 'quarterly')).toBe(3333);
    expect(monthlyEquivalentCents(20000, 'quarterly')).toBe(6667);
    expect(Number.isInteger(monthlyEquivalentCents(12345, 'yearly'))).toBe(true);
  });
  it('自定义周期按天数 ×30÷天数；没有天数算不出', () => {
    expect(monthlyEquivalentCents(6000, 'custom', 60)).toBe(3000);
    expect(monthlyEquivalentCents(1000, 'custom', 45)).toBe(667);
    expect(monthlyEquivalentCents(6000, 'custom', null)).toBeNull();
  });
  it('没有金额返回 null，0 元是 0', () => {
    expect(monthlyEquivalentCents(null, 'monthly')).toBeNull();
    expect(monthlyEquivalentCents(undefined, 'yearly')).toBeNull();
    expect(monthlyEquivalentCents(0, 'yearly')).toBe(0);
  });
});

describe('下次充值日', () => {
  it('有最后充值日：加充值周期，缺省 30 天', () => {
    expect(nextRechargeDate({ lastRechargeAt: '2026-10-01', rechargeCycleDays: 30 })).toBe('2026-10-31');
    expect(nextRechargeDate({ lastRechargeAt: '2026-10-01' })).toBe('2026-10-31');
    expect(nextRechargeDate({ lastRechargeAt: '2026-01-31', rechargeCycleDays: 90 })).toBe('2026-05-01');
  });
  it('最后充值日优先于旧的下次充值日；都没有才用旧值', () => {
    expect(nextRechargeDate({ lastRechargeAt: '2026-10-01', rechargeCycleDays: 10, nextRechargeAt: '2026-12-01' })).toBe('2026-10-11');
    expect(nextRechargeDate({ nextRechargeAt: '2026-07-05' })).toBe('2026-07-05');
    expect(nextRechargeDate({})).toBeNull();
  });
});

describe('到期与逾期状态', () => {
  it('充值：逾期 / 7 天内 / 正常 / 未排期', () => {
    expect(rechargeState('2026-10-27', '2026-10-28')).toEqual({ state: 'overdue', days: -1 });
    expect(rechargeState('2026-10-28', '2026-10-28')).toEqual({ state: 'soon', days: 0 });
    expect(rechargeState('2026-11-04', '2026-10-28')).toEqual({ state: 'soon', days: 7 });
    expect(rechargeState('2026-11-05', '2026-10-28').state).toBe('ok');
    expect(rechargeState(null, '2026-10-28').state).toBe('none');
  });
  it('宽带：已到期 / 30 天内 / 正常', () => {
    expect(broadbandExpiry('2026-10-01', '2026-10-28').state).toBe('expired');
    expect(broadbandExpiry('2026-11-27', '2026-10-28').state).toBe('soon');
    expect(broadbandExpiry('2026-11-28', '2026-10-28').state).toBe('ok');
    expect(broadbandExpiry('', '2026-10-28').state).toBe('none');
  });
});

describe('主子卡只允许两级', () => {
  const main = { id: 1, parentPhoneId: undefined };
  it('合法：选一张正常的主卡', () => {
    expect(parentLinkProblem({ selfId: 2, parent: main, selfChildCount: 0 })).toBeNull();
    expect(parentLinkProblem({ selfId: 2, parent: null, selfChildCount: 3 })).toBeNull();
  });
  it('不能选自己、不能选子卡、有子卡的不能再当子卡、停用的主卡不能新挂', () => {
    expect(parentLinkProblem({ selfId: 1, parent: main, selfChildCount: 0 })).toMatch(/自己/);
    expect(parentLinkProblem({ selfId: 3, parent: { id: 2, parentPhoneId: 1 }, selfChildCount: 0 })).toMatch(/两级/);
    expect(parentLinkProblem({ selfId: 3, parent: main, selfChildCount: 2 })).toMatch(/2 张子卡/);
    expect(parentLinkProblem({ selfId: 3, parent: { id: 1, stopped: true }, selfChildCount: 0 })).toMatch(/停止使用/);
  });
});
