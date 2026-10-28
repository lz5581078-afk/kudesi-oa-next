import { describe, expect, it } from 'vitest';
import {
  RESOURCE_DEFS, WORKFORCE_FILE_FIELDS, WORKFORCE_LOGIN_BLOCK, getResourceDef, validateResourceInput, validateWorkforceTerms,
  workforceCooperation, workforceHourlyCents, workforceLoginBlock, workforcePayText,
} from './index';

const today = '2026-10-28';

describe('兼职与临时工：合作状态与登录窗口', () => {
  it('结束日期当天仍在合作中，次日起已到期；开始日期当天起生效', () => {
    expect(workforceCooperation({ contractStartDate: '2026-10-01', contractEndDate: '2026-10-28' }, 'active', today)).toBe('working');
    expect(workforceCooperation({ contractStartDate: '2026-10-01', contractEndDate: '2026-10-27' }, 'active', today)).toBe('ended');
    expect(workforceCooperation({ contractStartDate: '2026-10-28' }, 'active', today)).toBe('working');
    expect(workforceCooperation({ contractStartDate: '2026-10-29' }, 'active', today)).toBe('pending');
    expect(workforceCooperation({ contractStartDate: '2026-09-01' }, 'active', today)).toBe('working'); // 兼职不限期
  });
  it('停用优先于日期；登录只拦已到期和待开始', () => {
    expect(workforceCooperation({ contractStartDate: '2026-10-01', contractEndDate: '2026-10-02' }, 'inactive', today)).toBe('inactive');
    expect(workforceLoginBlock({ contractStartDate: '2026-10-01', contractEndDate: '2026-10-02' }, 'active', today)).toBe(WORKFORCE_LOGIN_BLOCK.ended);
    expect(workforceLoginBlock({ contractStartDate: '2026-11-01' }, 'active', today)).toBe(WORKFORCE_LOGIN_BLOCK.pending);
    expect(workforceLoginBlock({ contractStartDate: '2026-10-01' }, 'active', today)).toBeNull();
    expect(workforceLoginBlock({ contractStartDate: '2026-10-01', contractEndDate: '2026-10-02' }, 'inactive', today)).toBeNull();
  });
});

describe('兼职与临时工：期限与单价校验', () => {
  const ok = { employmentType: 'temp', contractStartDate: '2026-11-01', contractEndDate: '2026-11-30', payRate: 20000 };
  it('合法输入通过', () => {
    expect(validateWorkforceTerms(ok)).toBeNull();
    expect(validateWorkforceTerms({ ...ok, employmentType: 'part_time', contractEndDate: '' })).toBeNull();
  });
  it('逐条拒绝旧系统拒绝的情形', () => {
    expect(validateWorkforceTerms({ ...ok, employmentType: 'regular' })).toMatch(/兼职或临时工/);
    expect(validateWorkforceTerms({ ...ok, contractStartDate: '2026-02-30' })).toMatch(/开始日期/);
    expect(validateWorkforceTerms({ ...ok, contractEndDate: undefined })).toMatch(/临时工必须填写合作结束日期/);
    expect(validateWorkforceTerms({ ...ok, contractEndDate: '2026-10-31' })).toMatch(/不能早于/);
    expect(validateWorkforceTerms({ ...ok, contractEndDate: '11/30' })).toMatch(/格式/);
    expect(validateWorkforceTerms({ ...ok, payRate: -1 })).toMatch(/单价/);
    expect(validateWorkforceTerms({ ...ok, payRate: 10_000_000 * 100 + 1 })).toMatch(/单价/);
  });
  it('只有计时且大于 0 才同步为时薪；计薪文字按方式带单位', () => {
    expect(workforceHourlyCents('hourly', 3500)).toBe(3500);
    expect(workforceHourlyCents('hourly', 0)).toBeNull();
    expect(workforceHourlyCents('daily', 20000)).toBeNull();
    expect(workforcePayText('daily', 20000)).toBe('200.00 元/天');
    expect(workforcePayText('hourly', undefined)).toBe('');
  });
});

describe('兼职与临时工：资料配置', () => {
  const def = getResourceDef('workforce')!;
  it('在“组织与人员”里，每人一条（按员工唯一），薪资字段要薪资权限，附件合计字段齐全', () => {
    expect(def.label).toBe('兼职与临时工');
    expect(def.nav?.group).toBe('组织与人员');
    expect(def.uniqueField).toBe('userId');
    for (const k of ['payMethod', 'payRate']) expect(def.fields.find((f) => f.key === k)?.permission).toBe('org.staff.salary');
    for (const k of WORKFORCE_FILE_FIELDS) expect(def.fields.find((f) => f.key === k)?.type).toBe('files');
    expect(RESOURCE_DEFS.filter((d) => d.key === 'workforce')).toHaveLength(1);
  });
  it('停用必须填原因，合作中不用', () => {
    expect(def.statuses.find((s) => s.value === 'inactive')?.requiresReason).toBe(true);
    expect(def.statuses.find((s) => s.value === 'active')?.requiresReason).toBeFalsy();
  });
  it('字段校验：员工、用工类型、开始日期必填（计薪方式按薪资权限可空）；单价是整数分；手机号规范化', () => {
    const bad = validateResourceInput(def, {}, { status: 'active' });
    for (const label of ['登录账号（员工）', '用工类型', '合作开始日期']) expect(bad.errors.some((e) => e.includes(label))).toBe(true);
    const good = validateResourceInput(def, { userId: 5, employmentType: 'temp', contractStartDate: '2026-11-01', contractEndDate: '2026-11-30', payMethod: 'daily', payRate: 20000, phone: '138-0000-0000' }, { status: 'active' });
    expect(good.errors).toEqual([]);
    expect(good.values.phone).toBe('13800000000');
    expect(validateResourceInput(def, { payRate: 12.5 }, { status: 'active' }).errors.some((e) => e.includes('单价'))).toBe(true);
  });
});
