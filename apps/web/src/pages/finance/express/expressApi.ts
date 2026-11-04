import { api } from '../../../api/client';

export interface TreeVersion {
  createdAt?: string; remark?: string; attachmentName?: string; recognitionCount?: number; ruleCount?: number;
  id: number; name: string; status: string; cooperationStatus: 'pending' | 'active' | 'paused'; priceSource: string;
  effectiveStart: string; effectiveEnd: string; shippingWeightMin: number | null; shippingWeightMax: number | null;
  isCurrent: boolean; aiRuleCount: number; manualRuleCount: number; surchargeCount: number; inUse: boolean;
}
export interface TreeBranch {
  id: number; name: string; status: string; jstLogisticsName: string; contactName: string; contactPhone: string;
  currentVersionId: number | null; isDefault: boolean; versions: TreeVersion[];
}
export interface TreeCarrier { id: number; name: string; status: string; defaultBranchId: number | null; note: string; branches: TreeBranch[] }

export interface RuleRow {
  id?: number; source?: string; note?: string; province: string; shipWeightMin?: number | null; shipWeightMax?: number | null; minExclusive?: boolean; maxExclusive?: boolean;
  fixedPrice?: number | null; firstWeight?: number | null; firstPrice?: number | null; extraPrice?: number | null;
}
export interface SurchargeRow {
  note?: string; fileName?: string;
  id: number; status: string; versionId: number; batchId?: number; name: string; effectiveStart?: string; effectiveEnd?: string; areaScope?: string;
  chargeType: 'fixed' | 'percent' | 'per_kg'; amount?: number; percent?: number; weightMode?: string; weightStart?: number; weightEnd?: number;
}
export interface BatchRow { note?: string; createdAtKey?: string; id: number; status: string; batchName: string; source?: string; fileName?: string; modelName?: string; evidence?: number[] }
export interface VersionDetail {
  version: { id: number; name: string; status: string; data: Record<string, unknown> };
  branch: { id: number; name: string; jstLogisticsName: string };
  carrier: { id: number; name: string };
  effectiveSource: 'ai' | 'manual';
  rules: Array<RuleRow & { id: number; source: string; version?: string }>;
  batches: BatchRow[];
  surcharges: SurchargeRow[];
  recognitions: Array<{ id: number; recognitionType: string; status?: string; resultCount?: number; fileName?: string; modelName?: string; resultText?: string; createdAtKey?: string }>;
}

export interface RecognitionModels { providers: Array<{ id: number; name: string; status: string; models: string[] }>; current: { providerId: number; modelId: string } | null }

export interface PriceDraft extends RuleRow { warnings: string[] }
export interface PriceRecognition { kind: 'price_table'; rows: PriceDraft[]; warnings: string[]; effectiveStart: string; effectiveEnd: string; extraRemark: string; confidence: number; modelName: string; fileName: string }
export interface SurchargeDraft {
  note?: string; name: string; effectiveStart: string; effectiveEnd: string; areaScope: string; chargeType: 'fixed' | 'percent' | 'per_kg'; amount: number | null; percent: number | null;
  weightMode: 'all' | 'below' | 'above' | 'between'; weightStart: number | null; weightEnd: number | null; warnings: string[];
}
export interface SurchargeRecognition { batchNote?: string; kind: 'surcharge_notice'; batchName: string; rows: SurchargeDraft[]; warnings: string[]; modelName: string; fileName: string }

export interface EstimateParcel { count: number; weight: number; amount: number | null; source: 'manual' | 'automatic' | null; key: string | null }
export interface EstimateRow {
  shippingUnavailable?: boolean; key: string; start: number; end: number; method: string; autoAmount: number | null; manualAmount: number | null; sampleCount: number; includedCount: number;
  baseAverage: number | null; includedProvinces: string[]; excludedLowProvinces: string[]; excludedHighProvinces: string[];
  provinceQuotes: Array<{ province: string; amount: number; carrierName: string; branchName: string; versionName: string; rule: string }>; parcels?: EstimateParcel[];
}
export interface Estimates { revision?: number; requiresRecalculation?: boolean; parcelLimit: number; calculatedAt: string; cooperatingGroups: number; rows: EstimateRow[]; overrides: Array<{ id: number; weightFrom: number; weightTo: number; amount: number | null }>; orphanOverrides: Array<{ id: number; weightFrom: number; weightTo: number }> }

