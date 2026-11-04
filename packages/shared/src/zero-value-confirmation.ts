import type { ResourceDef } from './resources';

/** 以当时名称组成确认上下文；引用已选但尚未读到名称时不能伪造为空。 */
export function zeroValueContext(policy: NonNullable<ResourceDef['zeroValueConfirmation']>, values: Record<string, unknown>, names: Record<string, string | undefined>): string | null {
  const parts: string[] = [];
  for (const field of policy.contextFields) {
    if (typeof field === 'string') parts.push(String(values[field] ?? '').trim());
    else if (!values[field.ref]) parts.push('');
    else if (names[field.ref] === undefined) return null;
    else parts.push(names[field.ref]!.trim());
  }
  return JSON.stringify(parts);
}

export function readZeroValueConfirmation(value: unknown): { reason: string; context: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.reason !== 'string' || !item.reason.trim() || item.reason.trim().length > 2000 || typeof item.context !== 'string' || item.context.length > 2000) return null;
  return { reason: item.reason.trim(), context: item.context };
}
