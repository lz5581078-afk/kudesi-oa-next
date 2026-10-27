import { describe, expect, it } from 'vitest';
import { MOBILE_PRIMARY_SECTIONS, NAV_SECTIONS, directPage, groupPages, searchNav, splitMobileSections, visibleSections } from './navigation';

const all = visibleSections(() => true);

describe('导航分组与搜索', () => {
  it('每个一级菜单都有图标，手机底栏优先项都是真实的一级菜单', () => {
    for (const s of NAV_SECTIONS) expect(s.icon).toBeTruthy();
    for (const id of MOBILE_PRIMARY_SECTIONS) expect(NAV_SECTIONS.some((s) => s.id === id)).toBe(true);
  });

  it('分组保持页面原有顺序，且不丢页面', () => {
    for (const section of all) {
      const groups = groupPages(section);
      expect(groups.flatMap((g) => g.pages.map((p) => p.id))).toEqual(section.pages.map((p) => p.id));
    }
    const finance = groupPages(all.find((s) => s.id === 'finance')!);
    expect(finance.map((g) => g.title)).toContain('制单中心');
  });

  it('没有分组标题的页面归到以一级菜单命名的组', () => {
    const workbench = groupPages(all.find((s) => s.id === 'workbench')!);
    expect(workbench).toHaveLength(1);
    expect(workbench[0].title).toBe('工作台');
  });

  it('只有一个页面的一级菜单可以直接进入', () => {
    expect(directPage({ pages: [all[0].pages[0]] })?.id).toBe(all[0].pages[0].id);
    expect(directPage(all[0])).toBeNull();
  });

  it('搜索：多个关键词都要命中；能按分组名或一级菜单名找；空关键词不出结果', () => {
    expect(searchNav(all, '')).toEqual([]);
    expect(searchNav(all, '  ,  ')).toEqual([]);
    const byName = searchNav(all, '成本表');
    expect(byName.some((h) => h.page.id === 'cost-table')).toBe(true);
    const byGroup = searchNav(all, '制单中心');
    expect(byGroup.length).toBeGreaterThan(3);
    expect(byGroup.every((h) => h.groupTitle === '制单中心')).toBe(true);
    const both = searchNav(all, '财务 成本');
    expect(both.every((h) => h.sectionId === 'finance')).toBe(true);
    expect(searchNav(all, '成本表 不存在的词')).toEqual([]);
  });

  it('权限过滤后搜不到没权限的页面', () => {
    const only = visibleSections((p) => p === 'workbench.todos.view');
    expect(searchNav(only, '成本')).toEqual([]);
    expect(searchNav(only, '待办')).toHaveLength(1);
  });

  it('手机底栏：优先项按固定顺序，其余收进更多；看不到的不出现', () => {
    const { primary, more } = splitMobileSections(all);
    expect(primary.map((s) => s.id)).toEqual(['workbench', 'flow', 'finance', 'resource', 'features']);
    expect(more.map((s) => s.id)).toEqual(['after-sales', 'supervision', 'system']);
    const few = splitMobileSections(visibleSections((p) => p.startsWith('workbench.') || p.startsWith('system.')));
    expect(few.primary.map((s) => s.id)).toEqual(['workbench']);
    expect(few.more.map((s) => s.id)).toEqual(['system']);
  });
});