export interface ZoneRule {
  provinces: string[]; provinceScope: string; carrierName: string; branchName: string; jstLogisticsName: string; versionName: string; suggestedRuleName: string;
  weightStart: number; weightEnd: number | ''; weightStartOperator: '>=' | '>'; weightEndOperator: '<=' | '<'; amount: number | null; priceLabel: string; rule: string;
}
export interface ZoneRunSummary { id: number; sequence: number; createdAt: string; maxWeightKg: number; cooperatingVersionCount: number; combinationCount: number; ruleCount: number }

const base = '/finance/express';
export const expressApi = {
  tree: () => api<{ carriers: TreeCarrier[] }>(`${base}/tree`),
  version: (id: number) => api<VersionDetail>(`${base}/versions/${id}`),
  saveRules: (id: number, source: 'ai' | 'manual', rules: RuleRow[], activate?: boolean) => api<{ created: number; removed: number }>(`${base}/versions/${id}/rules`, { method: 'PUT', body: { source, rules, ...(activate ? { activate: true } : {}) } }),
  recognitionModels: () => api<RecognitionModels>(`${base}/ai-models`),
  recognize: (id: number, kind: 'price' | 'surcharge', file: File, selection?: { providerId: number; modelId: string }) => {
    const form = new FormData();
    form.append('file', file);
    if (selection) { form.append('providerId', String(selection.providerId)); form.append('modelId', selection.modelId); }
    return api<PriceRecognition | SurchargeRecognition>(`${base}/versions/${id}/recognize-${kind}`, { form });
  },
  confirmPrice: (id: number, body: { rules: RuleRow[]; fileName?: string; modelName?: string; effectiveStart?: string; effectiveEnd?: string; extraRemark?: string }) =>
    api<{ created: number }>(`${base}/versions/${id}/recognize-price/confirm`, { body }),
  confirmSurcharge: (id: number, body: { batchName: string; batchNote?: string; rows: Array<Omit<SurchargeDraft, 'warnings'>>; fileName?: string; modelName?: string; evidenceFileId?: number }) =>
    api<{ created: number }>(`${base}/versions/${id}/recognize-surcharge/confirm`, { body }),
  createSurcharge: (id: number, body: { batchName: string; batchNote?: string; rows: Array<Omit<SurchargeDraft, 'warnings'>>; fileName?: string }) => api<{ created: number }>(`${base}/versions/${id}/surcharge-batches`, { body }),
  remove: (kind: 'versions' | 'branches' | 'carriers' | 'surcharge-batches', id: number, reason: string) => api<{ ok: true }>(`${base}/${kind}/${id}/delete`, { body: { reason } }),
  estimates: () => api<Estimates>(`${base}/estimates`),
  recalculate: (parcelLimit?: number, revision?: number) => api<Estimates>(`${base}/estimates/recalculate`, { body: { ...(parcelLimit === undefined ? {} : { parcelLimit }), ...(revision === undefined ? {} : { revision }) } }),
  setParcelLimit: (parcelLimit: number) => api<Estimates>(`${base}/estimates/parcel-limit`, { method: 'PUT', body: { parcelLimit } }),
  saveOverrides: (revision: number, rows: Array<{ weightFrom: number; weightTo: number; amount: number | null }>) => api<Estimates>(`${base}/estimates/overrides`, { method: 'PUT', body: { revision, rows } }),
  setOverride: (weightFrom: number, weightTo: number, amount: number | null, reason?: string) => api<Estimates>(`${base}/estimates/override`, { method: 'PUT', body: { weightFrom, weightTo, amount, reason } }),
  zoneRuns: (page: number, pageSize = 5) => api<{ total: number; page: number; pageSize: number; items: ZoneRunSummary[] }>(`${base}/zone-runs?page=${page}&pageSize=${pageSize}`),
  zoneRun: (id: number) => api<ZoneRunSummary & { rules: ZoneRule[] }>(`${base}/zone-runs/${id}`),
  generateZone: (maxWeightKg: number) => api<ZoneRunSummary>(`${base}/zone-runs`, { body: { maxWeightKg } }),
  deleteZoneRun: (id: number) => api<{ ok: true }>(`${base}/zone-runs/${id}`, { method: 'DELETE' }),
};
