/**
 * 往来档案（供应商、客户）的相似/重复检测，规则同旧系统：
 * 名称完全相同或相似度 >= 55%、简称相同、电话相同给提示（可确认后继续）；
 * 编号相同、税号相同，或已填写的字段全部相同则直接阻止。
 */
export const SIMILARITY_RESOURCES: readonly string[] = ['finance-suppliers', 'finance-customers'];

/** 参与比较的字段 → 显示名；其余字段（分类、备注、状态、加密字段）不参与 */
export const SIMILARITY_FIELDS: Readonly<Record<string, string>> = {
  code: '编号', name: '名称', shortName: '简称', shortCode: '简称编号', contact: '联系人', phone: '电话', address: '地址', taxNo: '税号', bankAccountName: '账户名称', bank: '开户行',
};
const IDENTITY = new Set(['code', 'taxNo']);

export function normalizeArchiveValue(v: unknown): string {
  return String(v ?? '').trim().toLocaleLowerCase('zh-CN').replace(/[\s\p{P}\p{S}]+/gu, '');
}

const bigrams = (s: string) => (s.length < 2 ? (s ? [s] : []) : Array.from({ length: s.length - 1 }, (_, i) => s.slice(i, i + 2)));

export function archiveTextSimilarity(left: unknown, right: unknown): number {
  const a = normalizeArchiveValue(left);
  const b = normalizeArchiveValue(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (Math.min(a.length, b.length) >= 3 && (a.includes(b) || b.includes(a))) return Math.min(a.length, b.length) / Math.max(a.length, b.length);
  const ap = bigrams(a);
  const bp = bigrams(b);
  const counts = new Map<string, number>();
  for (const p of ap) counts.set(p, (counts.get(p) ?? 0) + 1);
  let overlap = 0;
  for (const p of bp) {
    const c = counts.get(p) ?? 0;
    if (!c) continue;
    overlap++;
    counts.set(p, c - 1);
  }
  return (2 * overlap) / (ap.length + bp.length);
}

export interface SimilarityExisting { id: number; data: Record<string, unknown> }
export interface SimilarityMatch {
  id: number;
  name: string;
  blockers: string[];
  warnings: string[];
  sameFields: string[];
  differentFields: Array<{ label: string; candidate: string; existing: string }>;
}

export function inspectArchiveSimilarity(candidate: Record<string, unknown>, existing: SimilarityExisting[], excludeId?: number): { blocked: SimilarityMatch[]; warnings: SimilarityMatch[] } {
  const entries = Object.keys(SIMILARITY_FIELDS).map((k) => [k, candidate[k]] as const).filter(([, v]) => normalizeArchiveValue(v));
  const name = normalizeArchiveValue(candidate.name);
  const out: SimilarityMatch[] = [];
  for (const item of existing) {
    if (excludeId !== undefined && item.id === excludeId) continue;
    const blockers: string[] = [];
    const warnings: string[] = [];
    if (name && normalizeArchiveValue(item.data.name) === name) warnings.push('名称完全相同');
    const score = archiveTextSimilarity(candidate.name, item.data.name);
    if (score >= 0.55 && score < 1) warnings.push(`名称相似 ${Math.round(score * 100)}%`);
    const same: string[] = [];
    const diff: SimilarityMatch['differentFields'] = [];
    for (const [k, v] of entries) {
      const equal = normalizeArchiveValue(v) === normalizeArchiveValue(item.data[k]);
      if (equal) same.push(SIMILARITY_FIELDS[k]);
      else diff.push({ label: SIMILARITY_FIELDS[k], candidate: String(v ?? '').trim(), existing: String(item.data[k] ?? '').trim() });
      if (!equal || k === 'name') continue;
      if (IDENTITY.has(k)) blockers.push(`${SIMILARITY_FIELDS[k]}完全相同`);
      else if (k === 'shortName') warnings.push('简称相同');
      else if (k === 'phone') warnings.push('联系电话相同');
    }
    if (entries.length >= 2 && same.length === entries.length) blockers.push('已填写字段完全相同');
    if (blockers.length || warnings.length) out.push({ id: item.id, name: String(item.data.name ?? ''), blockers: [...new Set(blockers)], warnings: [...new Set(warnings)], sameFields: same, differentFields: diff });
  }
  const rank = (m: SimilarityMatch) => (m.blockers.length ? 2 : 1);
  out.sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name, 'zh-CN'));
  return { blocked: out.filter((m) => m.blockers.length), warnings: out.filter((m) => !m.blockers.length) };
}

export function formatSimilarityMatch(m: SimilarityMatch): string {
  const reasons = [...m.blockers, ...m.warnings].join('、') || '资料相似';
  const diff = m.differentFields.slice(0, 4).map((d) => `${d.label}（本次：${d.candidate || '空'}；已有：${d.existing || '空'}）`).join('、');
  return `“${m.name}”：${reasons}；相同点：${m.sameFields.slice(0, 6).join('、') || '未发现'}；不同点：${diff || '未发现'}`;
}
