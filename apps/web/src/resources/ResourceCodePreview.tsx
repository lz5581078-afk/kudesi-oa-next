import { useEffect, useState } from 'react';
import { createChecker, resourcePermission, type ResourceDef } from '@kudesi/shared';
import { useAuth } from '../auth/AuthContext';
import { api } from '../api/client';
import type { ResourceDto } from './api';
import './resourceCodePreview.css';

/** 元数据驱动的只读编号区；编号始终由保存规则生成，不写入可编辑值。 */
export function ResourceCodePreview({ def, values, record }: { def: ResourceDef; values: Record<string, unknown>; record?: ResourceDto | null }) {
  const { user } = useAuth();
  const field = def.fields.find(field => field.key === def.codePreview?.field);
  const body = Object.fromEntries((def.codePreview?.inputFields ?? []).map(key => [key, values[key] ?? '']));
  const allowed = !!user?.permissions && createChecker(user.permissions)(resourcePermission(def.key, record ? 'edit' : 'create'));
  const scope = JSON.stringify([user?.companyId, user?.id, def.key, record?.id, body, allowed]);
  const [result, setResult] = useState<{ scope: string; code?: string; error?: string }>();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!allowed || !def.codePreview) return;
    let alive = true;
    const timer = setTimeout(() => {
      api<{ code: string }>(`/resources/${def.key}${record ? `/${record.id}` : ''}/code-preview`, { method: 'POST', body: { values: body } })
        .then(response => { if (alive) setResult({ scope, code: response.code }); })
        .catch(() => { if (alive) setResult({ scope, error: '编号预览暂不可用，保存时会重新生成。' }); });
    }, 200);
    return () => { alive = false; clearTimeout(timer); };
  }, [scope, retry]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!field) return null;
  const current = allowed && result?.scope === scope ? result : undefined;
  return <section className="resource-code-preview" aria-label={field.label}>
    <div className="resource-code-preview-caption"><span>{field.label}</span>{field.help && <small>{field.help}</small>}</div>
    <output aria-label={field.label} aria-live="polite">{current?.code || (allowed ? '自动生成' : '—')}</output>
    {current?.error && <div role="status">{current.error}<button type="button" className="link-button" onClick={() => { setResult(undefined); setRetry(value => value + 1); }}>重试</button></div>}
  </section>;
}
