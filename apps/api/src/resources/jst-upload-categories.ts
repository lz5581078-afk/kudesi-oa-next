import type { RemoteCategory } from '../outbox/outbox.service';

export interface UploadCategoryOption { value: string; label: string; disabled: boolean; reason?: string }
export const DUPLICATE_CATEGORY_REASON = '聚水潭存在同名分类，无法唯一确定该分类，请调整名称后刷新。';
export const UNAVAILABLE_CATEGORY_REASON = '所选聚水潭分类已失效，请刷新分类后重新选择。';

/** Match the existing sender's unique enabled name + leaf restriction without adding write parameters. */
export function projectUploadCategories(rows: readonly RemoteCategory[]): UploadCategoryOption[] {
  const nodes = new Map(rows.map(row => [row.id, row]));
  const parents = new Set(rows.map(row => row.parentId));
  const names = new Map<string, number>(), ids = new Map<string, number>();
  for (const row of rows) {
    ids.set(row.id, (ids.get(row.id) ?? 0) + 1);
    if (row.enable !== false) names.set(row.name, (names.get(row.name) ?? 0) + 1);
  }
  const projected = rows.map(row => {
    let reason = row.enable === false ? '该聚水潭分类已停用，请调整后刷新。' : parents.has(row.id) ? '请选择聚水潭末级分类。' : '';
    const path: string[] = [], seen = new Set<string>();
    let current: RemoteCategory | undefined = row;
    while (current) {
      if (!current.id || !current.name || ids.get(current.id) !== 1 || seen.has(current.id)) { reason = '聚水潭分类层级不完整或存在循环，请调整后刷新。'; break; }
      seen.add(current.id); path.unshift(current.name);
      if (current.enable === false) reason = current.id === row.id ? '该聚水潭分类已停用，请调整后刷新。' : '该聚水潭分类的上级已停用，请调整后刷新。';
      if (!current.parentId || current.parentId === '0') break;
      current = nodes.get(current.parentId);
      if (!current) reason = '聚水潭分类父级缺失，请调整后刷新。';
    }
    if (!reason && (names.get(row.name) ?? 0) !== 1) reason = DUPLICATE_CATEGORY_REASON;
    // The sender separates paths using '/', so such a name cannot be represented unambiguously.
    if (!reason && row.name.includes('/')) reason = '聚水潭分类名称含路径分隔符，无法唯一确定该分类，请调整后刷新。';
    const value = path.join('/') || row.name || '未命名分类';
    return { value, label: value, disabled: !!reason, ...(reason ? { reason } : {}) };
  });
  const byValue = new Map<string, UploadCategoryOption>();
  for (const option of projected) {
    if (byValue.has(option.value)) byValue.set(option.value, { ...option, disabled: true, reason: DUPLICATE_CATEGORY_REASON });
    else byValue.set(option.value, option);
  }
  return [...byValue.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN', { numeric: true }));
}

export function uploadCategoryProblem(options: readonly UploadCategoryOption[], selected: string): string | null {
  const exact = options.filter(option => option.value === selected);
  // Existing callers may supply a unique leaf name or a unique path suffix; retain that contract.
  const matches = exact.length ? exact : options.filter(option => option.value.endsWith('/' + selected));
  if (matches.length !== 1) return matches.length ? DUPLICATE_CATEGORY_REASON : UNAVAILABLE_CATEGORY_REASON;
  return matches[0].disabled ? matches[0].reason || UNAVAILABLE_CATEGORY_REASON : null;
}
