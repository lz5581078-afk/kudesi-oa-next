import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { addDaysText, getResourceDef, todayShanghai, type Cond, type DerivedColumn, type ResourceDef } from '@kudesi/shared';
import { ResourceRecord } from '../entities';

/**
 * 资料配置里的声明式条件（快捷页签 / 计算筛选 / 派生列）翻译成 SQL。
 * 字段、资料类型全部按配置白名单校验；所有子查询都带 company_id，值全部走参数。
 */

export interface CondCtx {
  params: Record<string, unknown>;
  n: number;
  /** 计算筛选下拉选中的值，代入条件里的 '$value' */
  dyn?: string;
}

export const newCondCtx = (prefix = 'c'): CondCtx & { prefix: string } => ({ params: {}, n: 0, prefix });

const jx = (alias: string, key: string) => `JSON_UNQUOTE(JSON_EXTRACT(${alias}.data, '$.${key}'))`;

function fieldExpr(def: ResourceDef, alias: string, key: string) {
  if (key === '$status') return `${alias}.status`;
  if (!def.fields.some((f) => f.key === key)) throw new BadRequestException('条件里的字段不存在');
  return jx(alias, key);
}

function emptyExpr(def: ResourceDef, alias: string, key: string) {
  if (key === '$status') return `(${alias}.status IS NULL OR ${alias}.status = '')`;
  if (!def.fields.some((f) => f.key === key)) throw new BadRequestException('条件里的字段不存在');
  const raw = `JSON_EXTRACT(${alias}.data, '$.${key}')`;
  return `(${raw} IS NULL OR JSON_TYPE(${raw}) = 'NULL' OR (JSON_TYPE(${raw}) = 'ARRAY' AND JSON_LENGTH(${raw}) = 0) OR (JSON_TYPE(${raw}) = 'STRING' AND JSON_UNQUOTE(${raw}) = ''))`;
}

function put(ctx: CondCtx & { prefix?: string }, value: unknown): string {
  const name = `${ctx.prefix ?? 'c'}${ctx.n++}`;
  ctx.params[name] = value;
  return `:${name}`;
}

/** depth 用来给子查询别名去重 */
export function condSql(def: ResourceDef, cond: Cond, alias: string, ctx: CondCtx & { prefix?: string }, depth = 0): string {
  if ('all' in cond) return cond.all.length ? `(${cond.all.map((c) => condSql(def, c, alias, ctx, depth)).join(' AND ')})` : '1=1';
  if ('any' in cond) return cond.any.length ? `(${cond.any.map((c) => condSql(def, c, alias, ctx, depth)).join(' OR ')})` : '1=0';
  if ('not' in cond) return `NOT (${condSql(def, cond.not, alias, ctx, depth)})`;
  if ('rel' in cond) {
    const other = getResourceDef(cond.rel.type);
    const f = other?.fields.find((x) => x.key === cond.rel.field);
    if (!other || !f || (f.type !== 'ref' && f.type !== 'refs')) throw new BadRequestException('条件里的关联不存在');
    const x = `x${depth + 1}`;
    const link = f.type === 'refs'
      ? `JSON_CONTAINS(JSON_EXTRACT(${x}.data, '$.${f.key}'), CAST(${alias}.id AS JSON))`
      : `${jx(x, f.key)} = CAST(${alias}.id AS CHAR)`;
    const where = cond.rel.where ? ` AND ${condSql(other, cond.rel.where, x, ctx, depth + 1)}` : '';
    const sql = `EXISTS (SELECT 1 FROM resource_records ${x} WHERE ${x}.company_id = ${alias}.company_id AND ${x}.type = ${put(ctx, other.key)} AND ${x}.archived_at IS NULL AND ${link}${where})`;
    return cond.op === 'exists' ? sql : `NOT ${sql}`;
  }
  if ('viaUserDept' in cond) {
    const f = def.fields.find((x) => x.key === cond.viaUserDept);
    if (!f || f.type !== 'ref' || f.ref !== 'user') throw new BadRequestException('条件里的员工字段不存在');
    const raw = cond.dept === '$value' ? ctx.dyn : cond.dept;
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) throw new BadRequestException('部门不合法');
    const u = `u${depth + 1}`;
    const dept = cond.includeChildren
      ? `(WITH RECURSIVE dt AS (SELECT id FROM departments WHERE id = ${put(ctx, id)} UNION ALL SELECT c.id FROM departments c JOIN dt ON c.parent_id = dt.id) SELECT id FROM dt)`
      : `(${put(ctx, id)})`;
    return `EXISTS (SELECT 1 FROM users ${u} WHERE ${u}.company_id = ${alias}.company_id AND CAST(${u}.id AS CHAR) = ${jx(alias, f.key)} AND ${u}.department_id IN ${dept})`;
  }
  if ('viaRef' in cond) {
    const f = def.fields.find((x) => x.key === cond.viaRef);
    const target = f?.type === 'ref' && f.ref ? getResourceDef(f.ref) : undefined;
    if (!f || !target) throw new BadRequestException('条件里的引用字段不存在');
    const y = `y${depth + 1}`;
    return `EXISTS (SELECT 1 FROM resource_records ${y} WHERE ${y}.company_id = ${alias}.company_id AND ${y}.type = ${put(ctx, target.key)} AND CAST(${y}.id AS CHAR) = ${jx(alias, f.key)} AND ${condSql(target, cond.where, y, ctx, depth + 1)})`;
  }
  switch (cond.op) {
    case 'eq': return `${fieldExpr(def, alias, cond.field)} = ${put(ctx, String(cond.value))}`;
    case 'ne': return `(${fieldExpr(def, alias, cond.field)} IS NULL OR ${fieldExpr(def, alias, cond.field)} <> ${put(ctx, String(cond.value))})`;
    case 'in': return cond.value.length ? `${fieldExpr(def, alias, cond.field)} IN (${cond.value.map((v) => put(ctx, String(v))).join(',')})` : '1=0';
    case 'notIn': return cond.value.length ? `(${fieldExpr(def, alias, cond.field)} IS NULL OR ${fieldExpr(def, alias, cond.field)} NOT IN (${cond.value.map((v) => put(ctx, String(v))).join(',')}))` : '1=1';
    case 'dateWithin': {
      const x = fieldExpr(def, alias, cond.field);
      const days = Math.max(0, Math.min(3660, Math.floor(Number(cond.days))));
      return `(${x} IS NOT NULL AND ${x} <> '' AND ${x} >= ${put(ctx, todayShanghai())} AND ${x} <= ${put(ctx, addDaysText(todayShanghai(), days))})`;
    }
    case 'expired': {
      const x = fieldExpr(def, alias, cond.field);
      return `(${x} IS NOT NULL AND ${x} <> '' AND ${x} < ${put(ctx, todayShanghai())})`;
    }
    case 'empty': return emptyExpr(def, alias, cond.field);
    case 'notEmpty': return `NOT ${emptyExpr(def, alias, cond.field)}`;
    default: throw new BadRequestException('条件不合法');
  }
}

