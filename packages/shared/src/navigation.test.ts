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

describe('资料二级导航与旧程序一致（不删减、不合并）', () => {
  const OLD: Array<[string, Array<[string, string]>]> = [
    ['资料首页', [['资料总览', '基础资料数量和最近变更']]],
    ['组织与人员', [['组织架构', '公司、部门、岗位、人员'], ['人员档案', '员工、岗位、角色绑定'], ['岗位档案', '岗位、职责、培训和考核'], ['职责组', '流程任务可引用的职责组']]],
    ['经营资料', [['营业执照', '经营/电商主体执照资料'], ['税务资料', '经营/电商税务资料'], ['商标资料', '商标申请、证书、类别和到期'], ['合作人档案', '合作人、联系方式、关联主体'], ['店铺档案', '平台店铺、领取归属、状态'], ['自媒体账号档案', '抖音、快手等内容账号资料'], ['微信号档案', '公司微信号、账号密码和绑定手机号']]],
    ['账号与资质', [['手机号', '号码、套餐、充值提醒'], ['宽带账号', '宽带账号、位置、带宽和绑定手机号'], ['费用模块', '手机号套餐、子卡费用、宽带费用'], ['资质证照', '到期、续期、状态'], ['账号与服务备忘', '平台账号、云服务、域名和到期提醒']]],
    ['银行卡', [['资金概况', '公司和店铺账户余额总览'], ['公司公户', '公司主体公户和对账提醒'], ['公司银行卡', '公司银行卡资料'], ['公司出纳账户', '出纳账户和保管人'], ['店铺公户', '店铺绑定公户'], ['店铺个人银行卡', '店铺个人卡和预留手机号']]],
    ['公司资产', [['固定资产', '电脑、手机、打印机、办公用品'], ['房间与档案位置', '房间、柜子、层位、档案定位']]],
    ['公司店铺维护', [['管理公司店铺维护', '维护公司店铺独立登录环境和授权电脑']]],
  ];
  it('分组标题、条目名称、顺序、说明与旧程序逐项相同，每个条目是独立页面', () => {
    const section = NAV_SECTIONS.find((s) => s.id === 'resource')!;
    const got = groupPages(section).map((g) => [g.title, g.pages.map((p) => [p.label, p.description ?? ''])]);
    expect(got).toEqual(OLD);
    expect(new Set(section.pages.map((p) => p.path)).size).toBe(section.pages.length);
    expect(section.pages.every((p) => p.ready)).toBe(true);
  });
});
