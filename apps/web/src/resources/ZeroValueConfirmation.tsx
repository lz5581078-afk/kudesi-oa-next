import { useEffect, useRef, useState } from 'react';
import { getResourceDef, readZeroValueConfirmation, zeroValueContext, type ResourceDef } from '@kudesi/shared';
import { useAuth } from '../auth/AuthContext';
import { resourceApi } from './api';
import { useRefVersion } from './ResourceReferenceControls';
import './zeroValueConfirmation.css';

/** 零值确认绑定当前名称及引用名称；不把缺少/读取失败的引用当作空名称确认。 */
export function ZeroValueConfirmation({ def, values, enabled, onChange }: { def: ResourceDef; values: Record<string, unknown>; enabled: boolean; onChange: (patch: Record<string, unknown>) => void }) {
  const policy = def.zeroValueConfirmation!;
  const { user } = useAuth();
  const revision = useRefVersion();
  const shown = Number(values[policy.valueField] ?? '') === 0;
  const references = policy.contextFields.flatMap(field => typeof field === 'string' ? [] : [[field.ref, values[field.ref]]]);
  const scope = JSON.stringify([user?.companyId, user?.id, user?.permissions, references, revision, shown]);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const [result, setResult] = useState<{ scope: string; names?: Record<string, string>; error?: string }>();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!shown) return;
    let alive = true;
    void Promise.all(references.map(async ([key, id]) => {
      const field = def.fields.find(field => field.key === key);
      if (!id) return [String(key), ''] as const;
      if (!field?.ref || typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) throw new Error('请选择有效的引用资料');
      const row = await resourceApi.get(field.ref, id);
      if (!getResourceDef(field.ref) || row.archived) throw new Error('引用资料已失效');
      return [String(key), row.title] as const;
    })).then(entries => { if (alive && scopeRef.current === scope) setResult({ scope, names: Object.fromEntries(entries) }); })
      .catch(() => { if (alive && scopeRef.current === scope) setResult({ scope, error: '确认资料读取失败，请重试。' }); });
    return () => { alive = false; };
  }, [scope, retry]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!shown) return null;
  const current = result?.scope === scope ? result : undefined;
  const context = current?.names ? zeroValueContext(policy, values, current.names) : null;
  const confirmation = readZeroValueConfirmation(values[policy.confirmationField]);
  const confirmed = !!confirmation && context !== null && confirmation.context === context;
  const reason = String(values[policy.reasonField] ?? confirmation?.reason ?? '');
  return <div className="zero-value-confirmation">
    <input aria-label={policy.reasonLabel} placeholder="零值原因" disabled={!enabled} value={reason} maxLength={2000} onChange={event => onChange({ [policy.reasonField]: event.target.value })}/>
    <button type="button" disabled={!enabled || !reason.trim() || context === null} onClick={() => { if (context !== null) onChange({ [policy.valueField]: 0, [policy.reasonField]: reason.trim(), [policy.confirmationField]: { reason: reason.trim(), context } }); }}>{policy.confirmLabel}</button>
    {confirmed && <span>已确认：{confirmation.reason}</span>}
    {current?.error && <small role="alert">{current.error}<button type="button" disabled={!enabled} onClick={() => { setResult(undefined); setRetry(value => value + 1); }}>重试确认资料</button></small>}
  </div>;
}
