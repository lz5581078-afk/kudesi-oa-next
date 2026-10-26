import { buildDepartmentTree } from './org.service';

describe('部门树', () => {
  it('按 parentId 组装并按排序号排序', () => {
    const tree = buildDepartmentTree([
      { id: 3, parentId: 1, name: '运营二组', sortOrder: 2 },
      { id: 1, parentId: null, name: '运营', sortOrder: 0 },
      { id: 2, parentId: 1, name: '运营一组', sortOrder: 1 },
      { id: 4, parentId: null, name: '财务', sortOrder: 1 },
    ]);
    expect(tree.map((n) => n.name)).toEqual(['运营', '财务']);
    expect(tree[0].children.map((n) => n.name)).toEqual(['运营一组', '运营二组']);
  });

  it('父节点缺失时当作根节点，不丢数据', () => {
    const tree = buildDepartmentTree([{ id: 9, parentId: 404, name: '孤儿', sortOrder: 0 }]);
    expect(tree.map((n) => n.name)).toEqual(['孤儿']);
  });
});
