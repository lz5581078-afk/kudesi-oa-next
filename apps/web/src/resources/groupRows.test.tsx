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

import { groupRowsByValue } from './groupRows';
describe('按文本字段分组（商标类别）', () => {
  const mk = (id: number, v?: string) => ({ id, type: 'trademarks', title: 't' + id, status: 'registered', data: v ? { classNo: v } : {}, refLabels: {} }) as never;
  it('类别按数字排，没填的排最后，同类别归一组', () => {
    const g = groupRowsByValue([mk(1, '第31类 饲料'), mk(2), mk(3, '第5类'), mk(4, '第31类 饲料')], 'classNo', '未分类', (r) => String((r as { data: { classNo?: string } }).data.classNo ?? ''));
    expect(g.map((x) => x.label)).toEqual(['第5类', '第31类 饲料', '未分类']);
    expect(g[1].rows.length).toBe(2);
    expect(g[1].value).toBe('第31类 饲料');
  });
});

describe('部门下再按服务商分小组（账号与服务备忘）', () => {
  const memo = (id: number, dept: number | undefined, provider: string) => ({ id, title: `备忘${id}`, data: { ...(dept === undefined ? {} : { ownerDeptId: dept }), provider }, refLabels: {} }) as unknown as ResourceDto;
  it('每个部门里按服务商拆成小组，组名“部门 · 服务商”，没填服务商的归“未设置”；没有部门的整体排最后', () => {
    const g = groupRowsByDept([memo(1, 2, '阿里云'), memo(2, 2, '腾讯云'), memo(3, 2, '阿里云'), memo(4, undefined, '七牛'), memo(5, 3, '')], 'ownerDeptId', '未分配部门', depts, 'provider');
    expect(g.map((x) => x.label)).toEqual(['总部 / 运营部 · 阿里云', '总部 / 运营部 · 腾讯云', '总部 / 财务部 · 未设置', '未分配部门 · 七牛']);
    expect(g[0].rows.map((r) => r.id)).toEqual([1, 3]);
    expect(new Set(g.map((x) => x.key)).size).toBe(4);
  });
});
