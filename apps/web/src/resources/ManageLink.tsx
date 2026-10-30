import { PAGE_TABS, resourcePagePath, type FieldDef } from '@kudesi/shared';

/** 商品表单里“管理单位/品牌/供应商”的快捷入口（旧系统表单里的“管理XX”按钮）：在新标签页打开维护页，不丢当前填写的内容。 */
const NAMES: Record<string, string> = { 'finance-product-units': '管理单位与规格', 'finance-brands': '管理品牌', 'finance-suppliers': '管理供应商' };
export function ManageLink({ field }: { field: FieldDef }) {
  const type = field.optionsFrom?.resource ?? (field.type === 'ref' ? field.ref : undefined);
  const host = type ? Object.entries(PAGE_TABS).find(([, tabs]) => tabs.some((t) => t.ref === type))?.[0] : undefined; // 在宿主页的页签里的资料
  const path = type ? resourcePagePath(type) ?? (host ? `/${host}` : null) : null;
  if (!type || !path || !NAMES[type]) return null;
  return <a className="link-button rf-manage" href={path} target="_blank" rel="noreferrer" aria-label={NAMES[type]} title={NAMES[type]} onClick={(e) => e.stopPropagation()}>管理</a>;
}
