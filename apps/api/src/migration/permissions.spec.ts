import { mapLegacyPermission } from './permissions';
describe('旧权限对应',()=>{
  it('对应明确的资料动作和财务页面',()=>{
    expect(mapLegacyPermission('resources.business-licenses.detail')).toBe('resource.licenses.view');
    expect(mapLegacyPermission('resources.phone-numbers.deactivate')).toBe('resource.phones.disable');
    expect(mapLegacyPermission('finance-cost-table.view')).toBe('finance.cost-table.view');
  });
  it('不把菜单、老板页面或未知资源扩大成授权',()=>{
    for(const key of ['menu.finance.view','boss.view','finance.view','resources.unknown.edit'])expect(mapLegacyPermission(key)).toBeNull();
  });
  it('只对应已核实相同的同步能力，不授予成本编辑或公司管理',()=>{
    expect(mapLegacyPermission('finance-product-bundles.sync')).toBe('finance.bundle-sync.manage');
  });
  it('五类账户同一动作全部具备才合并，不能拿其他动作补足',()=>{
    const pages=['company-public-accounts','company-bank-cards','cashier-accounts','store-public-accounts','store-personal-cards'];
    const keys=pages.map(p=>`resources.${p}.edit`);
    expect(mapLegacyPermission(keys[0])).toBeNull();
    expect(mapLegacyPermission(keys[0],keys.slice(0,4))).toBeNull();
    expect(mapLegacyPermission(keys[0],[...keys.slice(0,4),'resources.store-personal-cards.view'])).toBeNull();
    for(const key of keys)expect(mapLegacyPermission(key,keys)).toBe('resource.bank-accounts.edit');
    const inactive=pages.map(p=>`resources.${p}.deactivate`);
    expect(mapLegacyPermission(inactive[0],inactive)).toBe('resource.bank-accounts.disable');
  });
});
