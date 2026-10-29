import { useEffect, useState } from 'react';
import { resourceApi } from '../../../resources/api';

/**
 * 经手人：从本公司员工档案里选（保存员工 id，显示姓名）。
 * 老单据里只有文字的经手人（没有员工 id）会作为第一个选项“xxx（原文字）”保留，不会丢；取不到员工名单时也至少能选当前这一个。
 */
export function HandlerSelect({ value, valueName, legacy, onChange, label = '经办人' }: { value: number | null; valueName: string; legacy: string; onChange: (id: number | null, name: string) => void; label?: string }) {
  const [staff, setStaff] = useState<Array<{ id: number; name: string; active: boolean }>>([]);
  useEffect(() => {
    let alive = true;
    // 取不到员工名单（无权限、网络错）不影响开单：下拉里至少有当前经手人
    Promise.resolve().then(() => resourceApi.users()).then((r) => alive && setStaff(Array.isArray(r) ? r : [])).catch(() => undefined);
    return () => { alive = false; };
  }, []);
  const list = staff.filter((s) => s.active || s.id === value);
  const known = value === null || list.some((s) => s.id === value);
  return (
    <label>{label}
      <select aria-label={label} value={value ?? ''} onChange={(e) => { const id = e.target.value ? Number(e.target.value) : null; onChange(id, id ? staff.find((x) => x.id === id)?.name ?? valueName : ''); }}>
        <option value="">{legacy ? `${legacy}（原文字）` : '请选择员工'}</option>
        {!known && <option value={value as number}>{valueName || `员工#${value}`}</option>}
        {list.map((s) => <option key={s.id} value={s.id}>{s.active ? s.name : `${s.name}（已停用）`}</option>)}
      </select>
    </label>
  );
}
