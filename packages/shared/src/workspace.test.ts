import { describe, expect, it } from 'vitest';
import { DESK_DEFS, deskFor, deskLinks, groupDeskPositions, navPageByKey, taskStage, TASK_VIEWS, type DeskPosition } from './workspace';
import { LEGACY_WORKSPACE_TEMPLATE_MAP } from './position-templates';
import { permissionCatalog } from './permission-catalog';

describe('岗位工作台定义', () => {
  it('每种岗位类型都有定义，常用业务入口全部指向导航里真实、已完成的页面（不另造路径）', () => {
    const types = new Set(Object.values(LEGACY_WORKSPACE_TEMPLATE_MAP));
    for (const t of types) expect(DESK_DEFS[t]).toBeTruthy();
    for (const def of Object.values(DESK_DEFS)) {
      for (const key of [...def.links, ...(def.managerLinks ?? [])]) expect(navPageByKey(key), `${def.type}: ${key}`).not.toBeNull();
    }
  });
  it('入口按权限过滤并去重；主管级岗位多出管理入口；未知类型按空白处理', () => {
    const all = () => true;
    const staff = deskLinks(DESK_DEFS.finance, 'staff', all).map((p) => p.id);
    const mgr = deskLinks(DESK_DEFS.finance, 'manager', all).map((p) => p.id);
    expect(mgr.length).toBeGreaterThan(staff.length);
    expect(staff).toContain('cost-table');
    expect(deskLinks(DESK_DEFS.finance, 'staff', (p) => p === 'finance.cost-table.view').map((p) => p.id)).toEqual(['cost-table']);
    expect(deskFor('nonsense').type).toBe('blank');
    expect(deskLinks(deskFor(null), 'staff', all)).toEqual([]);
  });
  it('新增的四个工作台页面进了权限目录', () => {
    const keys = permissionCatalog().flatMap((g) => g.items.map((i) => i.key));
    for (const k of ['workbench.home.view', 'workbench.boss.view', 'workbench.desk.view', 'workbench.personal.view']) expect(keys).toContain(k);
  });
});

describe('岗位分组与任务阶段', () => {
  const p = (id: number, name: string, path: string): DeskPosition => ({ id, name, workspaceType: 'blank', level: 'staff', departmentId: 1, departmentPath: path, assigned: false, isPrimary: false });
  it('一个部门一组，没有部门的归“未分部门”', () => {
    const g = groupDeskPositions([p(1, 'a', '总部 / 财务'), p(2, 'b', ''), p(3, 'c', '总部 / 财务')]);
    expect(g.map((x) => [x.title, x.items.length])).toEqual([['总部 / 财务', 2], ['未分部门', 1]]);
  });
  it('任务阶段：完成/取消优先，其次待复核、进行中，否则新任务；四个分类齐全', () => {
    expect(taskStage({ status: 'open', startedAt: null, submittedAt: null })).toBe('new');
    expect(taskStage({ status: 'open', startedAt: new Date(), submittedAt: null })).toBe('processing');
    expect(taskStage({ status: 'open', startedAt: new Date(), submittedAt: new Date() })).toBe('submitted');
    expect(taskStage({ status: 'done', startedAt: null, submittedAt: new Date() })).toBe('done');
    expect(TASK_VIEWS.map((v) => v.label)).toEqual(['新任务', '进行中', '待我复核', '已完成']);
  });
});
