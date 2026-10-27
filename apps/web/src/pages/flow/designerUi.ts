import { ASSIGNEE_NO_TARGET, ASSIGNEE_SOURCE_LABEL, CONDITION_OP_LABEL, formatMinutes, type FieldDef, type FlowTemplate, type NodeTemplate, type StepCondition, type StepDef } from '@kudesi/shared';

export type NameLookup = (source: 'employee' | 'position' | 'department', id: number) => string | undefined;

/** 办理人一句话：发起人 / 张三 / 岗位 采购 / 部门 仓库（任一人）/ 发起人的上级… */
export function describeAssignee(s: StepDef, lookup: NameLookup): string {
  if (s.type === 'submit') return '发起人';
  if (s.type === 'end') return '—';
  const a = s.assignee;
  if (!a) return '未选择';
  if (ASSIGNEE_NO_TARGET.includes(a.source)) return ASSIGNEE_SOURCE_LABEL[a.source];
  if (!a.id) return '未选择';
  const name = lookup(a.source as 'employee' | 'position' | 'department', a.id) ?? `#${a.id}`;
  if (a.source === 'department') return `${name}（${s.mode === 'all' ? '全员会签' : '任一人办理'}）`;
  return a.source === 'position' ? `岗位 ${name}` : name;
}

/** 条件取值来源的人话名称：发起表单「金额」/ 步骤「付款」的「凭证号」 */
export function conditionSources(t: Pick<FlowTemplate, 'fields' | 'stepFields'>, steps: readonly StepDef[], index: number): Array<{ value: string; label: string; field: FieldDef }> {
  const out = t.fields.map((f) => ({ value: `payload.${f.key}`, label: `申请表单 · ${f.label}`, field: f }));
  steps.slice(0, index).forEach((s) => (t.stepFields[s.key] ?? []).forEach((f) => out.push({ value: `form.${s.key}.${f.key}`, label: `${s.name} · ${f.label}`, field: f })));
  return out;
}

const isNum = (f?: FieldDef) => f?.type === 'number' || f?.type === 'money' || f?.type === 'decimal';
/** 条件里的比较值：金额字段界面用“元”，存“分” */
export const conditionValueToStored = (f: FieldDef | undefined, text: string): number | string => (f?.type === 'money' ? Math.round(Number(text) * 100) : isNum(f) ? Number(text) : text);
export const conditionValueToDisplay = (f: FieldDef | undefined, v: unknown): string => (f?.type === 'money' && typeof v === 'number' ? String(v / 100) : v === undefined || v === null ? '' : String(v));

export function describeCondition(c: StepCondition | null | undefined, t: Pick<FlowTemplate, 'fields' | 'stepFields'>, steps: readonly StepDef[]): string {
  if (!c) return '';
  const src = conditionSources(t, steps, steps.length).find((x) => x.value === c.field);
  const name = src?.label.split(' · ').pop() ?? c.field;
  if (c.op === 'empty' || c.op === 'notempty') return `${name}${CONDITION_OP_LABEL[c.op]}`;
  const show = (v: unknown) => {
    const f = src?.field;
    const opt = f?.options?.find((o) => o.value === String(v));
    return opt ? opt.label : conditionValueToDisplay(f, v);
  };
  const val = Array.isArray(c.value) ? c.value.map(show).join('、') : show(c.value);
  return `${name}${CONDITION_OP_LABEL[c.op]} ${val}${src?.field.type === 'money' ? ' 元' : ''}`;
}

export function describeRemind(s: StepDef): string {
  const r = s.remind;
  if (!r) return '';
  const parts: string[] = [];
  if (r.beforeMinutes.length) parts.push(`到期前 ${r.beforeMinutes.map((m) => formatMinutes(m)).join('、')}提醒`);
  if (r.overdueEveryMinutes) parts.push(`超时后每 ${formatMinutes(r.overdueEveryMinutes)}提醒`);
  return parts.join('，');
}

export function uniqueKey(existing: readonly string[], base = 'step'): string {
  for (let i = 1; i < 1000; i += 1) if (!existing.includes(`${base}${i}`)) return `${base}${i}`;
  return `${base}${Date.now()}`;
}

