import { useCallback, useEffect, useState } from 'react';
import { CATEGORY_LABEL_MAX, categoryDeleteBlock, categoryFieldOf, type CategoryManageItem, type ResourceDef } from '@kudesi/shared';
import { ApiError, api } from '../api/client';
import { loadCategoryOptions } from './categoryOptions';
import { CloseIcon, DownIcon, UpIcon } from './ResIcons';

const msg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message || '操作失败');
const base = (type: string) => `/resources/${encodeURIComponent(type)}/categories`;

/**
 * 管理分类（列表页签右侧的小齿轮）：改名、上下移动排序、隐藏/显示、新增自建分类、删除。
 * 系统自带分类（代码里写死的选项）只能改名和排序；自建分类只有零记录在用时才能删除，有记录在用只能隐藏。
 * 每个改动成功后立即刷新本公司的分类缓存，页签、表单下拉马上变化。
 */
export function CategoryManageDialog({ type, def, onClose, onChanged }: { type: string; def: ResourceDef; onClose: () => void; onChanged: () => void }) {
  const field = categoryFieldOf(def);
  const [items, setItems] = useState<CategoryManageItem[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<{ value: string; name: string } | null>(null);

  const load = useCallback(async () => {
    try { setItems((await api<{ items: CategoryManageItem[] }>(base(type))).items); } catch (e) { setError(msg(e)); }
  }, [type]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy && !editing) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, editing, onClose]);

  async function run(fn: () => Promise<unknown>): Promise<boolean> {
    setBusy(true); setError('');
    try {
      await fn();
      await Promise.all([load(), loadCategoryOptions(true)]);
      onChanged();
      return true;
    } catch (e) {
      setError(msg(e));
      await load(); // 别人同时改过时，列表跟着刷新
      return false;
    } finally { setBusy(false); }
  }

  const add = async () => {
    const name = newName.trim();
    if (!name) return setError('请填写分类名称');
    if (await run(() => api(base(type), { method: 'POST', body: { name } }))) setNewName('');
  };
  const rename = async () => {
    if (!editing) return;
    if (await run(() => api(`${base(type)}/${editing.value}`, { method: 'PATCH', body: { name: editing.name.trim() } }))) setEditing(null);
  };
  const move = (index: number, delta: number) => {
    if (!items) return;
    const order = items.map((i) => i.value);
    const j = index + delta;
    if (j < 0 || j >= order.length) return;
    [order[index], order[j]] = [order[j], order[index]];
    void run(() => api(`${base(type)}/reorder`, { method: 'POST', body: { values: order } }));
  };
  const toggleHidden = (it: CategoryManageItem) => run(() => api(`${base(type)}/${it.value}`, { method: 'PATCH', body: { hidden: !it.hidden } }));
  const remove = async (it: CategoryManageItem) => {
    if (!window.confirm(`删除分类「${it.label}」？这个分类下没有任何记录，删除后不能恢复。`)) return;
    await run(() => api(`${base(type)}/${it.value}`, { method: 'DELETE' }));
  };

  return (
    <div className="modal-backdrop cat-backdrop" role="presentation">
      <div className="modal card cat-manage" role="dialog" aria-label="管理分类">
        <div className="modal-head between"><strong>管理分类 · {def.label}{field ? `（${field.label}）` : ''}</strong><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><CloseIcon /></button></div>
        <div className="modal-body">
          <p className="muted cat-rule">系统自带的分类只能改名和调整顺序；自己新增的分类可以改名、排序、隐藏，没有记录在用时还能删除。改名只改显示的名称，已有记录不受影响。每个公司各有一份。</p>
          {error && <div role="alert" className="notice error">{error}</div>}
          <form className="cat-add" onSubmit={(e) => { e.preventDefault(); void add(); }}>
            <input aria-label="新分类名称" placeholder="新分类名称" maxLength={CATEGORY_LABEL_MAX} value={newName} onChange={(e) => { setNewName(e.target.value); setError(''); }} />
            <button type="submit" className="primary-button small" disabled={busy}>新增分类</button>
          </form>
          {items === null && !error && <p className="muted">加载中…</p>}
          {items && (
            <table className="data-table cat-table">
              <thead><tr><th>名称</th><th>值（内部标识）</th><th>在用记录</th><th>操作</th></tr></thead>
              <tbody>
                {items.map((it, i) => {
                  const delBlock = categoryDeleteBlock(it, it.count);
                  const isEditing = editing?.value === it.value;
                  return (
                    <tr key={it.value} className={it.hidden ? 'cat-hidden' : undefined}>
                      <td data-label="名称" className="cat-name">
                        {isEditing ? (
                          <form className="cat-rename" onSubmit={(e) => { e.preventDefault(); void rename(); }}>
                            <input aria-label={`「${it.label}」的新名称`} autoFocus maxLength={CATEGORY_LABEL_MAX} value={editing.name} onChange={(e) => setEditing({ value: it.value, name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setEditing(null); } }} />
                            <button type="submit" className="primary-button small" disabled={busy}>保存</button>
                            <button type="button" className="secondary-button small" onClick={() => setEditing(null)}>取消</button>
                          </form>
                        ) : (
                          <>{it.label} <span className={it.system ? 'cat-badge' : 'cat-badge own'}>{it.system ? '系统自带' : '自建'}</span>{it.hidden && <span className="cat-badge off">已隐藏</span>}{it.system && it.defaultLabel && it.defaultLabel !== it.label && <small className="muted cat-orig"> 原名 {it.defaultLabel}</small>}</>
                        )}
                      </td>
                      <td data-label="值"><code className="cat-key" title={it.system ? '系统分类的值由程序使用，不能修改' : '自动生成，不会改变'}>{it.value}</code>{it.system && <small className="muted"> 只读</small>}</td>
                      <td data-label="在用记录">{it.count}</td>
                      <td data-label="操作" className="cat-actions"><div className="cat-act">
                        <button type="button" className="secondary-button small" aria-label={`上移「${it.label}」`} disabled={busy || i === 0} onClick={() => move(i, -1)}><UpIcon /></button>
                        <button type="button" className="secondary-button small" aria-label={`下移「${it.label}」`} disabled={busy || i === items.length - 1} onClick={() => move(i, 1)}><DownIcon /></button>
                        <button type="button" className="secondary-button small" disabled={busy} onClick={() => setEditing({ value: it.value, name: it.label })}>改名</button>
                        <button type="button" className="secondary-button small" disabled={busy || it.system} title={it.system ? '系统自带分类不能隐藏' : it.hidden ? '重新显示在页签和下拉里' : it.count > 0 ? `已有 ${it.count} 条记录在用，隐藏后记录保留，只是不能再被新选` : '从页签和下拉里隐藏'} onClick={() => void toggleHidden(it)}>{it.hidden ? '显示' : '隐藏'}</button>
                        <button type="button" className="secondary-button small danger" disabled={busy || !!delBlock} title={delBlock ?? '删除这个自建分类'} onClick={() => void remove(it)}>删除</button>
                        {!it.system && it.count > 0 && <small className="muted cat-note">有 {it.count} 条记录在用，只能隐藏</small>}
                      </div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <div className="modal-foot"><button type="button" className="secondary-button" onClick={onClose}>关闭</button></div>
      </div>
    </div>
  );
}
