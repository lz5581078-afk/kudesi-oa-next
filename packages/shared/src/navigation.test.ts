import { describe, expect, it } from 'vitest';
import { MOBILE_PRIMARY_SECTIONS, NAV_SECTIONS, withDeskNavigation, isNavPathCurrent, directPage, groupPages, searchNav, splitMobileSections, visibleSections } from './navigation';

const all = visibleSections(() => true, { isCompanyAdmin: true });

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

  it('仅开通实时售后时仍从功能菜单的售后处理分组进入', () => {
    const sections = visibleSections((permission) => permission === 'after-sales.workspace.view');
    const features = sections.find((section) => section.id === 'features')!;
    expect(groupPages(features)).toEqual([
      { title: '售后处理', pages: [expect.objectContaining({ label: '实时售后处理', path: '/after-sales/workspace' })] },
    ]);
    expect(directPage(features)).toBeNull();
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
  // 基线是 10 月 24 日备份的旧程序导航；用户后来明确要求新系统补上旧系统较新版本才有的“兼职与临时工”（期限与计薪，
  // 位置在“人员档案”之后、“岗位档案”之前，旧系统 navigation.js 同位置），所以在基线上增加这一项，其余条目不变。
  const OLD: Array<[string, Array<[string, string]>]> = [
    ['资料首页', [['资料总览', '基础资料数量和最近变更']]],
    ['组织与人员', [['组织架构', '公司、部门、岗位、人员'], ['人员档案', '员工、岗位、角色绑定'], ['兼职与临时工', '期限与计薪'], ['岗位档案', '岗位、职责、培训和考核'], ['职责组', '流程任务可引用的职责组']]],
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


describe('岗位工作台直达导航', () => {
  const positions: import('./workspace').DeskPosition[] = [
    { id: 11, name: '会计', departmentId: 1, departmentPath: '总部 / 财务部', workspaceType: 'finance', level: 'staff', assigned: true, isPrimary: true },
    { id: 12, name: '运营', departmentId: 2, departmentPath: '运营部', workspaceType: 'operations', level: 'staff', assigned: false, isPrimary: false },
    { id: 13, name: '出纳', departmentId: 1, departmentPath: '总部 / 财务部', workspaceType: 'cashier', level: 'staff', assigned: false, isPrimary: false },
  ];
  it('按实际部门聚合岗位并保留原岗位权限；同路由不同岗位只高亮当前岗位', () => {
    const sections = withDeskNavigation(all, positions);
    const workbench = sections.find((s) => s.id === 'workbench')!;
    expect(workbench.pages.some((p) => p.id === 'desk')).toBe(false);
    const groups = groupPages(workbench);
    expect(groups.map((g) => g.title)).toEqual(['常用工作台', '总部 / 财务部', '运营部']);
    expect(groups[1].pages.map((p) => p.label)).toEqual(['会计工作台', '出纳工作台']);
    expect(groups[1].pages.every((p) => p.permission === 'workbench.desk.view')).toBe(true);
    expect(searchNav(sections, '财务部 出纳').map((h) => h.page.path)).toEqual(['/workbench/desk?position=13']);
    expect(isNavPathCurrent('/workbench/desk?position=11', '/workbench/desk', '?position=11&tab=all')).toBe(true);
    expect(isNavPathCurrent('/workbench/desk?position=12', '/workbench/desk', '?position=11')).toBe(false);
    expect(isNavPathCurrent('/workbench/desk?position=11', '/workbench/desk', '')).toBe(false);
    expect(isNavPathCurrent('/finance/drafts', '/finance/drafts/1', '?x=1')).toBe(true);
  });
  it('目录可读不增加页面权限；空目录移除汇总入口，失败保留恢复入口', () => {
    expect(withDeskNavigation(visibleSections((p) => p === 'workbench.personal.view'), positions)[0].pages.map((p) => p.id)).toEqual(['personal']);
    expect(withDeskNavigation(visibleSections((p) => p === 'workbench.desk.view'), [])).toEqual([]);
    const sections = visibleSections(() => true);
    expect(withDeskNavigation(sections, null)).toBe(sections);
    expect(withDeskNavigation(sections, [{ ...positions[0], departmentPath: '' }]).find((s) => s.id === 'workbench')!.pages.at(-1)!.group).toBe('未分配部门');
  });
});

it('财务单据中心按原入口仅列经营历程与草稿，历史收支关联路由和权限仍保留',()=>{
 const finance=visibleSections(()=>true).find(section=>section.id==='finance')!;
 expect(finance.pages.filter(page=>page.group==='单据中心').map(page=>page.id)).toEqual(['history','drafts']);
 const history=NAV_SECTIONS.find(section=>section.id==='finance')!.pages.find(page=>page.id==='finance-ledger-history')!;
 expect(history).toMatchObject({path:'/finance/finance-ledger-history',permission:'resource.finance-ledger-history.view',ready:true,menuHidden:true});
 expect(searchNav(visibleSections(()=>true),'历史收支记录')).toEqual([]);
});
it('财务菜单按24号全部原入口顺序，扩展查询保留路由而不额外添加主菜单',()=>{
 const finance=visibleSections(()=>true).find(section=>section.id==='finance')!;
 expect(finance.pages.filter(page=>page.id!=='doc-withdrawal').map(page=>page.label)).toEqual(['财务经营','商品档案','供应商档案','客户档案','费用档案','经营历程','草稿中心','普通销售单','网店销售单','销售退货单','预收款单','收款单','付款单','转款单','预付款单','采购入库单','采购退货单','其他收入单','费用单','成本表','定价调试表','人力成本表','快递价格表','库存查询','现金银行查询','商品基础编码','商品组合编码','商品数据导入','资料维护']);
 for(const id of ['unsettled-receipts','settlement-detail'])expect(NAV_SECTIONS.find(section=>section.id==='finance')!.pages.find(page=>page.id===id)).toMatchObject({path:`/finance/${id}`,ready:true,menuHidden:true});
});

it('流程管理只给公司管理员，普通员工仍可在工作台找到已授权的专属业务', () => {
  const staff = visibleSections(() => true);
  expect(staff.some(section => section.id==='flow')).toBe(false);
  const paths = staff.find(section => section.id==='workbench')?.pages.map(page=>page.path);
  expect(paths).toContain('/flow/purchase');
  expect(paths).not.toContain('/flow/apply');
  expect(all.find(section=>section.id==='flow')?.pages.map(page=>page.path)).toContain('/flow/apply');
});
