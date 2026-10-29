import { useState } from 'react';
import type { DocType } from '@kudesi/shared';
import { DraftPicker } from './DraftPicker';

export interface ToolbarProps {
  type: DocType; busy: boolean; editing: boolean;
  onClear: () => void; onPrint: () => void; onList: () => void; onPickDraft: (id: number) => void;
}

/**
 * 开单页工具条（对应管家婆单据上的：清空 / 调入草稿 / 单据调阅 / 打印）。保存草稿、开立、过账放在页面底部常显的按钮栏。
 * 快捷键：Ctrl+G 保存草稿 · F8 过账 · Ctrl+F9 打印 · Ctrl+F8 回到明细 · Shift+Delete 删当前行 · 回车跳到下一格。
 */
export function VoucherToolbar(p: ToolbarProps) {
  const [picking, setPicking] = useState(false);
  return (
    <div className="vc-toolbar" role="toolbar" aria-label="开单操作">
      <div className="vc-tool-group">
        <button type="button" className="secondary-button" disabled={p.busy} onClick={p.onClear}>{p.editing ? '放弃草稿，新开一张' : '清空单据'}</button>
        <span className="vc-pop-anchor">
          <button type="button" className="secondary-button" aria-expanded={picking} onClick={() => setPicking((v) => !v)}>调入草稿</button>
          {picking && <DraftPicker type={p.type} onClose={() => setPicking(false)} onPick={(id) => { setPicking(false); p.onPickDraft(id); }} />}
        </span>
        <button type="button" className="secondary-button" onClick={p.onList}>单据调阅</button>
        <button type="button" className="secondary-button" onClick={p.onPrint}>打印</button>
      </div>
    </div>
  );
}
