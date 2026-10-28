import type { ReactNode } from 'react';

interface Props {
  columns?: ReactNode;
  onRecognize?: () => void;
  total: number;
  invalid: number;
  deleted: number;
  errors: number;
  saving: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canArchive: boolean;
  freeze: boolean;
  reason: string;
  selectedRows: number;
  message: string;
  onUndo: () => void;
  onRedo: () => void;
  onDeleteRows: () => void;
  onFreeze: (v: boolean) => void;
  onReason: (v: string) => void;
  onSave: () => void;
  onDiscard: () => void;
  onExit: () => void;
  onDismiss: () => void;
}

/** 表格编辑的顶部条：改动数量、撤销重做、保存全部 / 放弃、退出 */
export function GridBar(p: Props) {
  const dirty = p.total > 0;
  return (
    <div className="grid-bar" role="toolbar" aria-label="表格编辑工具栏">
      <span className="pill ok">表格编辑中</span>
      <span className={dirty ? 'grid-count dirty' : 'grid-count'} role="status" aria-live="polite">{dirty ? `${p.total} 处修改` : '没有修改'}</span>
      {p.invalid > 0 && <span className="pill bad">{p.invalid} 个格子格式不对</span>}
      {p.errors > 0 && <span className="pill bad">{p.errors} 行保存失败</span>}
      <button type="button" className="secondary-button" disabled={!p.canUndo} onClick={p.onUndo} title="撤销（Ctrl+Z）">撤销</button>
      <button type="button" className="secondary-button" disabled={!p.canRedo} onClick={p.onRedo} title="重做（Ctrl+Y）">重做</button>
      {p.canArchive && <button type="button" className="secondary-button" disabled={p.selectedRows === 0} onClick={p.onDeleteRows} title="新增行直接去掉；已有行标记为待归档，保存时才生效">删除/归档所选行</button>}
      {p.columns}
      {p.onRecognize && <button type="button" className="secondary-button" onClick={p.onRecognize} title="选一张营业执照图片，识别后把结果填进当前所选的行（核对后再保存）">识别执照填入所选行</button>}
      <label className="check"><input type="checkbox" checked={p.freeze} onChange={(e) => p.onFreeze(e.target.checked)} /> 冻结首列</label>
      <span className="grow" />
      {p.deleted > 0 && (
        <label className="grid-reason">归档原因
          <input value={p.reason} maxLength={500} placeholder={`${p.deleted} 行待归档，必须填写原因`} onChange={(e) => p.onReason(e.target.value)} />
        </label>
      )}
      <button type="button" className="secondary-button" disabled={!dirty && p.errors === 0 || p.saving} onClick={p.onDiscard}>放弃</button>
      <button type="button" className="primary-button" disabled={!dirty || p.saving} onClick={p.onSave}>{p.saving ? '保存中…' : '保存全部'}</button>
      <button type="button" className="secondary-button" onClick={p.onExit}>退出表格编辑</button>
      {p.message && <div className="grid-msg notice" role="status"><span>{p.message}</span><button type="button" className="icon-button" aria-label="关闭提示" onClick={p.onDismiss}>✕</button></div>}
    </div>
  );
}
