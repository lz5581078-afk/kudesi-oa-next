import { STATUS_COL, type ColFilter, type ResourceDef } from '@kudesi/shared';
import type { SelectQueryBuilder } from 'typeorm';
import type { ResourceRecord } from '../entities';

const ESC = "ESCAPE '\\\\'";
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * 列筛选条件 → SQL（别名 r）。条件已由 shared 的 validateColFilters 校验（字段、操作符、值），
 * 这里只负责翻译：字段 key 来自资源定义（白名单），值全部走参数绑定，不拼进 SQL。
 * 证件号/银行卡/密钥只翻译“已填/未填”（看密文是否存在），不解密、不比较内容。
 * 多个条件之间是“并且”。
 */
export function applyColFilters(qb: SelectQueryBuilder<ResourceRecord>, def: ResourceDef, filters: ColFilter[], prefix = 'cf'): void {
  filters.forEach((f, i) => {
    const p = `${prefix}${i}`;
    if (f.key === STATUS_COL) {
      qb.andWhere(`r.status IN (:...${p}s)`, { [`${p}s`]: f.values });
      return;
    }
    const field = def.fields.find((x) => x.key === f.key);
    if (!field || !/^[A-Za-z0-9_]+$/.test(field.key)) throw new Error('列筛选字段不合法');
    const J = `JSON_EXTRACT(r.data, '$.${field.key}')`;
    const U = `JSON_UNQUOTE(${J})`;
    const EMPTY = `(${J} IS NULL OR JSON_TYPE(${J}) = 'NULL' OR ${U} IN ('', '[]', '{}'))`;
    const t = field.type;

    if (t === 'sensitive' || t === 'secret') {
      const S = `COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.secrets, '$.${field.key}')), '')`;
      qb.andWhere(f.op === 'empty' ? `${S} = ''` : `${S} <> ''`);
      return;
    }
    if (f.op === 'empty') { qb.andWhere(EMPTY); return; }
    if (f.op === 'notEmpty') { qb.andWhere(`NOT ${EMPTY}`); return; }

    if (t === 'bool') {
      qb.andWhere(f.op === 'yes' ? `${U} IN ('true', '1')` : `(${J} IS NULL OR ${U} NOT IN ('true', '1'))`);
      return;
    }
    if (t === 'number' || t === 'decimal' || t === 'money') {
      const N = `CAST(${U} AS DECIMAL(30,6))`;
      const guard = `NOT ${EMPTY} AND`;
      if (f.op === 'between') qb.andWhere(`${guard} ${N} BETWEEN :${p}a AND :${p}b`, { [`${p}a`]: f.value, [`${p}b`]: f.value2 });
      else qb.andWhere(`${guard} ${N} ${f.op === 'gt' ? '>' : f.op === 'lt' ? '<' : '='} :${p}a`, { [`${p}a`]: f.value });
      return;
    }
    if (t === 'date') {
      const D = `LEFT(${U}, 10)`;
      const guard = `NOT ${EMPTY} AND`;
      if (f.op === 'between') qb.andWhere(`${guard} ${D} BETWEEN :${p}a AND :${p}b`, { [`${p}a`]: f.value, [`${p}b`]: f.value2 });
      else qb.andWhere(`${guard} ${D} ${f.op === 'before' ? '<' : f.op === 'after' ? '>' : '='} :${p}a`, { [`${p}a`]: f.value });
      return;
    }
    if (t === 'select') {
      const vals = f.values ?? [];
      if (field.multi) {
        const parts = vals.map((v, j) => { qb.setParameter(`${p}m${j}`, `%、${likeEscape(v)}、%`); return `CONCAT('、', ${U}, '、') LIKE :${p}m${j} ${ESC}`; });
        qb.andWhere(`(${parts.join(' OR ')})`);
      } else qb.andWhere(`${U} IN (:...${p}s)`, { [`${p}s`]: vals });
      return;
    }
    if (t === 'ref') {
      qb.andWhere(`CAST(${U} AS UNSIGNED) IN (:...${p}s)`, { [`${p}s`]: (f.values ?? []).map(Number) });
      return;
    }
    if (t === 'refs') {
      qb.andWhere(`JSON_OVERLAPS(${J}, CAST(:${p}s AS JSON))`, { [`${p}s`]: JSON.stringify((f.values ?? []).map(Number)) });
      return;
    }
    if (t === 'phone') {
      const digits = (f.value ?? '').replace(/\D/g, '');
      const P = `REPLACE(REPLACE(REPLACE(${U}, ' ', ''), '-', ''), '+', '')`;
      if (f.op === 'eq') qb.andWhere(`${P} = :${p}a`, { [`${p}a`]: digits });
      else qb.andWhere(`${P} LIKE :${p}a ${ESC}`, { [`${p}a`]: f.op === 'startsWith' ? `${likeEscape(digits)}%` : `%${likeEscape(digits)}%` });
      return;
    }
    if (t === 'monthday') { qb.andWhere(`${U} = :${p}a`, { [`${p}a`]: f.value }); return; }
    if (t === 'text' || t === 'textarea') {
      const v = f.value ?? '';
      if (f.op === 'eq') qb.andWhere(`${U} = :${p}a`, { [`${p}a`]: v });
      else if (f.op === 'neq') qb.andWhere(`(${EMPTY} OR ${U} <> :${p}a)`, { [`${p}a`]: v });
      else qb.andWhere(`${U} LIKE :${p}a ${ESC}`, { [`${p}a`]: f.op === 'startsWith' ? `${likeEscape(v)}%` : `%${likeEscape(v)}%` });
      return;
    }
    if (t === 'files') return; // 只有 empty/notEmpty，上面已处理
    throw new Error('列筛选字段不合法');
  });
}
