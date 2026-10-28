import { ASSET_LOG_LABELS, type ResourceDef } from '@kudesi/shared';
import type { LogEntry } from './api';

export const ACTION_LABEL: Record<string, string> = {
  import: '导入', link: '绑定关联', unlink: '解除关联', link_update: '修改关联信息',
  create: '新建', update: '修改', status: '改状态', delete: '删除', reveal: '查看明文', archived: '归档', restored: '恢复',
  ...ASSET_LOG_LABELS,
};

const SKIP_DIFF_TYPES = new Set(['secret', 'sensitive', 'files', 'attrs', 'json']);
/** 变更记录里“哪些字段从什么改成什么”：只列普通字段；密码/证件号/文件等不显示具体值。 */
export function LogChanges({ def, log }: { def: ResourceDef; log: LogEntry }) {
  if (log.action !== 'update' || !log.before || !log.after) return null;
  const rows: Array<{ label: string; from: string; to: string | null }> = [];
  for (const f of def.fields) {
    const a = log.before[f.key];
    const b = log.after[f.key];
    if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) continue;
    if (!(f.key in log.before) && !(f.key in log.after)) continue;
    if (SKIP_DIFF_TYPES.has(f.type) || f.type === 'ref' || f.type === 'refs' || f.type === 'money') { rows.push({ label: f.label, from: '', to: null }); continue; }
    const show = (v: unknown) => (v === undefined || v === null || v === '' ? '（空）' : f.type === 'select' ? (f.options?.find((o) => o.value === v)?.label ?? String(v)) : f.type === 'bool' ? (v ? '是' : '否') : String(v));
    rows.push({ label: f.label, from: show(a), to: show(b) });
  }
  if (!rows.length) return null;
  return (
    <ul className="log-changes">
      {rows.map((r) => <li key={r.label}>{r.to === null ? <>{r.label}：已修改</> : <>{r.label}：{r.from} → {r.to}</>}</li>)}
    </ul>
  );
}

