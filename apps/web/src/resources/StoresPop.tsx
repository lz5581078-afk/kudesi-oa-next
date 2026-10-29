import { categoryLabel, useCategoryVersion } from './categoryOptions';
import { useState } from 'react';
import { getResourceDef } from '@kudesi/shared';
import { ApiError } from '../api/client';
import { resourceApi, type ResourceDto } from './api';

const STATUS: Record<string, string> = { normal: '正常', abnormal: '异常', inactive: '停用', cancelled: '注销' };

/** “关联店铺 N 家 · 点击查看”：弹出该营业执照下的店铺（平台、店铺、当前运营、状态），24 号旧版税务/执照/合作人列表同款。 */
export function StoresPopButton({ licenseId, count, title = '关联店铺', compact = false }: { licenseId: number | null; count: number; title?: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  useCategoryVersion();
  const [rows, setRows] = useState<ResourceDto[] | null>(null);
  const [error, setError] = useState('');
  async function show() {
    setOpen(true);
    if (!licenseId) { setRows([]); return; }
    try { setRows((await resourceApi.list('stores', { fieldKey: 'licenseId', fieldValue: licenseId, pageSize: 100, showHidden: true })).items); } catch (e) { setError(e instanceof ApiError ? e.message : '加载失败'); }
  }
  return (
    <>
      {!compact && <span>{count} 家 </span>}
      <button type="button" className={compact ? 'row-act' : 'link-button'} onClick={(e) => { e.stopPropagation(); void show(); }}>{compact ? '关联店铺' : '点击查看'}</button>
      {open && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal card" role="dialog" aria-label={title}>
            <div className="modal-head"><strong>{title}</strong></div>
            <div className="modal-body">
              {error && <div role="alert" className="notice error">{error}</div>}
              {rows === null && !error && <p className="muted">加载中…</p>}
              {rows?.length === 0 && <p className="muted">该营业执照下还没有绑定店铺</p>}
              {rows?.map((s) => (
                <div key={s.id} className="line-item between">
                  <span>{categoryLabel('stores', 'platform', s.data.platform) ?? getResourceDef('stores')?.fields.find((f) => f.key === 'platform')?.options?.find((o) => o.value === s.data.platform)?.label ?? String(s.data.platform ?? '')} / {s.title}<small className="muted"> {String(s.data.storeNo ?? '')} {s.refLabels.operatorUserId ? `· 当前运营 ${s.refLabels.operatorUserId}` : ''}</small></span>
                  <small className="muted">{STATUS[s.status] ?? s.status}</small>
                </div>
              ))}
            </div>
            <div className="modal-foot"><button type="button" className="secondary-button" onClick={() => setOpen(false)}>关闭</button></div>
          </div>
        </div>
      )}
    </>
  );
}
