import type { FieldDef, FlowPostingDecl, StepDef } from '@kudesi/shared';

type Src = { value: string; label: string; type: FieldDef['type']; ref?: string };

/** 自动记账声明（可选）：某一步办理通过或整条流程完成时，按对应关系生成并过账一张费用单/其他收入单。 */
export function PostingEditor({ posting, steps, fields, stepFields, disabled, onChange }: {
  posting: FlowPostingDecl | null; steps: StepDef[]; fields: FieldDef[]; stepFields: Record<string, FieldDef[]>; disabled?: boolean; onChange: (p: FlowPostingDecl | null) => void;
}) {
  const at = posting?.at ?? 'complete';
  const sources: Src[] = [
    ...fields.map((f) => ({ value: `payload.${f.key}`, label: `申请表单 · ${f.label}`, type: f.type, ref: f.ref })),
    ...(at === 'complete' ? [] : (stepFields[at] ?? []).map((f) => ({ value: `form.${f.key}`, label: `本步办理 · ${f.label}`, type: f.type, ref: f.ref }))),
  ];
  const pick = (name: keyof FlowPostingDecl, label: string, types: Array<FieldDef['type']>, required: boolean, ref?: string) => (
    <label key={name}>{label}{required ? '' : '（可选）'}
      <select aria-label={`记账${label}`} disabled={disabled} value={(posting?.[name] as string | undefined) ?? ''} onChange={(e) => onChange({ ...posting!, [name]: e.target.value || undefined })}>
        <option value="">{required ? '（请选择）' : '不填'}</option>
        {sources.filter((s) => types.includes(s.type) && (!ref || s.ref === ref)).map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
      </select>
    </label>
  );
  return (
    <fieldset className="fd-section">
      <legend>自动记账（可选）</legend>
      <label className="check-line"><input type="checkbox" disabled={disabled} checked={!!posting} onChange={(e) => onChange(e.target.checked ? { at: 'complete', docType: 'expense', post: false, date: '', bankAccountId: '', feeItemId: '', amountCents: '' } : null)} />办理完成后自动生成财务单据</label>
      {posting && (
        <div className="form-grid">
          <label>什么时候记账
            <select aria-label="记账时机" disabled={disabled} value={posting.at} onChange={(e) => onChange({ at: e.target.value, docType: posting.docType, post: posting.post, date: '', bankAccountId: '', feeItemId: '', amountCents: '' })}>
              <option value="complete">整条流程完成时</option>
              {steps.filter((s) => s.type !== 'submit' && s.type !== 'end').map((s) => <option key={s.key} value={s.key}>“{s.name}”办理通过时</option>)}
            </select>
          </label>
          <label>单据类型
            <select aria-label="记账单据类型" disabled={disabled} value={posting.docType} onChange={(e) => onChange({ ...posting, docType: e.target.value as FlowPostingDecl['docType'] })}>
              <option value="expense">费用单</option><option value="other-income">其他收入单</option>
            </select>
          </label>
          <label className="check-line"><input type="checkbox" disabled={disabled} checked={posting.post} onChange={(e) => onChange({ ...posting, post: e.target.checked })} />生成后直接过账（不勾选则停在草稿，由财务处理）</label>
          {pick('date', '日期', ['date'], true)}
          {pick('bankAccountId', '银行账户', ['ref'], true, 'bank-accounts')}
          {pick('feeItemId', '费用项目', ['ref'], true, 'finance-fee-items')}
          {pick('amountCents', '金额', ['money'], true)}
          {pick('memo', '说明', ['text', 'textarea'], false)}
          {pick('refNo', '流水号', ['text'], false)}
          <p className="muted small wide">银行账户要选“选择资料”类型且指向银行账户的字段，费用项目同理；办理页面里被引用的字段要设为必填。保存时系统会检查。</p>
        </div>
      )}
    </fieldset>
  );
}
