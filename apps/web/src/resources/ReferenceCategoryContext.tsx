import type { ReactNode } from 'react';
import { FolderTree } from 'lucide-react';

export function ReferenceCategoryContext({ label, path, children, editing, party = false }: { label: string; path: string; children?: ReactNode; editing: boolean; party?: boolean }) {
  if (party) return <div className="reference-party-context"><div><FolderTree size={20}/><small>归入分类</small><strong>{path}</strong></div><p>{path.includes('种子') ? '种子供应商可关联多个供应产品分类' : '供应商显示在该目录的直属列表中'}</p>{!editing && children}</div>;
  return <div className="reference-category-context"><FolderTree size={28} aria-hidden="true" /><div><small>归入分类</small>{path && <strong>{path}</strong>}{editing ? <p>分类由{label}档案主页决定；如需调整，请在列表中使用“移动分类”。</p> : children}</div></div>;
}
