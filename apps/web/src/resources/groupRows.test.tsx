import { describe, expect, it } from 'vitest';
import type { ResourceDto } from './api';
import { groupRowsByDept } from './groupRows';

const row = (id: number, dept?: number, label?: string) => ({ id, title: `组${id}`, data: dept === undefined ? {} : { departmentId: dept }, refLabels: label ? { departmentId: label } : {} }) as unknown as ResourceDto;
const depts = [{ id: 1, name: '总部', parentId: null }, { id: 2, name: '运营部', parentId: 1 }, { id: 3, name: '财务部', parentId: 1 }, { id: 4, name: '抖音组', parentId: 2 }];

describe('职责组按部门分组', () => {
  it('按部门树先序排列，下级缩进，没填部门的排最后叫“未分类”', () => {
    const g = groupRowsByDept([row(1), row(2, 3), row(3, 4), row(4, 2), row(5, 3)], 'departmentId', '未分类', depts);
    expect(g.map((x) => x.label)).toEqual(['总部 / 运营部', '总部 / 运营部 / 抖音组', '总部 / 财务部', '未分类']);
    expect(g.map((x) => x.depth)).toEqual([1, 2, 1, 0]);
    expect(g[2].rows.map((r) => r.id)).toEqual([2, 5]);
    expect(g[2].refId).toBe(3);
    expect(g[3].refId).toBeUndefined();
  });
  it('部门已不在目录里时用记录自带的名称，不丢记录', () => {
    const g = groupRowsByDept([row(1, 99, '已撤销部')], 'departmentId', '未分类', depts);
    expect(g).toHaveLength(1);
    expect(g[0].label).toBe('已撤销部');
  });
  it('没有“未分类”记录时不出现空分组', () => {
    expect(groupRowsByDept([row(1, 2)], 'departmentId', '未分类', depts).map((x) => x.label)).toEqual(['总部 / 运营部']);
  });
});
