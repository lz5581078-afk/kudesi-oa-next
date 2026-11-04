import { expandParcelEstimates, validParcelLimit, type EstimateRow } from '@kudesi/shared';
import type { ResourceRecord } from '../entities';

export type SnapshotEstimateRow = EstimateRow & { shippingUnavailable?: boolean };
const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const amount = (value: unknown): number | null => numeric(value) && value >= 0 ? value : null;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
const knownMethods = new Set(['provincial_majority_mean_plus_10_percent', 'provincial_upper_trimmed_mean_plus_10_percent']);

/** Read only the saved quotation; current records can invalidate shipping coverage, never replace its amounts. */
export function readFreightSnapshot(snapshot: Pick<ResourceRecord, 'companyId' | 'data'> | undefined, records: ResourceRecord[]) {
  const limit = snapshot?.data.parcelLimit;
  const parcelLimit = numeric(limit) && validParcelLimit(limit) ? limit : 30;
  const revisionValue = snapshot?.data.revision;
  const revision = numeric(revisionValue) && Number.isSafeInteger(revisionValue) && revisionValue >= 0 ? revisionValue : snapshot ? 1 : 0;
  const calculatedAt = typeof snapshot?.data.calculatedAt === 'string' ? snapshot.data.calculatedAt : '';
  if (!snapshot) return { rows: [] as SnapshotEstimateRow[], baseRows: [] as SnapshotEstimateRow[], parcelLimit, calculatedAt, revision, requiresRecalculation: false };
  const owned = records.filter(record => record.companyId === snapshot.companyId);
  const versions = owned.filter(record => record.type === 'finance-express-versions');
  const hasLimits = versions.some(record => record.data.shippingWeightMin != null || record.data.shippingWeightMax != null);
  const quoteAvailable = (quote: EstimateRow['provinceQuotes'][number], start: number, end: number) => {
    if (String(quote.versionId).startsWith('legacy:')) return owned.some(record => record.type === 'finance-express-prices' && !record.data.versionId && record.data.carrier === quote.carrierName && String(record.data.branch ?? '') === quote.branchName);
    const carrier = owned.find(record => record.type === 'finance-express-carriers' && (quote.carrierId != null ? String(record.id) === String(quote.carrierId) : record.title === quote.carrierName));
    if (!carrier) return false;
    const branch = owned.find(record => record.type === 'finance-express-branches' && record.data.carrierId === carrier?.id && (quote.branchId != null ? String(record.id) === String(quote.branchId) : record.title === quote.branchName));
    if (!branch) return false;
    const version = versions.find(record => record.id === branch?.data.currentVersionId && (quote.versionId != null ? String(record.id) === String(quote.versionId) : record.title === quote.versionName));
    if (!version) return false;
    const lower = version.data.shippingWeightMin, upper = version.data.shippingWeightMax;
    if (lower != null && (!numeric(lower) || lower < 0)) return false;
    if (upper != null && (!numeric(upper) || upper <= (numeric(lower) ? lower : 0))) return false;
    return (numeric(lower) ? lower : 0) <= start && (numeric(upper) ? upper : Infinity) >= end;
  };
  let saved: unknown;
  let parseFailed = false;
  try { saved = typeof snapshot.data.rowsJson === 'string' ? JSON.parse(snapshot.data.rowsJson) : snapshot.data.rowsJson; } catch { saved = []; parseFailed = true; }
  let requiresRecalculation = parseFailed || !Array.isArray(saved);
  const baseRows: SnapshotEstimateRow[] = [];
  for (const item of Array.isArray(saved) ? saved : []) {
    if (!item || typeof item !== 'object') { requiresRecalculation = true; continue; }
    const row = item as Record<string, unknown>;
    if (row.parcels) continue;
    if (!numeric(row.start) || !numeric(row.end) || row.start < 0 || row.end <= row.start || row.end > parcelLimit) { requiresRecalculation = true; continue; }
    const includedProvinces = strings(row.includedProvinces);
    const provinceQuotes = Array.isArray(row.provinceQuotes) ? row.provinceQuotes.filter((q): q is EstimateRow['provinceQuotes'][number] => q && typeof q === 'object' && typeof q.province === 'string' && amount(q.amount) !== null) : [];
    const methodValid = typeof row.method === 'string' && knownMethods.has(row.method);
    const chosen = provinceQuotes.filter(quote => includedProvinces.includes(quote.province));
    const shippingUnavailable = hasLimits && !(includedProvinces.length && chosen.length === includedProvinces.length && chosen.every(quote => quoteAvailable(quote, Number(row.start), Number(row.end))));
    if (!methodValid || shippingUnavailable) requiresRecalculation = true;
    baseRows.push({ key: `${row.start}-${row.end}`, start: row.start, end: row.end, method: methodValid ? row.method as EstimateRow['method'] : 'provincial_majority_mean_plus_10_percent', autoAmount: methodValid && !shippingUnavailable ? amount(row.autoAmount) : null, manualAmount: amount(row.manualAmount), baseAverage: amount(row.baseAverage), sampleCount: numeric(row.sampleCount) ? row.sampleCount : 0, includedCount: numeric(row.includedCount) ? row.includedCount : includedProvinces.length, includedProvinces, excludedLowProvinces: strings(row.excludedLowProvinces), excludedHighProvinces: strings(row.excludedHighProvinces), provinceQuotes, parcelMaxWeight: parcelLimit, ...(shippingUnavailable ? { shippingUnavailable: true } : {}) });
  }
  const rows = baseRows.length ? expandParcelEstimates(baseRows, parcelLimit) as SnapshotEstimateRow[] : [];
  return { rows, baseRows, parcelLimit, calculatedAt, revision, requiresRecalculation };
}
