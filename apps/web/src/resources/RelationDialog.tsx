import { useEffect, useMemo, useState } from 'react';
import { LEGACY_RELATION_KINDS, RESOURCE_DEFS, relationKindOptions } from '@kudesi/shared';
import { ApiError } from '../api/client';
import { resourceApi } from './api';

/** 关联的“关系类型”：独立列 relation_kind；旧数据曾写在用途开头“【授权】…”，读取时仍还原（只读兼容，新写入不再拼前缀） */
export const LINK_KINDS = LEGACY_RELATION_KINDS;

export function parsePurpose(purpose: string | null | undefined, relationKind?: string | null): { kind: string; text: string } {
  if (relationKind) return { kind: relationKind, text: purpose ?? '' };
  const m = /^【(使用|授权|保管|其他)】(.*)$/.exec(purpose ?? '');
  return m ? { kind: m[1], text: m[2] } : { kind: '其他', text: purpose ?? '' };
}
export interface EditableLink { linkId: number; targetType?: string; title: string; purpose?: string | null; relationKind?: string | null; validFrom?: string | null; validTo?: string | null }

/** 添加/修改手动关联：关系类型单选、对象、授权起止、用途；结束不能早于开始 */
export function RelationDialog({ type, id, link, canView, onClose, onSaved }: {
  type: string; id: number; link?: EditableLink; canView: (t: string) => boolean; onClose: () => void; onSaved: () => void;
}) {
  const first = parsePurpose(link?.purpose, link?.relationKind);
  const [kind, setKind] = useState(link ? first.kind : '');
  const [text, setText] = useState(first.text);
  const [validFrom, setValidFrom] = useState(link?.validFrom ?? '');
  const [validTo, setValidTo] = useState(link?.validTo ?? '');
  const [target, setTarget] = useState(link?.targetType ?? '');
  const [keyword, setKeyword] = useState('');
  const [options, setOptions] = useState<Array<{ value: number; label: string }>>([]);
  const [pick, setPick] = useState<number | ''>('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const types = RESOURCE_DEFS.filter((d) => !d.parent && canView(d.key));
  // 关系类型随“当前资料 + 目标资料”变化（旧系统按资料类型定义）；改已有关联时，旧数据里的类型也保留为一个选项
  const kindOptions = useMemo(() => {
    const base = target ? relationKindOptions(type, target) : [];
    const old = link ? (link.relationKind || (/^【/.test(link.purpose ?? '') ? first.kind : '')) : '';
    return old && !base.some((o) => o.value === old) ? [...base, { value: old, label: old }] : base;
  }, [type, target, link]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (kindOptions.length && !kindOptions.some((o) => o.value === kind)) setKind(kindOptions[0].value); }, [kindOptions]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);
  useEffect(() => {
    setPick('');
    if (link || !target) { setOptions([]); return; }
    let alive = true;
    const t = setTimeout(() => {
      if (target === 'user') {
        resourceApi.users().then((r) => alive && setOptions(r.filter((u) => u.active && (!keyword.trim() || u.name.includes(keyword.trim()))).slice(0, 50).map((u) => ({ value: u.id, label: u.name })))).catch(() => alive && setOptions([]));
        return;
      }
      resourceApi.list(target, { pageSize: 50, showHidden: true, keyword: keyword.trim() || undefined })
        .then((r) => alive && setOptions(r.items.map((i) => ({ value: i.id, label: i.title })))).catch(() => alive && setOptions([]));
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [target, keyword, link]);

  const dateProblem = validFrom && validTo && validTo < validFrom ? '结束日期不能早于开始日期' : '';
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!link && !pick) return setError('请选择要关联的资料');
    if (dateProblem) return setError(dateProblem);
    setBusy(true);
    const props = { purpose: text.trim(), validFrom, validTo, relationKind: kind || undefined };
    try {
      if (link) await resourceApi.updateLink(type, id, link.linkId, props);
      else await resourceApi.addLink(type, id, target, Number(pick), { purpose: props.purpose || undefined, validFrom: validFrom || undefined, validTo: validTo || undefined, relationKind: kind });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '保存失败');
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal card" role="dialog" aria-label={link ? '修改关联属性' : '添加关联'} onSubmit={submit}>
        <h3>{link ? `修改关联属性：${link.title}` : '添加关联'}</h3>
        {kindOptions.length > 0 && (
          <fieldset className="radio-row">
            <legend>关系类型</legend>
            {kindOptions.map((k) => (
              <label key={k.value} className="inline-field" title={k.hint}><input type="radio" name="link-kind" value={k.value} checked={kind === k.value} onChange={() => setKind(k.value)} /> {k.label}</label>
            ))}
            {kindOptions.find((o) => o.value === kind)?.hint && <small className="muted">{kindOptions.find((o) => o.value === kind)!.hint}</small>}
          </fieldset>
        )}
        {!link && (
          <>
            <label>关联对象类型
              <select aria-label="关联对象类型" value={target} onChange={(e) => { setTarget(e.target.value); setKeyword(''); setError(''); }}>
                <option value="">请选择</option>
                <option value="user">员工</option>
                {types.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
              </select>
            </label>
            {target && <input type="search" aria-label="搜索要关联的资料" placeholder="输入关键字搜索…" value={keyword} onChange={(e) => setKeyword(e.target.value)} />}
            {target && (
              <label>关联资料
                <select value={pick} onChange={(e) => { setPick(e.target.value ? Number(e.target.value) : ''); setError(''); }}>
                  <option value="">选择一条</option>
                  {options.filter((o) => !(target === type && o.value === id)).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
            )}
          </>
        )}
        <div className="form-grid">
          <label>授权开始<input type="date" aria-label="有效期开始" value={validFrom} onChange={(e) => { setValidFrom(e.target.value); setError(''); }} /></label>
          <label>授权结束<input type="date" aria-label="有效期结束" value={validTo} onChange={(e) => { setValidTo(e.target.value); setError(''); }} /></label>
        </div>
        {dateProblem && <div className="field-error">{dateProblem}</div>}
        <label>用途（选填）<input aria-label="用途" maxLength={180} value={text} onChange={(e) => setText(e.target.value)} placeholder="例如：备用号码、共用账号" /></label>
        {error && <div role="alert" className="notice error m">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>取消</button>
          <button type="submit" className="primary-button" disabled={busy}>{busy ? '保存中…' : '保存'}</button>
        </div>
      </form>
    </div>
  );
}
