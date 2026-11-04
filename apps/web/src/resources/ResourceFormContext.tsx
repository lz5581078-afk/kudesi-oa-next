import { useEffect, useState } from 'react';
import type { FieldDef } from '@kudesi/shared';
import { useAuth } from '../auth/AuthContext';
import { resourceApi } from './api';

/** 外侧目录决定的只读归属；不把身份字段变成可改的选择器。 */
export function ResourceFormContext({ field, value, label, currentLabel }: { field: FieldDef; value: unknown; label: string; currentLabel?: string }) {
  const { user } = useAuth();
  const scope = JSON.stringify([user?.companyId, user?.id, field.ref, value]);
  const [result, setResult] = useState<{ scope: string; text: string }>();
  useEffect(() => {
    if (!field.ref || typeof value !== 'number' || !Number.isFinite(value)) return;
    let alive = true;
    resourceApi.get(field.ref, value).then(row => { if (alive) setResult({ scope, text: row.title }); }).catch(() => { if (alive) setResult({ scope, text: '读取失败' }); });
    return () => { alive = false; };
  }, [scope, field.ref, value]);
  return <small className="rf-context">{label}：{result?.scope === scope ? result.text : currentLabel || (value ? '读取中…' : '未选择')}</small>;
}
