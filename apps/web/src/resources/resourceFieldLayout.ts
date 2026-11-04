import { restrictedFieldKeys, type FieldDef, type ResourceDef } from '@kudesi/shared';

/** 查看和编辑使用相同的字段顺序、条件及整行规则。只读字段在编辑时保留位置。 */
export function resourceFields(def: ResourceDef, values: Record<string, unknown>, status: string, can: (permission: string) => boolean): FieldDef[] {
  const restricted = restrictedFieldKeys(def, can);
  return def.fields.filter(f => !f.listOnly && !restricted.has(f.key) &&
    (!f.showWhen || f.showWhen.in.includes(String(f.showWhen.field === 'status' ? status : values[f.showWhen.field] ?? ''))));
}
export function resourceGroups(fields: readonly FieldDef[]): Array<[string, FieldDef[]]> {
  const groups = new Map<string, FieldDef[]>();
  for (const f of fields) groups.set(f.group, [...(groups.get(f.group) ?? []), f]);
  return [...groups];
}
export function resourceFieldWide(f: FieldDef): boolean {
  return ['textarea', 'files', 'attrs', 'json', 'refs'].includes(f.type) || !!(f.type === 'select' && f.multi || f.type === 'ref' && f.cascade);
}
