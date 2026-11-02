import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { createChecker, permissionOwner, resourcePermission, resolveProductSections, todayShanghai, unitYuanText, type ResourceDef } from '@kudesi/shared';
import { useAuth } from '../auth/AuthContext';
import { resourceApi, type ResourceDto } from './api';
import { resourceFields, resourceGroups, resourceFieldWide } from './resourceFieldLayout';
import { InfoValue, SecretCell } from './DetailFields';
import { FileList } from './FilesField';

export const FINANCE_DETAIL_TYPES = new Set(['finance-products', 'finance-suppliers', 'finance-customers', 'finance-fee-items', 'finance-base-codes', 'finance-bundles']);
export const detailNumber = (value: unknown): number | null => !['number', 'string'].includes(typeof value) || typeof value === 'string' && !value.trim() || !Number.isFinite(Number(value)) ? null : Number(value);
export const detailMoney = (value: unknown) => detailNumber(value) === null ? '未维护' : `¥${unitYuanText(Number(value))}`;
export const detailWeight = (value: unknown) => detailNumber(value) === null ? '未维护' : `${(Number(value) / 1000).toFixed(6)} kg`;

export function FinanceSection({ title, hint, step, children, className = '' }: { title: string; hint?: ReactNode; step?: number; children: ReactNode; className?: string }) {
  return <section className={`finance-view-section ${className}`} aria-label={title}><div className="finance-view-heading"><h3>{step && <i className="finance-view-step" aria-hidden="true">{step}</i>}{title}</h3>{hint && <small>{hint}</small>}</div>{children}</section>;
}

/** 字段仍从统一资料定义取权限、选项和格式；只读视图不挂载任何输入/自动保存逻辑。 */
export function FinanceFields({ def, record, keys }: { def: ResourceDef; record: ResourceDto; keys: Array<string | [string, string]> }) {
  const { user } = useAuth();
  const can = user ? createChecker(user.permissions) : () => false;
  return <dl className="finance-view-fields">{keys.map(item => {
    const [key, label] = typeof item === 'string' ? [item, undefined] : item;
    const field = def.fields.find(f => f.key === key);
    if (!field || field.permission && !can(field.permission) || field?.showWhen && !field.showWhen.in.includes(String(field.showWhen.field === 'status' ? record.status : record.data[field.showWhen.field] ?? ''))) return null;
    return <Fragment key={key}><div data-field={key} data-kind={field.type} className={resourceFieldWide(field) ? 'wide' : undefined}><dt>{label ?? field.label}</dt><dd>{field.type === 'secret' ? <SecretCell def={def} record={record} fieldKey={key} /> : field.type === 'files'
      ? <FileList ids={Array.isArray(record.data[key]) ? record.data[key] as number[] : []} files={record.files} />
      : <InfoValue def={def} record={record} f={field} today={todayShanghai()} canView={type => can(resourcePermission(permissionOwner(type), 'view'))} />}</dd></div>{def.key === 'finance-fee-items' && key === 'isCommon' && <div data-field="requiresObject"><dt>费用单必须挂归属对象</dt><dd>{String(record.data.defaultObject || '').split(/[、,，]/).some(n => n && n !== '公司' && n !== '不固定') ? '是' : '否'}</dd></div>}</Fragment>;
  })}</dl>;
}

export interface DetailRow { row: ResourceDto; item: ResourceDto | null }
export async function allDetailRows(type: string, fieldKey: string, fieldValue: number): Promise<ResourceDto[]> {
  const rows: ResourceDto[] = [];
  for (let page = 1; ; page++) {
    const result = await resourceApi.list(type, { fieldKey, fieldValue, page, pageSize: 200, showHidden: true });
    rows.push(...result.items);
    if (!result.items.length || rows.length >= result.total) return rows;
  }
}

/** 用于查看组成/供货来源的完整分页读取；引用无权读取时保留原行，不能伪装成空组成。 */
export function useFinanceDetailRows(type: string, field: string, id: number, version: string, refs: (row: ResourceDto) => [string, number] | null) {
  const [state, setState] = useState<{ key: string; rows: DetailRow[] | null; error: string }>({ key: '', rows: null, error: '' });
  const key = `${type}:${field}:${id}:${version}`;
  useEffect(() => {
    let alive = true;
    (async () => {
      const rows = await allDetailRows(type, field, id);
      const targets = new Map(rows.map(row => refs(row)).filter((r): r is [string, number] => r !== null).map(r => [r.join(':'), r]));
      const found = new Map(await Promise.all([...targets].map(async ([key, [target, targetId]]) => {
        try { return [key, await resourceApi.get(target, targetId)] as const; } catch { return [key, null] as const; }
      })));
      if (alive) setState({ key, rows: rows.map(row => { const ref = refs(row); return { row, item: ref ? found.get(ref.join(':')) ?? null : null }; }), error: '' });
    })().catch(e => { if (alive) setState({ key, rows: null, error: e instanceof Error ? e.message : '明细读取失败' }); });
    return () => { alive = false; };
    // refs 是各明细视图固定的资源映射，不因父组件重绘重新读取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state.key === key ? state : { rows: null, error: '' };
}

export function DetailRowsState({ error, loading, empty }: { error: string; loading: boolean; empty: boolean }) {
  return error ? <p role="alert">明细读取失败：{error}</p> : loading ? <p role="status">正在加载组成明细…</p> : empty ? <p className="finance-view-empty">尚未维护商品组成</p> : null;
}

/** 专用统计/组成视图之外的字段也必须可查看；新增配置字段不会再被手写查看页漏掉。 */
export function SupplementalFinanceFields({ def, record, covered }: { def: ResourceDef; record: ResourceDto; covered: readonly string[] }) {
  const { user } = useAuth();
  const can = (p: string) => !!user && createChecker(user.permissions)(p) && !(record.warehouseMode && ['product.cost.view', 'product.price.view'].includes(p));
  const fields = def.key === 'finance-products'
    ? resolveProductSections(record.data, { canUse: can }).flatMap(section => section.nodes.flatMap(node => node.kind === 'field' ? [node.field] : [...node.fields]))
    : resourceFields(def, record.data, record.status, can);
  const used = new Set(covered);
  const remaining = fields.filter(f => { if (used.has(f.key) || f.listOnly) return false; used.add(f.key); return true; });
  return <>{resourceGroups(remaining).map(([group, items]) => <FinanceSection key={group} title={`${group} · 补充资料`}><FinanceFields def={def} record={record} keys={items.map(f => [f.key, f.label])} /></FinanceSection>)}</>;
}
