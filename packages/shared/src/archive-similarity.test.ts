import { describe, expect, it } from 'vitest';
import { archiveTextSimilarity, inspectArchiveSimilarity } from './archive-similarity';

const ex = (id: number, data: Record<string, unknown>) => ({ id, data });
describe('往来档案相似检测', () => {
  it('名称相似、电话相同给提示', () => {
    const r = inspectArchiveSimilarity({ name: '润农种业有限公司', phone: '13800000000' }, [ex(1, { name: '润农种业公司', phone: '13800000000' }), ex(2, { name: '别家', phone: '1' })]);
    expect(r.blocked).toHaveLength(0);
    expect(r.warnings.map((x) => x.id)).toEqual([1]);
    expect(r.warnings[0].warnings).toContain('联系电话相同');
  });
  it('编号或税号相同、已填字段全相同直接阻止；排除自己', () => {
    expect(inspectArchiveSimilarity({ name: 'A', code: 'GYS-1' }, [ex(1, { name: 'B', code: 'GYS-1' })]).blocked).toHaveLength(1);
    expect(inspectArchiveSimilarity({ name: '甲公司', phone: '1' }, [ex(1, { name: '甲公司', phone: '1', remark: 'x' })]).blocked).toHaveLength(1);
    expect(inspectArchiveSimilarity({ name: '甲公司', phone: '1' }, [ex(1, { name: '甲公司', phone: '1' })], 1).blocked).toHaveLength(0);
  });
  it('相似度算法', () => {
    expect(archiveTextSimilarity('abc 公司', 'ABC公司')).toBe(1);
    expect(archiveTextSimilarity('', 'x')).toBe(0);
  });
  it('原提示先排真正名称相似程度，再按名称；同电话的无关名称不挤掉完全同名项',()=>{
    const result=inspectArchiveSimilarity({name:'玉米原材料',phone:'0000001',code:'NEW'},[ex(1,{name:'阿凡达',phone:'0000001',code:'OLD-1'}),ex(2,{name:'玉米原材料',phone:'0000001',code:'OLD-2'})]);
    expect(result.warnings.map(row=>row.id)).toEqual([2,1]);
  });
});
