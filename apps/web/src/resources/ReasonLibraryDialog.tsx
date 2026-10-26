import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api/client';
import { resourceApi, type ResourceDto } from './api';
import { useResourceCan } from './RecordDetail';

/** 异常原因库：店铺/手机号状态改成“异常”时，只能从这里选原因。 */
export function ReasonLibraryDialog({ libType, title, onClose }: { libType: string; title: string; onClose: () => void }) {
  const can = useResourceCan(libType);
  const [rows, setRows] = useState<ResourceDto[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(() => { resourceApi.list(libType, { page: 1, pageSize: 200 }).then((r) => setRows(r.items)).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败')); }, [libType]);
  useEffect(() => { load(); }, [load]);
  const run = (fn: () => Promise<unknown>) => { setError(''); fn().then(() => { setText(''); load(); }).catch((e) => setError(e instanceof ApiError ? e.message : '操作失败')); };
  return (
    <div className="modal-backdrop" role="presentation"><div className="modal card small" role="dialog" aria-label={title}>
      <div className="modal-head between"><strong>{title}</strong><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>✕</button></div>
      <div className="modal-body">
        {can('create') && (
          <form className="toolbar" onSubmit={(e) => { e.preventDefault(); if (text.trim()) run(() => resourceApi.create(libType, { reason: text.trim() })); }}>
            <input placeholder="新增一条异常原因" value={text} maxLength={100} onChange={(e) => setText(e.target.value)} />
            <button type="submit" className="primary-button" disabled={!text.trim()}>添加</button>
          </form>
        )}
        {error && <div role="alert" className="notice error">{error}</div>}
        <ul className="plain-list">
          {rows.length === 0 && <li className="muted">还没有异常原因</li>}
          {rows.map((r) => (
            <li key={r.id} className="between"><span>{r.title}</span>
              {can('delete') && <button type="button" className="link-button" onClick={() => { if (window.confirm(`删除「${r.title}」？已被使用的原因不能删除。`)) run(() => resourceApi.remove(libType, r.id, '删除异常原因')); }}>删除</button>}
            </li>
          ))}
        </ul>
      </div>
    </div></div>
  );
}
