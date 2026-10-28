import { useState } from 'react';
import { ASSET_ACTIONS, ASSET_ACTIONS_BY_STATE, getResourceDef } from '@kudesi/shared';
import { ApiError } from '../api/client';
import { ActionDialog, assetState } from './AssetPanels';
import { resourceApi, type ResourceDto } from './api';
import { ReasonDialog } from './TreeManage';

/** 列表每行末尾的“办理”：固定资产的领用/转交/归还/送修/报废等，档案的在库/借出/遗失。点按钮不会打开详情。 */

/** 行里地方小，几个长名字用短称（弹窗和详情里仍是全称） */
const SHORT: Partial<Record<keyof typeof ASSET_ACTIONS, string>> = { lost: '丢失', repaired: '修好' };

function AssetRowActions({ row, onDone }: { row: ResourceDto; onDone: (message?: string) => void }) {
  const [action, setAction] = useState<keyof typeof ASSET_ACTIONS | null>(null);
  const actions = ASSET_ACTIONS_BY_STATE[assetState(row.status)];
  if (actions.length === 0) return <span className="muted">已报废</span>;
  return (
    <span className="row-acts" onClick={(e) => e.stopPropagation()}>
      {actions.map((a) => (
        <button key={a} type="button" className={ASSET_ACTIONS[a].danger ? 'row-act danger' : 'row-act'} aria-label={`${ASSET_ACTIONS[a].label}：${row.title}`} onClick={() => setAction(a)}>{SHORT[a] ?? ASSET_ACTIONS[a].label}</button>
      ))}
      {action && <ActionDialog action={action} record={row} onClose={() => setAction(null)} onDone={() => { setAction(null); onDone(`已办理：${ASSET_ACTIONS[action].label} ${row.title}`); }} />}
    </span>
  );
}

const ARCHIVE_ACTIONS: Array<{ status: string; label: string }> = [
  { status: 'stored', label: '在库' },
  { status: 'borrowed', label: '借出' },
  { status: 'missing', label: '遗失' },
];

/** 档案改状态：借出、遗失要写原因（和状态配置一致） */
export function ArchiveStatusButtons({ row, onDone }: { row: Pick<ResourceDto, 'id' | 'title' | 'status'>; onDone: (message?: string) => void }) {
  const [asking, setAsking] = useState<{ status: string; label: string } | null>(null);
  const [error, setError] = useState('');
  const def = getResourceDef('archives');
  async function change(status: string, reason?: string) {
    try {
      await resourceApi.changeStatus('archives', row.id, status, reason);
      onDone(`「${row.title}」已改为${def?.statuses.find((s) => s.value === status)?.label ?? status}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '操作失败');
      throw e;
    }
  }
  const options = row.status === 'archived' ? [] : ARCHIVE_ACTIONS.filter((a) => a.status !== row.status);
  if (!options.length) return null;
  return (
    <span className="row-acts" onClick={(e) => e.stopPropagation()}>
      {options.map((a) => {
        const needs = def?.statuses.find((s) => s.value === a.status)?.requiresReason;
        return (
          <button key={a.status} type="button" className={a.status === 'missing' ? 'row-act danger' : 'row-act'} aria-label={`${a.label}：${row.title}`}
            onClick={() => { setError(''); if (needs) setAsking(a); else void change(a.status).catch(() => undefined); }}>{a.label}</button>
        );
      })}
      {error && <small role="alert" className="row-act-err">{error}</small>}
      {asking && (
        <ReasonDialog
          title={`${asking.label}：${row.title}`}
          hint={asking.status === 'borrowed' ? '写明借给谁、做什么用、预计什么时候还。' : '写明最后一次见到的时间和地点，方便追查。'}
          confirmLabel={`确认${asking.label}`}
          danger={asking.status === 'missing'}
          onClose={() => setAsking(null)}
          onSubmit={async (reason) => { await change(asking.status, reason); setAsking(null); }}
        />
      )}
    </span>
  );
}

/** 哪些资料的列表带“办理”列；返回 undefined 表示不带 */
export function rowActionsFor(type: string, can: (a: 'edit' | 'disable') => boolean, onDone: (message?: string) => void): ((row: ResourceDto) => React.ReactNode) | undefined {
  if (type === 'fixed-assets' && can('edit')) return (row) => <AssetRowActions row={row} onDone={onDone} />;
  if (type === 'archives' && can('disable')) return (row) => <ArchiveStatusButtons row={row} onDone={onDone} />;
  return undefined;
}
