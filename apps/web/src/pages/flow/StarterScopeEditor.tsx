import { POSITION_TYPE_LABEL, STARTER_SCOPE_KEYS, STARTER_SCOPE_LABEL, starterScopeEmpty, type StarterScope, type StarterScopeKey } from '@kudesi/shared';
import type { Lookups } from './NodeEditor';

/**
 * 发起人范围：谁能在申请中心看到并发起这条流程。部门 / 岗位 / 角色（岗位类型）/ 职责组 / 具体员工，命中任一项即可；
 * 一项都不选 = 不限制（沿用“有申请中心权限即可发起”）。公司管理员始终可以发起。随流程版本保存，发布后生效。
 */
export function StarterScopeEditor({ scope, lookups, disabled, onChange }: { scope: StarterScope | null; lookups: Lookups; disabled: boolean; onChange: (s: StarterScope | null) => void }) {
  const cur: StarterScope = scope ?? {};
  const options = (k: StarterScopeKey): Array<{ value: string | number; label: string }> => {
    if (k === 'users') return lookups.users;
    if (k === 'departments') return lookups.depts;
    if (k === 'positions') return lookups.positions;
    if (k === 'dutyGroups') return lookups.groups;
    return Object.entries(POSITION_TYPE_LABEL).map(([value, label]) => ({ value, label }));
  };
  const list = (k: StarterScopeKey): Array<string | number> => (cur[k] as Array<string | number> | undefined) ?? [];
  const set = (k: StarterScopeKey, v: Array<string | number>) => {
    const next = { ...cur, [k]: v } as StarterScope;
    onChange(starterScopeEmpty(next) ? null : next);
  };
  const label = (k: StarterScopeKey, v: string | number) => options(k).find((o) => o.value === v)?.label.trim() ?? `#${v}`;
  return (
    <fieldset className="starter-scope" disabled={disabled}>
      <legend>发起人范围</legend>
      <p className="muted small">
        {starterScopeEmpty(scope) ? '现在不限制：有“申请中心”权限的人都能发起。' : '只有下面命中任一项的人能在申请中心看到并发起；其他人看不到入口，服务端也会拒绝。'}公司管理员始终可以发起。
      </p>
      <div className="form-grid">
        {STARTER_SCOPE_KEYS.map((k) => (
          <div key={k} className="starter-scope-row">
            <label>{STARTER_SCOPE_LABEL[k]}
              <select aria-label={`添加${STARTER_SCOPE_LABEL[k]}`} value="" onChange={(e) => {
                if (!e.target.value) return;
                const v: string | number = k === 'positionTypes' ? e.target.value : Number(e.target.value);
                if (!list(k).includes(v)) set(k, [...list(k), v]);
              }}>
                <option value="">（添加{STARTER_SCOPE_LABEL[k]}）</option>
                {options(k).filter((o) => !list(k).includes(o.value)).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <div className="chip-row">
              {list(k).map((v) => (
                <span key={v} className="chip active">{label(k, v)}{!disabled && <button type="button" className="link-button" aria-label={`移除${STARTER_SCOPE_LABEL[k]} ${label(k, v)}`} onClick={() => set(k, list(k).filter((x) => x !== v))}> ✕</button>}</span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </fieldset>
  );
}
