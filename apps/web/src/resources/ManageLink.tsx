import { useState } from 'react';
import { createPortal } from 'react-dom';
import { ReferenceDictionaryManager } from './ReferenceDictionaryManager';
import { PAGE_TABS, optionsKindOf, resourcePagePath, type FieldDef } from '@kudesi/shared';

/** 商品表单里“管理单位/品牌/供应商”的快捷入口（旧系统表单里的“管理XX”按钮）：单位和品牌可在原位维护，其他资料在新标签页打开，不丢当前填写的内容。 */
const NAMES: Record<string, string> = { 'finance-product-units': '管理单位与规格', 'finance-brands': '管理品牌', 'finance-suppliers': '管理供应商' };
export function ManageLink({ field, values = {}, inPlace = false }: { field: FieldDef; values?: Record<string, unknown>; inPlace?: boolean }) {
  const [open, setOpen] = useState(false);
  const type = field.optionsFrom?.resource ?? (field.type === 'ref' ? field.ref : undefined);
  const host = type ? Object.entries(PAGE_TABS).find(([, tabs]) => tabs.some((t) => t.ref === type))?.[0] : undefined; // 在宿主页的页签里的资料
  const path = type ? resourcePagePath(type) ?? (host ? `/${host}` : null) : null;
  if (!type || !path || !NAMES[type]) return null;
  if (inPlace && ['finance-product-units', 'finance-brands'].includes(type)) return <><a href={path} role="button" className="link-button rf-manage" aria-label={NAMES[type]} onClick={e => { e.preventDefault(); e.stopPropagation(); setOpen(true); }}>{type === 'finance-brands' ? '管理品牌' : `管理${field.label}`}</a>{open && createPortal(<ReferenceDictionaryManager target={type} kind={optionsKindOf(field, values) ?? undefined} title={field.optionsFrom ? `管理${field.label}` : NAMES[type]} onClose={() => setOpen(false)} />, document.body)}</>;
  return <a className="link-button rf-manage" href={path} target="_blank" rel="noreferrer" aria-label={NAMES[type]} title={NAMES[type]} onClick={(e) => e.stopPropagation()}>管理</a>;
}