/** 配置自检：条件里的字段/资料类型都存在（单测遍历全部资料用），不合法抛错 */
export function assertCondValid(def: ResourceDef, cond: Cond) {
  condSql(def, cond, 'r', newCondCtx());
}

/** 给一个查询加上条件（别名 r） */
export function applyCond(qb: { andWhere(sql: string, params?: Record<string, unknown>): unknown }, def: ResourceDef, cond: Cond, prefix: string, dyn?: string) {
  const ctx = newCondCtx(prefix);
  ctx.dyn = dyn;
  const sql = condSql(def, cond, 'r', ctx);
  qb.andWhere(sql, ctx.params);
}

const monthPrefix = () => todayShanghai().slice(0, 7);

/**
 * 派生列：对本页记录，一次分组查询算出每条的数字。结果写进 dto.data[col.key]。
 */
export async function deriveColumns(em: EntityManager, companyId: number, def: ResourceDef, records: ResourceRecord[]): Promise<Map<number, Record<string, number>>> {
  const out = new Map<number, Record<string, number>>(records.map((r) => [r.id, {}]));
  for (const col of def.derivedColumns ?? []) {
    const target = getResourceDef(col.type);
    if (!target || !target.fields.some((f) => f.key === col.field)) throw new BadRequestException('派生列配置不合法');
    const mine = (r: ResourceRecord): string => (!col.match ? String(r.id) : r.data?.[col.match] === undefined || r.data?.[col.match] === null ? '' : String(r.data[col.match]));
    const keys = [...new Set(records.map(mine).filter(Boolean))];
    const totals = new Map<string, number>();
    if (keys.length) {
      const sum = col.kind === 'sum' && col.sumField ? `COALESCE(SUM(CAST(${jx('a', col.sumField)} AS DECIMAL(30,0))), 0)` : 'COUNT(*)';
      if (col.kind === 'sum' && (!col.sumField || !target.fields.some((f) => f.key === col.sumField))) throw new BadRequestException('派生列配置不合法');
      const build = async (field: string, values: string[]) => {
        const ctx = newCondCtx('d');
        const qb = em.createQueryBuilder().select(`${jx('a', field)}`, 'k').addSelect(sum, 'v').from(ResourceRecord, 'a')
          .where('a.company_id = :cid AND a.type = :t AND a.archived_at IS NULL', { cid: companyId, t: col.type })
          .andWhere(`${jx('a', field)} IN (:...vals)`, { vals: values });
        if (col.where) qb.andWhere(condSql(target, col.where, 'a', ctx), ctx.params);
        if (col.month) {
          if (!target.fields.some((f) => f.key === col.month)) throw new BadRequestException('派生列配置不合法');
          qb.andWhere(`${jx('a', col.month)} LIKE :mp`, { mp: `${monthPrefix()}%` });
        }
        return qb.groupBy('k').getRawMany<{ k: string; v: string }>();
      };
      if (!col.via) {
        for (const row of await build(col.field, keys)) totals.set(row.k, Number(row.v));
      } else {
        const viaDef = getResourceDef(col.via.type);
        if (!viaDef || !viaDef.fields.some((f) => f.key === col.via!.field)) throw new BadRequestException('派生列配置不合法');
        const hop = await em.createQueryBuilder().select('a.id', 'id').addSelect(jx('a', col.via.field), 'k').from(ResourceRecord, 'a')
          .where('a.company_id = :cid AND a.type = :t AND a.archived_at IS NULL', { cid: companyId, t: col.via.type })
          .andWhere(`${jx('a', col.via.field)} IN (:...vals)`, { vals: keys }).getRawMany<{ id: number; k: string }>();
        const owner = new Map(hop.map((h) => [String(h.id), h.k]));
        if (owner.size) {
          for (const row of await build(col.field, [...owner.keys()])) totals.set(owner.get(row.k)!, (totals.get(owner.get(row.k)!) ?? 0) + Number(row.v));
        }
      }
    }
    for (const r of records) out.get(r.id)![col.key] = totals.get(mine(r)) ?? 0;
  }
  return out;
}

export type { DerivedColumn };
