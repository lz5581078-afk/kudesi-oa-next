import { RECRUIT_CHANNELS, RECRUIT_EDUCATIONS, RECRUIT_FIELD_LABELS, RECRUIT_GENDERS, RECRUIT_MARITAL, RECRUIT_MAX_HISTORY, type RecruitForm, type RecruitHistoryItem } from '@kudesi/shared';

type Patch = (patch: Partial<RecruitForm>) => void;

function HistoryEditor({ title, orgLabel, titleLabel, rows, onChange }: { title: string; orgLabel: string; titleLabel: string; rows: RecruitHistoryItem[]; onChange: (rows: RecruitHistoryItem[]) => void }) {
  const set = (i: number, patch: Partial<RecruitHistoryItem>) => onChange(rows.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  return (
    <fieldset className="recruit-history">
      <legend>{title}</legend>
      {rows.map((r, i) => (
        <div className="recruit-history-row" key={i}>
          <input aria-label={`${title}${i + 1} 起止时间`} placeholder="起止时间，如 2016.09-2020.06" maxLength={40} value={r.period} onChange={(e) => set(i, { period: e.target.value })} />
          <input aria-label={`${title}${i + 1} ${orgLabel}`} placeholder={orgLabel} maxLength={100} value={r.org} onChange={(e) => set(i, { org: e.target.value })} />
          <input aria-label={`${title}${i + 1} ${titleLabel}`} placeholder={titleLabel} maxLength={100} value={r.title} onChange={(e) => set(i, { title: e.target.value })} />
          <textarea aria-label={`${title}${i + 1} 说明`} placeholder="说明（可不填）" maxLength={500} rows={2} value={r.note} onChange={(e) => set(i, { note: e.target.value })} />
          <button type="button" className="ghost" onClick={() => onChange(rows.filter((_, n) => n !== i))}>删除这条</button>
        </div>
      ))}
      {rows.length < RECRUIT_MAX_HISTORY && <button type="button" className="ghost" onClick={() => onChange([...rows, { period: '', org: '', title: '', note: '' }])}>＋ 添加一条</button>}
    </fieldset>
  );
}

/** 求职者填表和确认用的同一套字段；手工填写、识别后确认都用它 */
export function RecruitFormFields({ form, onChange }: { form: RecruitForm; onChange: Patch }) {
  const L = RECRUIT_FIELD_LABELS;
  const text = (key: 'name' | 'ethnicity' | 'school' | 'expectedSalary' | 'idNo' | 'phone', extra: Record<string, string | number> = {}) => (
    <label>{L[key]}<input value={form[key]} onChange={(e) => onChange({ [key]: e.target.value })} {...extra} /></label>
  );
  const select = (key: 'gender' | 'marital' | 'education' | 'sourceChannel', options: readonly string[]) => (
    <label>{L[key]}<select value={form[key]} onChange={(e) => onChange({ [key]: e.target.value })}><option value="">请选择</option>{options.map((o) => <option key={o}>{o}</option>)}</select></label>
  );
  return (
    <div className="recruit-fields">
      <div className="recruit-grid">
        {text('name', { maxLength: 50, autoComplete: 'name' })}
        {select('gender', RECRUIT_GENDERS)}
        {text('ethnicity', { maxLength: 20, placeholder: '如 汉族' })}
        <label>{L.birthDate}<input type="date" value={form.birthDate} onChange={(e) => onChange({ birthDate: e.target.value })} /></label>
        {select('marital', RECRUIT_MARITAL)}
        {text('phone', { maxLength: 11, inputMode: 'tel', autoComplete: 'tel', placeholder: '11 位手机号' })}
        {select('education', RECRUIT_EDUCATIONS)}
        {text('school', { maxLength: 100 })}
        <label>{L.graduationDate}<input type="month" value={form.graduationDate.slice(0, 7)} onChange={(e) => onChange({ graduationDate: e.target.value })} /></label>
        {text('expectedSalary', { maxLength: 40, placeholder: '如 6000-8000 元/月' })}
        {text('idNo', { maxLength: 18, inputMode: 'text', autoComplete: 'off', placeholder: '18 位身份证号码' })}
        {select('sourceChannel', RECRUIT_CHANNELS)}
      </div>
      <HistoryEditor title={L.educationHistory} orgLabel="学校" titleLabel="专业" rows={form.educationHistory} onChange={(rows) => onChange({ educationHistory: rows })} />
      <HistoryEditor title={L.workHistory} orgLabel="公司" titleLabel="职位" rows={form.workHistory} onChange={(rows) => onChange({ workHistory: rows })} />
      <label>{L.achievements}<textarea rows={4} maxLength={2000} value={form.achievements} onChange={(e) => onChange({ achievements: e.target.value })} /></label>
      <label>{L.selfEvaluation}<textarea rows={4} maxLength={2000} value={form.selfEvaluation} onChange={(e) => onChange({ selfEvaluation: e.target.value })} /></label>
    </div>
  );
}
