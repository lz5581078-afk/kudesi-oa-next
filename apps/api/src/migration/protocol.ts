export interface LegacyRef { legacyRef: { type: string; id: string } }
export interface LegacyFile { field: string; id: string; name: string; locator: string }
export interface LegacyRecord { id: string; type: string; data: Record<string, unknown>; status?: string; sourceUpdatedAt?: string; aliasName?: string; notices?: string[]; files?: LegacyFile[] }
export interface LegacyArchive {
  company: { id: number; name: string };
  departments: Array<Record<string, any>>;
  positions: Array<Record<string, any>>;
  employees: Array<Record<string, any>>;
  employeeOverrides?: Array<Record<string, any>>;
  positionPermissions: Array<Record<string, any>>;
  employeePositions: Array<Record<string, any>>;
  records: LegacyRecord[];
  exclusions: Array<{ type: string; id: string; reason: string }>;
  loadFile(locator: string): Promise<Buffer>;
}
export function legacyRef(type: string, id: unknown): LegacyRef | undefined {
  return id === null || id === undefined || id === '' ? undefined : { legacyRef: { type, id: String(id) } };
}
/** 十进制字符串精确换算；无法用整数分表示时明确拒绝，不用浮点静默舍入。 */
export function exactCents(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!m || /[1-9]/.test((m[3] ?? '').slice(2))) throw new Error('金额超出整数分表示范围');
  const amount = BigInt(m[2]) * 100n + BigInt(((m[3] ?? '') + '00').slice(0, 2));
  if (amount > 99999999999n) throw new Error('金额超出字段范围');
  return Number(amount) * (m[1] ? -1 : 1);
}
