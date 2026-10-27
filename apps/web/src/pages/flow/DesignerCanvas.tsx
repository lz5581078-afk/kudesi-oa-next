import { useState } from 'react';
import { STEP_TYPE_LABEL, formatMinutes, type FlowTemplate, type StepDef } from '@kudesi/shared';
import { describeAssignee, describeCondition, describeRemind, type NameLookup } from './designerUi';

/**
 * 流程画布：节点按办理顺序自上而下排布，节点之间有连线和“添加节点”入口；可拖动节点调整顺序（发起/结束固定，业务必须的节点顺序固定）。
 * 键盘和手机用“上移/下移”按钮代替拖拽。
 */
export function DesignerCanvas({ steps, selected, tpl, lookup, canEdit, mode, onSelect, onMove, onInsert, onCopy, onRemove, canMove }: {
  steps: StepDef[]; selected: number; tpl: Pick<FlowTemplate, 'fields' | 'stepFields'>; lookup: NameLookup; canEdit: boolean; mode: 'canvas' | 'list';
  onSelect: (i: number) => void; onMove: (from: number, to: number) => void; onInsert: (after: number) => void; onCopy: (i: number) => void; onRemove: (i: number) => void;
  canMove: (from: number, to: number) => boolean;
}) {
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const last = steps.length - 1;

  if (mode === 'list') {
    return (
      <div className="table-scroll"><table className="data-table compact" aria-label="节点列表">
        <thead><tr><th>#</th><th>节点</th><th>类型</th><th>办理人</th><th>时限</th><th>条件</th><th>操作</th></tr></thead>
        <tbody>{steps.map((s, i) => (
          <tr key={s.key} className={i === selected ? 'fd-row-selected' : ''}>
            <td>{i + 1}</td><td><button type="button" className="link-button" onClick={() => onSelect(i)}>{s.name}</button></td><td>{STEP_TYPE_LABEL[s.type]}</td>
            <td>{describeAssignee(s, lookup)}</td><td>{s.type === 'submit' || s.type === 'end' ? '—' : formatMinutes(s.dueMinutes)}</td><td>{describeCondition(s.when, tpl, steps) || '—'}</td>
            <td><button type="button" className="link-button" onClick={() => onSelect(i)}>配置</button></td>
          </tr>
        ))}</tbody>
      </table></div>
    );
  }

  return (
    <ol className="fd-flow" aria-label="流程画布">
      {steps.map((s, i) => {
        const handler = s.type !== 'submit' && s.type !== 'end';
        const movable = canEdit && handler && !s.locked;
        const cond = describeCondition(s.when, tpl, steps);
        const remind = describeRemind(s);
        const assignee = describeAssignee(s, lookup);
        return (
          <li key={s.key}>
            <div
              className={`fd-node fd-${s.type} ${i === selected ? 'selected' : ''} ${over === i && dragFrom !== null && dragFrom !== i ? 'drop' : ''} ${s.when ? 'conditional' : ''}`}
              draggable={movable}
              onDragStart={(e) => { setDragFrom(i); e.dataTransfer?.setData('text/plain', String(i)); }}
              onDragOver={(e) => { if (dragFrom !== null && canMove(dragFrom, i)) { e.preventDefault(); setOver(i); } }}
              onDragLeave={() => setOver((o) => (o === i ? null : o))}
              onDrop={(e) => { e.preventDefault(); if (dragFrom !== null && canMove(dragFrom, i)) onMove(dragFrom, i); setDragFrom(null); setOver(null); }}
              onDragEnd={() => { setDragFrom(null); setOver(null); }}
            >
              <button type="button" className="fd-node-main" aria-label={`选择节点 ${i + 1} ${s.name}`} aria-pressed={i === selected} onClick={() => onSelect(i)}>
                <span className="fd-num">{i + 1}</span>
                <span className="fd-node-body">
                  <strong>{s.name}</strong>
                  <span className="pill">{STEP_TYPE_LABEL[s.type]}</span>
                  {s.locked && <span className="pill" title="业务必须的步骤，不能删除或调换顺序">业务固定</span>}
                  {s.mode === 'all' && <span className="pill warn">全员会签</span>}
                  <span className="muted small">{handler ? `办理人：${assignee}${s.dueMinutes ? ` · 时限 ${formatMinutes(s.dueMinutes)}` : ''}` : s.type === 'submit' ? '由发起人填写并提交' : '自动完结归档'}</span>
                  {cond && <span className="fd-tag cond">条件：{cond}</span>}
                  {s.returnToKey && <span className="fd-tag">退回到：{steps.find((x) => x.key === s.returnToKey)?.name ?? '?'}</span>}
                  {remind && <span className="fd-tag">督促：{remind}</span>}
                  {(s.ccUserIds?.length ?? 0) > 0 && <span className="fd-tag">抄送 {s.ccUserIds!.length} 人</span>}
                  {(s.hiddenFields?.length ?? 0) > 0 && <span className="fd-tag">隐藏 {s.hiddenFields!.length} 个字段</span>}
                  {(tpl.stepFields[s.key]?.length ?? 0) > 0 && <span className="fd-tag">办理页面 {tpl.stepFields[s.key].length} 项</span>}
                </span>
              </button>
              {canEdit && handler && (
                <span className="fd-node-actions">
                  <button type="button" className="link-button" aria-label={`上移 ${s.name}`} disabled={!canMove(i, i - 1)} onClick={() => onMove(i, i - 1)}>上移</button>
                  <button type="button" className="link-button" aria-label={`下移 ${s.name}`} disabled={!canMove(i, i + 1)} onClick={() => onMove(i, i + 1)}>下移</button>
                  {!s.locked && <button type="button" className="link-button" aria-label={`复制节点 ${s.name}`} onClick={() => onCopy(i)}>复制</button>}
                  {!s.locked && <button type="button" className="link-button danger" aria-label={`删除节点 ${s.name}`} onClick={() => onRemove(i)}>删除</button>}
                </span>
              )}
            </div>
            {i < last && (
              <div className="fd-link" aria-hidden={!canEdit}>
                <span className="fd-arrow" />
                {canEdit && <button type="button" className="fd-add" aria-label={`在“${s.name}”后添加节点`} onClick={() => onInsert(i)}>＋ 添加节点</button>}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
