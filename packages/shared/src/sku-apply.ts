/**
 * SKU 批量申请流程（运营 → 仓库 → 财务）的共享部分：规格清单、仓库配置的结构和校验。前后端共用。
 * 一张申请单里有多个“规格”（每个规格 = 一组主品 + 赠品），按选定的销售场景 × 销售平台各生成一个组合编码。
 */

export const SKU_MAX_SPECS = 100;
export const SKU_MAX_LINES = 20;

export interface SkuLine { baseCodeId: number; qty: number }
export interface SkuSpec {
  name: string;
  main: SkuLine[];
  gift: SkuLine[];
  note?: string;
  /** 系统里已经有相同构成的组合编码时，申请人必须写明为什么还要申请 */
  reuseReason?: string;
}

export type WarehouseRole = 'package' | 'label' | 'instruction' | 'other' | 'labor';
export interface WarehouseLine { role: WarehouseRole; baseCodeId?: number; laborId?: number; qty: number }
export type WarehouseGroupKey = 'package' | 'label' | 'other' | 'labor';
export interface WarehouseSpec { lines: WarehouseLine[]; notRequired: Partial<Record<WarehouseGroupKey, string>> }

/** 仓库要逐类确认的四类：每类要么有配置，要么写明“不需要”的原因 */
export const WAREHOUSE_GROUPS: ReadonlyArray<{ key: WarehouseGroupKey; label: string; roles: readonly WarehouseRole[] }> = [
  { key: 'package', label: '包装', roles: ['package'] },
  { key: 'label', label: '标签/说明书', roles: ['label', 'instruction'] },
  { key: 'other', label: '其他打包材料', roles: ['other'] },
  { key: 'labor', label: '人工', roles: ['labor'] },
];
export const WAREHOUSE_ROLE_LABEL: Record<WarehouseRole, string> = { package: '包装', label: '标签', instruction: '说明书', other: '其他物料', labor: '人工' };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const posInt = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);

function normLines(raw: unknown, what: string, errors: string[]): SkuLine[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) { errors.push(`${what}格式不对`); return []; }
  if (raw.length > SKU_MAX_LINES) errors.push(`${what}最多 ${SKU_MAX_LINES} 行`);
  const merged = new Map<number, number>();
  for (const l of raw) {
    const id = isObj(l) ? posInt(l.baseCodeId) : null;
    const qty = isObj(l) ? posInt(l.qty) : null;
    if (!id) { errors.push(`${what}里有商品没选`); continue; }
    if (!qty) { errors.push(`${what}的数量必须是大于 0 的整数`); continue; }
    merged.set(id, (merged.get(id) ?? 0) + qty); // 同一商品数量合并
  }
  return [...merged].map(([baseCodeId, qty]) => ({ baseCodeId, qty }));
}

/** 整理并校验规格清单；返回整理后的清单和中文错误列表 */
export function normalizeSpecs(raw: unknown): { specs: SkuSpec[]; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(raw) || raw.length === 0) return { specs: [], errors: ['请至少填写一个规格'] };
  if (raw.length > SKU_MAX_SPECS) return { specs: [], errors: [`一张申请单最多 ${SKU_MAX_SPECS} 个规格`] };
  const names = new Set<string>();
  const specs: SkuSpec[] = raw.map((r, i) => {
    const label = `第 ${i + 1} 个规格`;
    const o = isObj(r) ? r : {};
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (!name) errors.push(`${label}要填规格名称`);
    else if (name.length > 100) errors.push(`${label}的名称不能超过 100 字`);
    else if (names.has(name.toLowerCase())) errors.push(`规格名称「${name}」重复了`);
    names.add(name.toLowerCase());
    const main = normLines(o.main, `${label}的主商品`, errors);
    const gift = normLines(o.gift, `${label}的赠品`, errors);
    if (main.length === 0) errors.push(`${label}至少要有一个主商品`);
    const note = typeof o.note === 'string' ? o.note.trim().slice(0, 500) : undefined;
    const reuseReason = typeof o.reuseReason === 'string' ? o.reuseReason.trim().slice(0, 500) : undefined;
    return { name, main, gift, ...(note ? { note } : {}), ...(reuseReason ? { reuseReason } : {}) };
  });
  return { specs, errors };
}

/** 整理并校验仓库配置（按规格顺序一一对应）；四类每类要么有配置，要么写明不需要的原因 */
export function normalizeWarehouse(raw: unknown, specNames: readonly string[]): { config: WarehouseSpec[]; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(raw) || raw.length !== specNames.length) return { config: [], errors: ['仓库配置和申请的规格对不上，请刷新后重新填写'] };
  const config = raw.map((r, i): WarehouseSpec => {
    const label = `规格「${specNames[i]}」`;
    const o = isObj(r) ? r : {};
    const lines: WarehouseLine[] = [];
    const rawLines = Array.isArray(o.lines) ? o.lines : [];
    if (rawLines.length > 60) errors.push(`${label}的物料行太多`);
    for (const l of rawLines) {
      if (!isObj(l)) { errors.push(`${label}的物料格式不对`); continue; }
      const role = l.role as WarehouseRole;
      if (!WAREHOUSE_GROUPS.some((g) => g.roles.includes(role))) { errors.push(`${label}有物料类别不对`); continue; }
      const qty = typeof l.qty === 'number' && Number.isFinite(l.qty) && l.qty > 0 && Math.round(l.qty * 1000) / 1000 === l.qty ? l.qty : null;
      if (qty === null) { errors.push(`${label}的物料数量必须大于 0（最多 3 位小数）`); continue; }
      if (role === 'labor') {
        const laborId = posInt(l.laborId);
        if (!laborId) { errors.push(`${label}有人工项目没选`); continue; }
        lines.push({ role, laborId, qty });
      } else {
        const baseCodeId = posInt(l.baseCodeId);
        if (!baseCodeId) { errors.push(`${label}有${WAREHOUSE_ROLE_LABEL[role]}没选`); continue; }
        lines.push({ role, baseCodeId, qty });
      }
    }
    const nr = isObj(o.notRequired) ? o.notRequired : {};
    const notRequired: Partial<Record<WarehouseGroupKey, string>> = {};
    for (const g of WAREHOUSE_GROUPS) {
      const has = lines.some((l) => g.roles.includes(l.role));
      const why = typeof nr[g.key] === 'string' ? (nr[g.key] as string).trim().slice(0, 200) : '';
      if (!has && !why) errors.push(`${label}的「${g.label}」要么选好物料，要么写明不需要的原因`);
      if (!has && why) notRequired[g.key] = why;
    }
    return { lines, notRequired };
  });
  return { config, errors };
}
