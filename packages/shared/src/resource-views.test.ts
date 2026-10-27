import { describe, expect, it } from 'vitest';
import { dueBadgeFor, jushuitanDue, normalizePhoneImportText } from './index';

describe('店铺与账号的实时到期视图', () => {
  const t = '2026-10-27';
  it('聚水潭三级：过期 / 15 天内 / 30 天内 / 未连接不算', () => {
    expect(jushuitanDue({ jushuitan: 'connected', jushuitanExpireAt: '2026-10-24' }, t)).toMatchObject({ level: 'expired', text: '已过期 3 天' });
    expect(jushuitanDue({ jushuitan: 'connected', jushuitanExpireAt: '2026-10-27' }, t)).toMatchObject({ level: 'urgent', text: '今天到期' });
    expect(jushuitanDue({ jushuitan: 'connected', jushuitanExpireAt: '2026-11-11' }, t)?.level).toBe('urgent');
    expect(jushuitanDue({ jushuitan: 'connected', jushuitanExpireAt: '2026-11-12' }, t)?.level).toBe('soon');
    expect(jushuitanDue({ jushuitan: 'connected', jushuitanExpireAt: '2026-11-27' }, t)).toBeNull();
    expect(jushuitanDue({ jushuitan: 'not_connected', jushuitanExpireAt: '2026-10-01' }, t)).toBeNull();
  });
  it('备忘/手机号到期提示：停用不提示', () => {
    expect(dueBadgeFor('memos', 'endAt', { endAt: '2026-10-20' }, 'normal', t)?.level).toBe('expired');
    expect(dueBadgeFor('memos', 'endAt', { endAt: '2026-10-20' }, 'inactive', t)).toBeNull();
    expect(dueBadgeFor('phones', 'nextRechargeAt', { nextRechargeAt: '2026-11-03' }, 'normal', t)?.level).toBe('urgent');
    expect(dueBadgeFor('phones', 'nextRechargeAt', { nextRechargeAt: '2026-11-04' }, 'normal', t)).toBeNull();
  });
  it('手机号导入文本还原：公式、.0、科学计数法', () => {
    expect(normalizePhoneImportText('="13800138000"')).toBe('13800138000');
    expect(normalizePhoneImportText('13800138000.0')).toBe('13800138000');
    expect(normalizePhoneImportText('1.3800138E+10')).toBe('13800138000');
    expect(normalizePhoneImportText('138-0013 8000')).toBe('13800138000');
  });
});
