import type { GridSaveResponse, LedgerFocus, LedgerResult, LedgerSort, LedgerView } from '@kudesi/shared';
import { api } from '../../../api/client';
import { resourceApi, type ResourceDto } from '../../../resources/api';

export interface LedgerParams {
  view: LedgerView;
  q?: string;
  focus?: LedgerFocus | '';
  carrier?: string;
  user?: string;
  location?: number | null;
  sort?: LedgerSort;
  dir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export const FEE_NOTE = '费用模块';

export interface RowEdit { id: number; version: string; title: string; data: Record<string, unknown> }
export interface SaveOutcome { done: number; failed: Array<{ title: string; message: string; conflict: boolean }> }

export const feeApi = {
  ledger(p: LedgerParams) {
    const q = new URLSearchParams({ view: p.view });
    if (p.q) q.set('q', p.q);
    if (p.focus) q.set('focus', p.focus);
    if (p.carrier) q.set('carrier', p.carrier);
    if (p.user) q.set('user', p.user);
    if (p.location) q.set('location', String(p.location));
    if (p.sort) q.set('sort', p.sort);
    if (p.dir) q.set('dir', p.dir);
    q.set('page', String(p.page ?? 1));
    q.set('pageSize', String(p.pageSize ?? 20));
    return api<LedgerResult>(`/resources/fee-ledger?${q.toString()}`);
  },

  /**
   * 写回手机号 / 宽带档案：与资料页同一条保存通道（逐行校验、版本冲突、各自档案的操作记录里写“费用模块”）。
   * 逐行独立，失败的行返回原因，不影响其他行。
   */
  async save(type: 'phones' | 'broadband', edits: RowEdit[]): Promise<SaveOutcome> {
    const res: GridSaveResponse<ResourceDto> = await resourceApi.gridSave(type, {
      note: FEE_NOTE,
      updates: edits.map((e) => ({ id: e.id, version: e.version, data: e.data })),
    });
    const titles = new Map(edits.map((e) => [e.id, e.title]));
    const failed = res.results.filter((r) => !r.ok).map((r) => ({ title: titles.get(r.id ?? -1) ?? `#${r.id}`, message: r.message ?? '保存失败', conflict: r.code === 'conflict' }));
    return { done: res.results.length - failed.length, failed };
  },
};
