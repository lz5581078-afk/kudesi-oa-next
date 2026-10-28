import { describe, expect, it } from 'vitest';
import { getResourceDef } from './resources';

describe('字段找回 A 组：24 号旧版信息结构', () => {
  it('税务资料详情四个分区，月营业额和关联店铺数并进“报税与经营”', () => {
    const d = getResourceDef('tax-profiles')!;
    expect([...new Set(d.fields.map((f) => f.group))]).toEqual(['基础税务信息', '报税与经营', '开票与银行', '联系人与备注']);
    expect(d.derivedColumns?.every((c) => c.group === '报税与经营')).toBe(true);
  });
  it('商标资料分区与四块快捷页签', () => {
    const d = getResourceDef('trademarks')!;
    expect([...new Set(d.fields.map((f) => f.group))]).toEqual(['商标基础资料', '申请与注册进度', '资料附件']);
    expect(d.quickTabs?.map((t) => t.label)).toEqual(['申请中', '已申请', '不可用', '合作商标']);
    expect(d.statuses.find((s) => s.value === 'partial_passed')?.label).toBe('部分通过（无效）');
  });
  it('营业执照补回营业期限起，资质列表带审核联系方式和平台账号', () => {
    expect(getResourceDef('licenses')!.fields.some((f) => f.key === 'termStartAt')).toBe(true);
    const q = getResourceDef('qualifications')!;
    for (const k of ['reviewContact', 'platformAccount', 'attachments']) expect(q.fields.find((f) => f.key === k)?.list).toBe(true);
  });
});
