import { ASSIGNEE_NO_TARGET, ASSIGNEE_OWN_SETTINGS, POSITION_TYPE_LABEL, RELATED_OWNER_KINDS, ASSIGNEE_SOURCE_LABEL, CONDITION_OP_LABEL, STEP_TYPE_LABEL, type AssigneeSource, type ConditionOp, type FieldDef, type FlowTemplate, type StepDef, type StepType } from '@kudesi/shared';
import { DUE_PRESETS, conditionSources, conditionValueToDisplay, conditionValueToStored, describeCondition } from './designerUi';
import { FormFieldsEditor } from './FormFieldsEditor';

export type Opt = { value: number; label: string };
export interface Lookups { users: Opt[]; positions: Opt[]; depts: Opt[]; groups: Opt[] }

const SOURCES: AssigneeSource[] = ['employee', 'position', 'position_type', 'duty_group', 'department', 'requester_manager', 'previous_handler', 'related_owner'];

/** 单个节点的属性面板：办理人、时限、条件、退回目标、督促时效、字段权限、办理页面。 */
export function NodeEditor({ step, index, steps, tpl, custom, canEdit, lookups, stepFields, onChange, onFields }: {
  step: StepDef; index: number; steps: StepDef[]; tpl: Pick<FlowTemplate, 'fields' | 'stepFields'>; custom: boolean; canEdit: boolean; lookups: Lookups;
  stepFields: FieldDef[]; onChange: (patch: Partial<StepDef>) => void; onFields: (f: FieldDef[]) => void;
}) {
  const locked = !!step.locked;
  const handler = step.type !== 'submit' && step.type !== 'end';
  const src = (step.assignee?.source ?? 'employee') as AssigneeSource;
  const opts = src === 'employee' ? lookups.users : src === 'position' ? lookups.positions : src === 'duty_group' ? lookups.groups : lookups.depts;
  const inGroup = !!step.parallel;
  const sources = conditionSources(tpl, steps, index);
  const cond = step.when ?? null;
  const condSrc = cond ? sources.find((x) => x.value === cond.field) : undefined;
  const remind = step.remind ?? { beforeMinutes: [], overdueEveryMinutes: null };
  const dis = !canEdit;
  const earlier = steps.slice(0, index).filter((s) => s.type !== 'end');

  if (!handler) {
    return (
      <div className="fd-node-editor">
        <h3>{step.name}</h3>
        <p className="muted">{step.type === 'submit' ? '这一步由发起人填写申请表单后提交；退回到这里时，发起人修改后可重新提交。' : '所有步骤办完后流程自动结束，不需要设置。'}</p>
        {step.type === 'submit' && custom && <p className="muted">申请表单在“申请表单”页签里设置。</p>}
      </div>
    );
  }

  return (
    <div className="fd-node-editor">
      <h3>节点设置 · {step.name}</h3>
      <div className="form-grid">
        <label>节点名称<input disabled={dis || locked} maxLength={40} value={step.name} onChange={(e) => onChange({ name: e.target.value })} /></label>
        <label>节点类型
          <select disabled={dis || locked || !custom} value={step.type} onChange={(e) => onChange({ type: e.target.value as StepType })}>
            {(['approval', 'execute', 'finance'] as const).map((t) => <option key={t} value={t}>{STEP_TYPE_LABEL[t]}</option>)}
          </select>
        </label>
      </div>

      <fieldset className="fd-section">
        <legend>办理人与时限</legend>
        <div className="form-grid">
          <label>办理人来源
            <select aria-label="办理人类型" disabled={dis} value={src} onChange={(e) => { const s = e.target.value as AssigneeSource; onChange({ assignee: { source: s, id: undefined }, mode: s === 'department' ? step.mode : undefined }); }}>
              {SOURCES.map((k) => <option key={k} value={k}>{ASSIGNEE_SOURCE_LABEL[k]}</option>)}
            </select>
          </label>
          {!ASSIGNEE_NO_TARGET.includes(src) && !ASSIGNEE_OWN_SETTINGS.includes(src) && (
            <label>具体对象
              <select aria-label="具体对象" disabled={dis} value={step.assignee?.id ?? ''} onChange={(e) => onChange({ assignee: { source: src, id: e.target.value ? Number(e.target.value) : undefined } })}>
                <option value="">（请选择）</option>
                {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          )}
          {src === 'position_type' && (
            <label>岗位类型
              <select aria-label="岗位类型" disabled={dis} value={step.assignee?.key ?? ''} onChange={(e) => onChange({ assignee: { source: src, key: e.target.value || undefined } })}>
                <option value="">（请选择）</option>
                {Object.entries(POSITION_TYPE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
          )}
          {src === 'related_owner' && (
            <>
              <label>负责人种类
                <select aria-label="负责人种类" disabled={dis} value={step.assignee?.key ?? ''} onChange={(e) => onChange({ assignee: { source: src, key: e.target.value || undefined } })}>
                  <option value="">（请选择）</option>
                  {Object.entries(RELATED_OWNER_KINDS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
              </label>
              <label>申请表单里的资料字段
                <select aria-label="关联资料字段" disabled={dis} value={step.assignee?.field ?? ''} onChange={(e) => onChange({ assignee: { source: src, key: step.assignee?.key, field: e.target.value || undefined } })}>
                  <option value="">（请选择）</option>
                  {tpl.fields.filter((f) => f.type === 'ref' && f.ref === (step.assignee?.key ? RELATED_OWNER_KINDS[step.assignee.key]?.type : '')).map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                </select>
              </label>
            </>
          )}
          {src === 'department' && (
            <label>办理方式
              <select disabled={dis || locked} value={step.mode ?? 'any'} onChange={(e) => onChange({ mode: e.target.value === 'all' ? 'all' : 'any' })}>
                <option value="any">任一人办理即可</option>
                <option value="all">全员会签（每个人都要办）</option>
              </select>
            </label>
          )}
          <label>处理时限（分钟，空=不限）
            <input aria-label="时限（分钟）" disabled={dis} type="number" min={1} max={100800} value={step.dueMinutes ?? ''} onChange={(e) => onChange({ dueMinutes: e.target.value ? Number(e.target.value) : null })} />
            <span className="fd-presets">{DUE_PRESETS.map((p) => <button key={p.minutes} type="button" disabled={dis} className={`chip ${step.dueMinutes === p.minutes ? 'active' : ''}`} onClick={() => onChange({ dueMinutes: p.minutes })}>{p.label}</button>)}</span>
          </label>
        </div>
        {src === 'requester_manager' && <p className="muted small">按发起人资料里的“上级”找人，没有就找所在部门的主管；都没有时发起会失败并提示。</p>}
        {src === 'previous_handler' && <p className="muted small">交给上一步实际办理的那个人（例如让同一个人再复核一遍）。</p>}
        <label>抄送（进入这一步时通知，可多选）
          <select multiple disabled={dis} value={(step.ccUserIds ?? []).map(String)} onChange={(e) => onChange({ ccUserIds: [...e.target.selectedOptions].map((o) => Number(o.value)) })}>
            {lookups.users.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      </fieldset>

      {!locked && (
        <fieldset className="fd-section">
          <legend>条件分支（满足条件才办理这一步，否则自动跳过）</legend>
          <label className="check-line"><input type="checkbox" disabled={dis} checked={!!cond} onChange={(e) => onChange({ when: e.target.checked ? { field: sources[0]?.value ?? '', op: 'gte', value: '' } : null })} />只有满足条件时才走这一步</label>
          {cond && (
            sources.length === 0 ? <p className="muted">还没有可用来比较的字段，请先在“申请表单”里添加字段。</p> : (
              <div className="form-grid">
                <label>取值来源
                  <select aria-label="条件字段" disabled={dis} value={cond.field} onChange={(e) => onChange({ when: { field: e.target.value, op: 'eq', value: '' } })}>
                    {sources.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
                  </select>
                </label>
                <label>运算
                  <select aria-label="条件运算" disabled={dis} value={cond.op} onChange={(e) => onChange({ when: { field: cond.field, op: e.target.value as ConditionOp, value: e.target.value === 'in' ? [] : cond.value } })}>
                    {(Object.keys(CONDITION_OP_LABEL) as ConditionOp[]).map((o) => <option key={o} value={o}>{CONDITION_OP_LABEL[o]}</option>)}
                  </select>
                </label>
                {cond.op !== 'empty' && cond.op !== 'notempty' && (
                  condSrc?.field.type === 'select' ? (
                    cond.op === 'in' ? (
                      <label>候选值（可多选）
                        <select aria-label="条件比较值" multiple disabled={dis} value={Array.isArray(cond.value) ? cond.value.map(String) : []} onChange={(e) => onChange({ when: { ...cond, value: [...e.target.selectedOptions].map((o) => o.value) } })}>
                          {condSrc.field.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </label>
                    ) : (
                      <label>比较值
                        <select aria-label="条件比较值" disabled={dis} value={String(cond.value ?? '')} onChange={(e) => onChange({ when: { ...cond, value: e.target.value } })}>
                          <option value="">（请选择）</option>
                          {condSrc.field.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </label>
                    )
                  ) : (
                    <label>{cond.op === 'in' ? '候选值（用顿号隔开）' : '比较值'}{condSrc?.field.type === 'money' ? '（元）' : ''}
                      <input aria-label="条件比较值" disabled={dis} value={Array.isArray(cond.value) ? cond.value.join('、') : conditionValueToDisplay(condSrc?.field, cond.value)} onChange={(e) => onChange({ when: { ...cond, value: cond.op === 'in' ? e.target.value.split(/[、,，]/).map((x) => x.trim()).filter(Boolean) : e.target.value === '' ? '' : conditionValueToStored(condSrc?.field, e.target.value) } })} />
                    </label>
                  )
                )}
                <p className="muted small wide">效果：{describeCondition(cond, tpl, steps) || '请补全条件'} 时才办理“{step.name}”。想表达“金额小于 X 走主管、大于等于 X 走老板”，建两个相反条件的节点即可。</p>
              </div>
            )
          )}
        </fieldset>
      )}

      {!locked && (
        <fieldset className="fd-section">
          <legend>并行与异常</legend>
          <label>并行分支编号（相邻、编号相同的步骤同时办理，全部办完才往下走；空=不并行）
            <input aria-label="并行分支" disabled={dis} maxLength={30} placeholder="例如 g1" value={step.parallel ?? ''} onChange={(e) => onChange({ parallel: e.target.value.trim() || null })} />
          </label>
          {!inGroup && (
            <>
              <label className="check-line"><input type="checkbox" disabled={dis} checked={!!step.onlyOnException} onChange={(e) => onChange({ onlyOnException: e.target.checked || undefined })} />仅异常步骤（正常流转自动略过，只有别的步骤“上报异常”时才办理）</label>
              {!step.onlyOnException && (
                <label>办理人可“上报异常”转到
                  <select aria-label="异常处理步骤" disabled={dis} value={step.exceptionToKey ?? ''} onChange={(e) => onChange({ exceptionToKey: e.target.value || null })}>
                    <option value="">不能上报异常</option>
                    {steps.filter((s) => s.onlyOnException).map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
                  </select>
                </label>
              )}
            </>
          )}
        </fieldset>
      )}

      {!locked && (
        <fieldset className="fd-section">
          <legend>退回</legend>
          <label>被退回时回到
            <select aria-label="退回目标" disabled={dis} value={step.returnToKey ?? ''} onChange={(e) => onChange({ returnToKey: e.target.value || null })}>
              <option value="">上一个实际办理的步骤（默认）</option>
              {earlier.map((s) => <option key={s.key} value={s.key}>{s.name}{s.type === 'submit' ? '（发起人修改后重新提交）' : ''}</option>)}
            </select>
          </label>
        </fieldset>
      )}

      <fieldset className="fd-section">
        <legend>督促时效</legend>
        <label className="check-line"><input type="checkbox" disabled={dis} checked={!!step.remind} onChange={(e) => onChange({ remind: e.target.checked ? { beforeMinutes: step.dueMinutes ? [Math.max(1, Math.min(20, step.dueMinutes - 1)), Math.max(1, Math.min(10, step.dueMinutes - 1))].filter((v, i, a) => a.indexOf(v) === i) : [], overdueEveryMinutes: 30 } : null })} />开启督促提醒</label>
        {step.remind && (
          <div className="form-grid">
            <label>首次提前提醒（分钟）<input aria-label="首次提前" disabled={dis || !step.dueMinutes} type="number" min={1} value={remind.beforeMinutes[0] ?? ''} onChange={(e) => onChange({ remind: { ...remind, beforeMinutes: [e.target.value ? Number(e.target.value) : undefined, remind.beforeMinutes[1]].filter((x): x is number => !!x) } })} /></label>
            <label>再次提前提醒（分钟）<input aria-label="再次提前" disabled={dis || !step.dueMinutes} type="number" min={1} value={remind.beforeMinutes[1] ?? ''} onChange={(e) => onChange({ remind: { ...remind, beforeMinutes: [remind.beforeMinutes[0], e.target.value ? Number(e.target.value) : undefined].filter((x): x is number => !!x) } })} /></label>
            <label>超时后每隔多少分钟再提醒<input aria-label="超时提醒间隔" disabled={dis} type="number" min={1} max={1440} value={remind.overdueEveryMinutes ?? ''} onChange={(e) => onChange({ remind: { ...remind, overdueEveryMinutes: e.target.value ? Number(e.target.value) : null } })} /></label>
            {!step.dueMinutes && <p className="muted small wide">提前提醒要先设置处理时限；只设置超时提醒也可以。</p>}
          </div>
        )}
        <p className="muted small">提醒发给办理人本人；超时通知主管/老板和处罚在“超时与处罚”页签里按流程或节点设置。</p>
      </fieldset>

      {tpl.fields.length > 0 && (
        <fieldset className="fd-section">
          <legend>字段权限（这一步的办理人看不到的申请内容）</legend>
          <div className="chip-row">
            {tpl.fields.map((f) => {
              const hidden = (step.hiddenFields ?? []).includes(f.key);
              return <label key={f.key} className="check-line"><input type="checkbox" disabled={dis || locked} checked={hidden} onChange={(e) => onChange({ hiddenFields: e.target.checked ? [...(step.hiddenFields ?? []), f.key] : (step.hiddenFields ?? []).filter((k) => k !== f.key) })} />隐藏“{f.label}”</label>;
            })}
          </div>
          <p className="muted small">例如仓库节点隐藏“金额”。服务端过滤：这一步的办理人打开流程时拿不到被隐藏的字段；发起人和有流程总览权限的人不受限。</p>
        </fieldset>
      )}

      <fieldset className="fd-section">
        <legend>办理页面（办理人在这一步要填写的内容）</legend>
        {custom
          ? <FormFieldsEditor fields={stepFields} group={step.name} disabled={dis} onChange={onFields} />
          : stepFields.length === 0 ? <p className="muted">这一步没有要填写的内容，直接通过、退回或拒绝。</p>
            : <ul className="plain-list">{stepFields.map((f) => <li key={f.key}>{f.label}{f.required ? '（必填）' : ''}</li>)}</ul>}
        {!custom && <p className="muted small">内置业务流程的办理页面由业务规则固定，不能修改。</p>}
      </fieldset>
    </div>
  );
}