/** 在第 index 步后面插入一步；不能插在结束步后面 */
export function insertStepAfter(steps: readonly StepDef[], index: number, step: StepDef): StepDef[] {
  const at = Math.min(Math.max(index, 0), steps.length - 2) + 1;
  return [...steps.slice(0, at), step, ...steps.slice(at)];
}

/** 能不能把第 from 步挪到 to：发起步、结束步固定；业务必须的步骤（locked）相对顺序不能变 */
export function moveStep(steps: readonly StepDef[], from: number, to: number): StepDef[] | null {
  const last = steps.length - 1;
  if (from <= 0 || from >= last || to <= 0 || to >= last || from === to) return null;
  const next = [...steps];
  const [m] = next.splice(from, 1);
  next.splice(to, 0, m);
  const lockedBefore = steps.filter((s) => s.locked).map((s) => s.key).join();
  if (next.filter((s) => s.locked).map((s) => s.key).join() !== lockedBefore) return null;
  return next;
}

/** 挪动或删除步骤后，清理别的步骤里已经失效的引用（退回目标、条件取值来源）；返回处理后的列表和被清理的说明 */
export function sanitizeRefs(steps: readonly StepDef[]): { steps: StepDef[]; notes: string[] } {
  const notes: string[] = [];
  const out = steps.map((s, i) => {
    let next = s;
    if (s.returnToKey && !(steps.findIndex((x) => x.key === s.returnToKey) >= 0 && steps.findIndex((x) => x.key === s.returnToKey) < i)) { next = { ...next, returnToKey: null }; notes.push(`「${s.name}」的退回目标已失效，改回默认`); }
    const m = s.when ? /^form\.([a-z][a-z0-9_]*)\./.exec(s.when.field) : null;
    if (m && !(steps.findIndex((x) => x.key === m[1]) >= 0 && steps.findIndex((x) => x.key === m[1]) < i)) { next = { ...next, when: null }; notes.push(`「${s.name}」的条件引用的步骤已失效，条件已清除`); }
    return next;
  });
  return { steps: out, notes };
}

export function newApprovalStep(steps: readonly StepDef[]): StepDef {
  return { key: uniqueKey(steps.map((s) => s.key), 'step'), name: '审批', type: 'approval', assignee: { source: 'employee' }, dueMinutes: 1440, ccUserIds: [] };
}

/** 套用节点模板：生成步骤和该步的办理页面字段；套用后互不影响 */
export function stepFromNodeTemplate(nt: Pick<NodeTemplate, 'key' | 'name' | 'type' | 'dueMinutes' | 'fields'>, steps: readonly StepDef[]): { step: StepDef; fields: FieldDef[] } {
  return { step: { key: uniqueKey(steps.map((s) => s.key), 'step'), name: nt.name, type: nt.type, assignee: { source: 'employee' }, dueMinutes: nt.dueMinutes ?? null, ccUserIds: [], nodeTemplateKey: nt.key }, fields: nt.fields.map((f) => ({ ...f })) };
}

export function newFieldKey(existing: readonly string[]): string {
  for (let i = 1; i < 1000; i += 1) if (!existing.includes(`f${i}`)) return `f${i}`;
  return `f${Date.now()}`;
}

/** 分钟 ↔ 界面单位 */
export const DUE_PRESETS: ReadonlyArray<{ label: string; minutes: number }> = [
  { label: '1 小时', minutes: 60 }, { label: '4 小时', minutes: 240 }, { label: '1 天', minutes: 1440 }, { label: '2 天', minutes: 2880 }, { label: '3 天', minutes: 4320 }, { label: '7 天', minutes: 10080 },
];
export const centsToYuan = (c: number | null | undefined) => (c === null || c === undefined ? '' : String(c / 100));
export const yuanToCents = (t: string) => (t.trim() === '' ? null : Math.round(Number(t) * 100));
export const fmtYuan = (c: number | null | undefined) => (c === null || c === undefined ? '—' : `¥${(c / 100).toFixed(2)}`);
