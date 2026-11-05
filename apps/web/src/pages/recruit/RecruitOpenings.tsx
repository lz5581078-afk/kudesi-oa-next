import { useCallback, useEffect, useState } from 'react';
import { SPECIAL_PERMISSIONS } from '@kudesi/shared';
import { useAuth } from '../../auth/AuthContext';
import { recruitApi, type PositionCandidate, type RecruitOpening } from './recruitApi';

const errText = (e: unknown) => (e instanceof Error ? e.message : '操作失败，请重试');

/** 招聘岗位：从部门岗位导入或手工添加；求职者扫码登记时在这里的“在招”岗位里选 */
export function RecruitOpenings() {
  const { can } = useAuth();
  const canManage = can(SPECIAL_PERMISSIONS.recruitManage);
  const [rows, setRows] = useState<RecruitOpening[]>([]), [error, setError] = useState(''), [msg, setMsg] = useState('');
  const [picker, setPicker] = useState<PositionCandidate[] | null>(null), [picked, setPicked] = useState<number[]>([]);
  const [title, setTitle] = useState('');
  const load = useCallback(() => recruitApi.openings().then(setRows).catch((e) => setError(errText(e))), []);
  useEffect(() => { void load(); }, [load]);
  const run = async (fn: () => Promise<unknown>, done = '') => { setError(''); setMsg(''); try { await fn(); if (done) setMsg(done); await load(); } catch (e) { setError(errText(e)); } };
  const openPicker = () => run(async () => { setPicker(await recruitApi.positionCandidates()); setPicked([]); });
  const doImport = () => run(async () => {
    const r = await recruitApi.importOpenings(picked);
    setPicker(null); setMsg(`已导入 ${r.added} 个岗位${r.reopened ? `，重新开放 ${r.reopened} 个` : ''}${r.skipped ? `，${r.skipped} 个已在招聘岗位里` : ''}`);
  });
  const edit = (r: RecruitOpening, patch: Parameters<typeof recruitApi.updateOpening>[1]) => run(() => recruitApi.updateOpening(r.id, patch));
  return (
    <section className="card">
      {error && <div className="notice error" role="alert">{error}</div>}
      {msg && <div className="notice">{msg}</div>}
      <p className="muted">求职者扫码填写时，要在这里“在招”的岗位里选择应聘岗位；没有任何在招岗位时不要求选择。</p>
      {canManage && (
        <div className="toolbar">
          <button className="primary" onClick={() => void openPicker()}>从部门岗位导入</button>
          <input aria-label="岗位名称" placeholder="或手工添加岗位名称" maxLength={100} value={title} onChange={(e) => setTitle(e.target.value)} />
          <button disabled={!title.trim()} onClick={() => void run(async () => { await recruitApi.createOpening({ title: title.trim() }); setTitle(''); })}>添加</button>
        </div>
      )}
      {picker && (
        <div className="card recruit-picker" role="group" aria-label="选择要导入的部门岗位">
          <strong>勾选要招聘的岗位（已导入的不可再选）</strong>
          <ul>{picker.map((p) => (
            <li key={p.id}><label><input type="checkbox" disabled={p.imported} checked={p.imported || picked.includes(p.id)}
              onChange={(e) => setPicked((v) => (e.target.checked ? [...v, p.id] : v.filter((x) => x !== p.id)))} /> {p.departmentName ? `${p.departmentName} / ` : ''}{p.name}{p.imported ? '（已导入）' : ''}</label></li>
          ))}</ul>
          {picker.length === 0 && <p className="muted">还没有可导入的部门岗位，请先在“资料 → 组织架构”里建岗位。</p>}
          <div className="toolbar"><button className="primary" disabled={!picked.length} onClick={() => void doImport()}>导入所选（{picked.length}）</button><button onClick={() => setPicker(null)}>取消</button></div>
        </div>
      )}
      <table className="data-table cards-narrow">
        <thead><tr><th>岗位</th><th>所属部门</th><th>招聘人数</th><th>岗位要求</th><th>已收登记</th><th>状态</th><th /></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td data-label="岗位">{r.title}{r.positionId === null && <span className="muted">（手工添加）</span>}</td>
              <td data-label="所属部门">{r.departmentName || '—'}</td>
              <td data-label="招聘人数">{canManage
                ? <input aria-label={`${r.title} 招聘人数`} type="number" min={1} defaultValue={r.headcount ?? ''} onBlur={(e) => { const n = Number(e.target.value); if (n >= 1 && n !== r.headcount) void edit(r, { headcount: n }); }} />
                : r.headcount ?? '不限'}</td>
              <td data-label="岗位要求">{canManage
                ? <input aria-label={`${r.title} 岗位要求`} defaultValue={r.requirements} maxLength={1000} placeholder="可不填，求职者选岗位时会看到" onBlur={(e) => { if (e.target.value !== r.requirements) void edit(r, { requirements: e.target.value }); }} />
                : r.requirements || '—'}</td>
              <td data-label="已收登记">{r.applicationCount}</td>
              <td data-label="状态">{r.status === 'open' ? '在招' : '已停招'}</td>
              <td>{canManage && <button onClick={() => void edit(r, { status: r.status === 'open' ? 'closed' : 'open' })}>{r.status === 'open' ? '停止招聘' : '重新开放'}</button>}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={7} className="muted">还没有招聘岗位。点“从部门岗位导入”选择要招的岗位。</td></tr>}
        </tbody>
      </table>
    </section>
  );
}
