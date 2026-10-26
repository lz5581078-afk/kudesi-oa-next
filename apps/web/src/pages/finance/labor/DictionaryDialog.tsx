import { useCallback, useEffect, useState } from 'react';
import { getResourceDef } from '@kudesi/shared';
import { ApiError } from '../../../api/client';
import { ReasonDialog, RecordForm, clearRefCache } from '../../../resources/RecordForm';
import { useResourceCan } from '../../../resources/RecordDetail';
import { resourceApi, type ResourceDto } from '../../../resources/api';

/** 工作分类 / 计价单位这类小字典的维护：列表 + 新增 + 修改 + 删除（被工作项目用着的删不掉，会说明原因）。 */
export function DictionaryDialog({ type, title, hint, onClose }: { type: 'finance-labor-work-types' | 'finance-labor-units'; title: string; hint: string; onClose: () => void }) {
  const can = useResourceCan('finance-labor-costs');
  const [rows, setRows] = useState<ResourceDto[]>([]);
  const [error, setError] = useState('');
  const [form, setForm] = useState<{ record: ResourceDto | null } | null>(null);
  const [removing, setRemoving] = useState<ResourceDto | null>(null);
  const load = useCallback(async () => {
    try { setRows((await resourceApi.list(type, { pageSize: 200 })).items); setError(''); } catch (e) { setError(e instanceof ApiError ? e.message : '加载失败'); }
  }, [type]);
  useEffect(() => { void load(); }, [load]);
  const done = () => { clearRefCache(type); setForm(null); void load(); };
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal card" role="dialog" aria-label={title}>
        <div className="modal-head"><strong>{title}</strong></div>
        <div className="modal-body">
          <p className="muted">{hint}</p>
          {error && <div role="alert" className="notice error">{error}</div>}
          <table className="data-table"><thead><tr><th>名称</th><th>编码</th><th /></tr></thead><tbody>
            {rows.length === 0 && <tr><td colSpan={3} className="muted">还没有内容，点“新增”。</td></tr>}
            {rows.map((r) => (
              <tr key={r.id}><td>{r.title}</td><td>{String(r.data.code ?? '')}</td>
                <td className="row-actions">{can('edit') && <button type="button" className="link-button" onClick={() => setForm({ record: r })}>修改</button>}
                  {can('delete') && <button type="button" className="link-button danger" onClick={() => setRemoving(r)}>删除</button>}</td></tr>
            ))}
          </tbody></table>
        </div>
        <div className="modal-foot">
          {can('create') && <button type="button" className="primary-button" onClick={() => setForm({ record: null })}>新增</button>}
          <button type="button" className="secondary-button" onClick={onClose}>关闭</button>
        </div>
      </div>
      {form && <RecordForm def={getResourceDef(type)!} record={form.record} onClose={() => setForm(null)} onSaved={done} />}
      {removing && <ReasonDialog title={`删除「${removing.title}」`} hint="已经被工作项目使用的不能删除。" confirmLabel="确认删除" danger onClose={() => setRemoving(null)}
        onConfirm={async (reason) => { await resourceApi.remove(type, removing.id, reason); clearRefCache(type); setRemoving(null); await load(); }} />}
    </div>
  );
}
