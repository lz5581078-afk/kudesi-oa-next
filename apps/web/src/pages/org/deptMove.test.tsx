import { describe, expect, it } from 'vitest';
import { planMove } from './deptMove';
import type { DepartmentNode } from './orgApi';

const n = (id: number, sortOrder: number, children: DepartmentNode[] = []): DepartmentNode => ({ id, name: `D${id}`, sortOrder, status: 'active', children });
const tree = [n(1, 10, [n(11, 10), n(12, 20)]), n(2, 20), n(3, 30)];

describe('部门拖拽调整', () => {
  it('同级放到前面：只改变动的顺序', () => {
    const r = planMove(tree, 3, 1, 'before');
    expect(r).toEqual({ updates: [{ id: 3, parentId: null, sortOrder: 10 }, { id: 1, parentId: null, sortOrder: 20 }, { id: 2, parentId: null, sortOrder: 30 }] });
  });
  it('拖进另一个部门里成为子部门，排在最后', () => {
    expect(planMove(tree, 2, 1, 'inside')).toEqual({ updates: [{ id: 2, parentId: 1, sortOrder: 30 }] });
  });
  it('不能拖进自己的下级或自己', () => {
    expect(planMove(tree, 1, 11, 'inside')).toEqual({ error: '不能把部门移到它自己的下级里' });
    expect(planMove(tree, 2, 2, 'before')).toEqual({ error: '不能拖到自己上面' });
  });
  it('放回原位不产生更新；子部门拖到顶层', () => {
    expect(planMove(tree, 2, 3, 'before')).toEqual({ updates: [] });
    expect(planMove(tree, 11, 3, 'after')).toEqual({ updates: [{ id: 11, parentId: null, sortOrder: 40 }] });
  });
});
