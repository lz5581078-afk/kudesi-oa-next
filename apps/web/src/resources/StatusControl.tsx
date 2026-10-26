import { useState } from 'react';
import { getResourceDef, type ResourceDef } from '@kudesi/shared';
import { ApiError } from '../api/client';
import { resourceApi } from './api';
import { ReasonDialog } from './RecordForm';

/** 状态切换：需要原因的状态（停用、注销、解除合作等）先弹出原因框。 */
export function StatusControl({ def, id, current, onChanged, onError }: {
  def: ResourceDef; id: number; current: string; onChanged: () => void; onError: (m: string) => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  async function apply(status: string, reason?: string) {
    await resourceApi.changeStatus(def.key, id, status, reason);
    onChanged();
  }
  const target = def.statuses.find((s) => s.value === pending);
  return (
    <>
      <select
        aria-label="更改状态"
        value={current}
        onChange={async (e) => {
          const next = e.target.value;
          if (next === current) return;
          if (def.statuses.find((s) => s.value === next)?.requiresReason) return setPending(next);
          try {
            await apply(next);
          } catch (err) {
            onError(err instanceof ApiError ? err.message : '修改失败');
          }
        }}
      >
        {def.statuses.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
      </select>
      {target && (
        <ReasonDialog
          title={`改为“${target.label}”`}
          hint="原因会记录在操作记录里。"
          confirmLabel="确认"
          onClose={() => setPending(null)}
          onConfirm={async (reason) => {
            await apply(target.value, reason);
            setPending(null);
          }}
        />
      )}
    </>
  );
}

export function typeLabel(type: string): string {
  return type === 'user' ? '员工' : (getResourceDef(type)?.label ?? type);
}
