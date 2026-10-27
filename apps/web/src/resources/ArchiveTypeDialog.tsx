import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api/client';
import { resourceApi, type ResourceDto } from './api';
import { loadUnitOptions } from './unitOptions';

const UNITS = 'finance-product-units';
const ACCENTS: Array<[string, string]> = [['green', '绿色'], ['blue', '蓝色'], ['orange', '橙色'], ['purple', '紫色'], ['red', '红色']];
const msg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message || '操作失败');

interface Draft { id?: number; name: string; code: string; subtitle: string; accent: string }

/** 管理商品档案的顶级档案类型：内置六种固定，这里加/改/停用自定义类型（旧系统“新增档案类型 / 删除档案类型”）。停用后页签不再出现，已有档案保留。 */
export function ArchiveTypeDialog({ counts, onClose, onChanged }: { counts?: Record<string, number>; onClose: () => void; onChanged: () => void }) {
  const [items, setItems] = useState<ResourceDto[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setItems((await resourceApi.list(UNITS, { pageSize: 100, showHidden: true, fieldKey: 'kind', fieldValue: 'archive_type' })).items); } catch (e) { setError(msg(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const refresh = async () => { await load(); await loadUnitOptions(true); onChanged(); };
  async function save() {
    if (!draft) return;
    setBusy(true); setError('');
    try {
      const values = { kind: 'archive_type', name: draft.name.trim(), code: draft.code.trim() || undefined, subtitle: draft.subtitle.trim(), accent: draft.accent };
      if (draft.id) await resourceApi.update(UNITS, draft.id, values); else await resourceApi.create(UNITS, values);
      setDraft(null); await refresh();
    } catch (e) { setError(msg(e)); }
    setBusy(false);
  }
  async function toggle(r: ResourceDto) {
    const stop = r.status === 'active';
    const n = counts?.[String(r.data.code ?? '')] ?? 0;
    if (stop && !window.confirm(`停用档案类型「${r.title}」？页签会消失，已有的 ${n} 条档案保留，不会被删除。`)) return;
    setError('');
    try { await resourceApi.changeStatus(UNITS, r.id, stop ? 'inactive' : 'active', stop ? '停用档案类型' : '重新启用'); await refresh(); } catch (e) { setError(msg(e)); }
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal card" role="dialog" aria-label="管理档案类型">
        <div className="modal-head between"><strong>管理档案类型</strong><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <p className="muted">原料、自产成品、外购成品、产品包装、发货物料、OEM 包装是内置类型，不能改动。这里新增的类型和它们并列，有自己的页签和分类树；编码用在商品编码里，建好后已有档案用到就不能改。</p>
          {error && <div role="alert" className="notice error">{error}</div>}
          {!draft && (
            <>
              <table className="data-table cards-narrow">
                <thead><tr><th>名称</th><th>编码</th><th>说明</th><th>档案数</th><th>状态</th><th /></tr></thead>
                <tbody>
                  {items.length === 0 && <tr><td colSpan={6} className="muted center">还没有自定义类型</td></tr>}
                  {items.map((r) => (
                    <tr key={r.id}>
                      <td data-label="名称">{r.title}</td><td data-label="编码">{String(r.data.code ?? '')}</td><td data-label="说明">{String(r.data.subtitle ?? '')}</td>
                      <td data-label="档案数">{counts?.[String(r.data.code ?? '')] ?? 0}</td><td data-label="状态">{r.status === 'active' ? '使用中' : '已停用'}</td>
                      <td><button type="button" className="secondary-button small" onClick={() => setDraft({ id: r.id, name: r.title, code: String(r.data.code ?? ''), subtitle: String(r.data.subtitle ?? ''), accent: String(r.data.accent ?? 'green') })}>修改</button>{' '}
                        <button type="button" className="secondary-button small" onClick={() => void toggle(r)}>{r.status === 'active' ? '停用' : '启用'}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button type="button" className="primary-button" onClick={() => setDraft({ name: '', code: '', subtitle: '', accent: 'green' })}>＋ 新增档案类型</button>
            </>
          )}
          {draft && (
            <div className="form-grid">
              <label>类型名称<b className="req"> *</b><input aria-label="类型名称" maxLength={80} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
              <label>编码标识<input aria-label="编码标识" maxLength={32} value={draft.code} placeholder="不填按名称拼音首字母生成" onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase() })} /><small className="muted">英文字母和数字，不能和内置类型重名</small></label>
              <label>页签说明<input aria-label="页签说明" maxLength={60} value={draft.subtitle} onChange={(e) => setDraft({ ...draft, subtitle: e.target.value })} /></label>
              <label>页签颜色<select aria-label="页签颜色" value={draft.accent} onChange={(e) => setDraft({ ...draft, accent: e.target.value })}>{ACCENTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
              <div className="row-actions"><button type="button" className="secondary-button" onClick={() => setDraft(null)}>返回</button><button type="button" className="primary-button" disabled={busy || !draft.name.trim()} onClick={() => void save()}>保存</button></div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
