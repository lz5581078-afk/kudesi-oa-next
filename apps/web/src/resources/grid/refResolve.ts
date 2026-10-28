import type { FieldDef } from '@kudesi/shared';
import { resourceApi } from '../api';

export interface RefChoice { id: number; label: string; disabled?: boolean }

const cache = new Map<string, Promise<RefChoice[]>>();

/** 引用字段的候选（员工/部门整表，其他资料取前 50 条；更多靠搜索） */
export function refChoices(target: string): Promise<RefChoice[]> {
  let p = cache.get(target);
  if (!p) {
    p = target === 'department'
      ? resourceApi.departments().then((l) => l.map((d) => ({ id: d.id, label: d.name })))
      : target === 'user'
        ? resourceApi.users().then((l) => l.map((u) => ({ id: u.id, label: u.active ? u.name : `${u.name}（已停用）`, disabled: !u.active })))
        : resourceApi.list(target, { pageSize: 50, showHidden: true }).then((r) => r.items.map((i) => ({ id: i.id, label: i.title })));
    p.catch(() => cache.delete(target));
    cache.set(target, p);
  }
  return p;
}

export function searchRefChoices(target: string, keyword: string): Promise<RefChoice[]> {
  if (target === 'user' || target === 'department') return refChoices(target).then((l) => l.filter((x) => x.label.includes(keyword)));
  return resourceApi.list(target, { pageSize: 30, showHidden: true, keyword }).then((r) => r.items.map((i) => ({ id: i.id, label: i.title })));
}

export function clearRefChoices() { cache.clear(); }

/** 粘贴/输入的名称 → 记录：必须与名称完全一致（或恰好只有一条匹配），否则返回 null */
export async function resolveRefLabel(field: FieldDef, text: string): Promise<RefChoice | null> {
  const t = text.trim();
  if (!t || !field.ref) return null;
  const local = (await refChoices(field.ref)).filter((x) => x.label === t);
  if (local.length === 1) return local[0];
  const found = (await searchRefChoices(field.ref, t)).filter((x) => x.label === t);
  return found.length === 1 ? found[0] : null;
}
