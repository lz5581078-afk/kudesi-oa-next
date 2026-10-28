/** 迁移适配器：兼职与临时工档案（假旧库） */
import { FakeOut, readFakeLegacy } from './fake-legacy';

const emp = (id: number, extra: Record<string, unknown> = {}) => ({ id, department_id: 1, name: `人${id}`, status: 'active', employment_type: 'part_time', ...extra });
const profile = (id: number, extra: Record<string, unknown> = {}) => ({ employee_id: id, pay_method: 'hourly', pay_rate: '0.00', contract_start_date: '2026-10-14', contract_end_date: null, remark: null, ...extra });

describe('迁移适配器：兼职与临时工', () => {
  let out: FakeOut & { records: Array<{ type: string; id: string; data: Record<string, unknown>; status: string; notices?: string[]; files?: Array<{ field: string; name: string }> }> };
  beforeAll(async () => {
    out = (await readFakeLegacy({
      companies: [{ id: 7, name: '测试公司' }],
      employees: [emp(61), emp(62, { employment_type: 'temp' }), emp(63, { status: 'inactive' }), emp(64)],
      employee_workforce_profiles: [
        profile(61, { pay_rate: '12.50', phone: '138-0000-0000', work_location: 'A 区', remark: '周末班' }),
        profile(62, { pay_method: 'daily', pay_rate: '200.00', contract_end_date: '2026-12-31' }),
        profile(63),
        profile(64, { pay_rate: '1.005' }),
        profile(99),
      ],
      employee_workforce_attachments: [
        { id: 1, company_id: 7, employee_id: 61, category: 'contract', file_name: '合同.pdf', mime_type: 'application/pdf', file_size: 10, storage_path: 'wf/1.pdf', sha256: 'a' },
        { id: 2, company_id: 7, employee_id: 61, category: 'identity', file_name: '身份证.jpg', mime_type: 'image/jpeg', file_size: 10, storage_path: 'wf/2.jpg', sha256: 'b' },
      ],
    })) as never;
  });
  type Rec = { type: string; id: string; data: Record<string, unknown>; status: string; files?: Array<{ field: string; name: string }> };
  const wf = () => (out.records as Rec[]).filter((r) => r.type === 'workforce');
  const one = (id: string) => wf().find((r) => r.id === id)!;

  it('每个档案以员工编号为来源编号；用工类型、姓名取自员工；员工引用走用户映射', () => {
    expect(one('61').data).toMatchObject({ name: '人61', employmentType: 'part_time', userId: { legacyRef: { type: 'user', id: '61' } }, payMethod: 'hourly', payRate: 1250, phone: '138-0000-0000', workLocation: 'A 区', note: '周末班', contractStartDate: '2026-10-14' });
    expect(one('62').data).toMatchObject({ employmentType: 'temp', payMethod: 'daily', payRate: 20000, contractEndDate: '2026-12-31' });
  });

  it('员工已停用 → 档案停用；其余合作中', () => {
    expect(one('63').status).toBe('inactive');
    expect(one('61').status).toBe('active');
  });

  it('单价精度超范围的整条不迁、不舍入，记入待核对；员工不在迁入范围的档案不迁', () => {
    expect(wf().some((r) => r.id === '64')).toBe(false); // 整条不迁，不舍入
    expect(out.exclusions.some((e) => e.type === 'workforce' && e.id === '64' && /金额精度/.test(e.reason))).toBe(true);
    expect(wf().some((r) => r.id === '99')).toBe(false);
    expect(out.exclusions.some((e) => e.type === 'workforce' && e.id === '99')).toBe(true);
  });

  it('附件按分类放进对应的附件字段', () => {
    const files = one('61').files ?? [];
    expect(files.map((f) => `${f.field}:${f.name}`).sort()).toEqual(['contractFiles:合同.pdf', 'identityFiles:身份证.jpg']);
    expect(one('62').files ?? []).toEqual([]);
  });
});
