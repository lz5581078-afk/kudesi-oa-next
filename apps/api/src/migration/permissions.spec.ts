import { mapLegacyPermission } from './permissions';
describe('旧权限对应',()=>{
  it('对应明确的资料动作和财务页面',()=>{
    expect(mapLegacyPermission('resources.business-licenses.detail')).toBe('resource.licenses.view');
    expect(mapLegacyPermission('resources.phone-numbers.deactivate')).toBe('resource.phones.disable');
    expect(mapLegacyPermission('finance-cost-table.view')).toBe('finance.cost-table.view');
  });
  it('不把菜单、老板页面或旧同步按钮扩大成授权',()=>{
    for(const key of ['menu.finance.view','boss.view','finance.view','finance-product-bundles.sync','resources.unknown.edit'])expect(mapLegacyPermission(key)).toBeNull();
  });
});
