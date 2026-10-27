import { useCallback, useEffect, useMemo, useState } from 'react';
import { ASSET_ACTIONS, ASSET_ACTIONS_BY_STATE, ASSET_LOG_LABELS, type AssetAction, type AssetState } from '@kudesi/shared';
import { ApiError } from '../api/client';
import { assetApi, resourceApi, type AssetDetails, type LocationContentGroup, type ResourceDto } from './api';
import { downloadText, toCsv } from './csv';
import { loadRefOptions } from './RecordForm';

const STATES: readonly string[] = ['idle', 'in_use', 'repairing', 'retired', 'lost'];
/** 历史数据里不认识的状态，按闲置处理（旧系统同样处理） */
export const assetState = (status: string): AssetState => (STATES.includes(status) ? (status as AssetState) : 'idle');

type Option = { value: number; label: string; disabled?: boolean };
function useOptions(target: string) {
  const [options, setOptions] = useState<Option[] | null>(null);
  useEffect(() => {
    let alive = true;
    loadRefOptions(target).then((o) => alive && setOptions(o)).catch(() => alive && setOptions([]));
    return () => { alive = false; };
  }, [target]);
  return options;
}

function ActionDialog({ action, record, onClose, onDone }: { action: AssetAction; record: ResourceDto; onClose: () => void; onDone: () => void }) {
  const rule = ASSET_ACTIONS[action];
  const users = useOptions('user');
  const locations = useOptions('locations');
  const [userId, setUserId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const currentUser = typeof record.data.userId === 'number' ? record.data.userId : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (rule.needsUser && !userId) return setError('请选择使用人');
    if (action === 'transfer' && Number(userId) === currentUser) return setError('请选择另一位使用人');
    if (rule.needsReason && !reason.trim()) return setError(`请填写${rule.reasonLabel}`);
    if (rule.confirm && !confirmed) return setError('请勾选确认');
    setBusy(true);
    setError('');
    try {
      await assetApi.transition(record.id, {
        action,
        userId: rule.needsUser ? Number(userId) : undefined,
        locationId: locationId ? Number(locationId) : undefined,
        reason: reason.trim() || undefined,
        note: note.trim() || undefined,
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '办理失败');
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal card small" role="dialog" aria-label={`${rule.label}：${record.title}`} onSubmit={submit}>
        <div className="modal-head"><strong>{rule.label}：{record.title}</strong></div>
        <div className="modal-body">
          <p className="muted">{rule.hint}</p>
          {rule.needsUser && (
            <label>{action === 'transfer' ? '新使用人' : '使用人'}<b className="req"> *</b>
              <select value={userId} onChange={(e) => setUserId(e.target.value)} disabled={!users}>
                <option value="">{users ? '请选择' : '加载中…'}</option>
                {(users ?? []).filter((u) => !u.disabled).map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
              </select>
            </label>
          )}
          {rule.withLocation && (
            <label>{action === 'return' || action === 'found' ? '放回位置' : '使用位置'}
              <select value={locationId} onChange={(e) => setLocationId(e.target.value)} disabled={!locations}>
                <option value="">位置不变（当前：{record.refLabels.locationId ?? '未设置'}）</option>
                {(locations ?? []).map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            </label>
          )}
          {rule.needsReason ? (
            <label>{rule.reasonLabel}<b className="req"> *</b><textarea rows={3} autoFocus value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} /></label>
          ) : (
            <label>说明<textarea rows={2} value={note} maxLength={500} placeholder="选填" onChange={(e) => setNote(e.target.value)} /></label>
          )}
          {rule.confirm && (
            <label className="check"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> 我确认「{record.title}」已经报废，不再使用</label>
          )}
          {error && <div role="alert" className="notice error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="submit" className={rule.danger ? 'primary-button danger-fill' : 'primary-button'} disabled={busy}>{busy ? '提交中…' : `确认${rule.label}`}</button>
        </div>
      </form>
    </div>
  );
}

/** 固定资产详情底部的流转按钮：按当前状态只给能办的动作（取代通用的“更改状态”下拉）。 */
export function AssetActionBar({ record, onDone }: { record: ResourceDto; onDone: () => void }) {
  const [action, setAction] = useState<AssetAction | null>(null);
  const actions = ASSET_ACTIONS_BY_STATE[assetState(record.status)];
  if (actions.length === 0) return <span className="muted">已报废，不能再办理</span>;
  return (
    <>
      {actions.map((a) => (
        <button key={a} type="button" className={ASSET_ACTIONS[a].danger ? 'secondary-button danger' : 'secondary-button'} onClick={() => setAction(a)}>{ASSET_ACTIONS[a].label}</button>
      ))}
      {action && <ActionDialog action={action} record={record} onClose={() => setAction(null)} onDone={() => { setAction(null); onDone(); }} />}
    </>
  );
}

/** 流转记录：谁在什么时候领用、归还、送修、盘点过这项资产。 */
export function AssetFlowPanel({ record, version }: { record: ResourceDto; version: string }) {
  const [details, setDetails] = useState<AssetDetails | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setDetails(null);
    assetApi.details(record.id).then(setDetails).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败'));
  }, [record.id, version]);
  return (
    <section>
      <h2 className="section-title">流转记录</h2>
      {error && <div role="alert" className="notice error">{error}</div>}
      {!details && !error && <p className="muted">加载中…</p>}
      {details?.operationLogs.length === 0 && <p className="muted">暂无记录</p>}
      {details?.operationLogs.map((l) => (
        <div key={l.id} className="log-item">
          <div className="between"><strong>{ASSET_LOG_LABELS[l.action] ?? ({ create: '新增资产', update: '编辑资料', delete: '删除' } as Record<string, string>)[l.action] ?? l.action}</strong><small className="muted">{new Date(l.createdAt).toLocaleString('zh-CN')}</small></div>
          <small className="muted">{l.actor}{l.note ? ` · ${l.note}` : ''}</small>
        </div>
      ))}
    </section>
  );
}

/** 储物空间：以这项资产为空间的位置（档案柜、保险柜的层和抽屉），以及里面存放的档案。 */
export function AssetStoragePanel({ record }: { record: ResourceDto }) {
  const [details, setDetails] = useState<AssetDetails | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    assetApi.details(record.id).then(setDetails).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败'));
  }, [record.id]);
  if (error) return <div role="alert" className="notice error">{error}</div>;
  if (!details) return <p className="muted">加载中…</p>;
  if (!details.storageSpaces.length) return <p className="muted">这项资产没有储物空间。档案柜、保险柜等可以在「房间与档案位置」里建立柜层、抽屉，用来定位档案。</p>;
  const nameOf = new Map(details.storageSpaces.map((s) => [s.id, s.title]));
  return (
    <section>
      <h2 className="section-title">储物空间（{details.storageSpaces.length}）</h2>
      {details.storageSpaces.map((s) => (
        <div key={s.id} className="line-item between">
          <span>{s.title}</span>
          <small className="muted">{s.status === 'inactive' ? '已停用' : `${details.archiveItems.filter((a) => a.locationId === s.id).length} 份档案`}</small>
        </div>
      ))}
      <h2 className="section-title">存放的档案（{details.archiveItems.length}）</h2>
      {details.archiveItems.length === 0 && <p className="muted">储物空间里还没有档案。</p>}
      {details.archiveItems.map((a) => (
        <div key={a.id} className="line-item between">
          <span>{[a.archiveNo, a.title].filter(Boolean).join(' · ')}</span>
          <small className="muted">{nameOf.get(a.locationId) ?? ''}</small>
        </div>
      ))}
    </section>
  );
}

/** 位置的“存放内容”：这个房间/柜子里有什么。 */
export function LocationContentsPanel({ id }: { id: number }) {
  const [groups, setGroups] = useState<LocationContentGroup[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setGroups(null);
    assetApi.locationContents(id).then(setGroups).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败'));
  }, [id]);
  if (error) return <div role="alert" className="notice error">{error}</div>;
  if (!groups) return <p className="muted">加载中…</p>;
  if (groups.length === 0) return <p className="muted">这个位置是空的。</p>;
  return (
    <>
      {groups.map((g) => (
        <section key={g.type}>
          <h2 className="section-title">{g.type === 'locations' ? '子位置' : g.typeLabel}（{g.items.length}）</h2>
          {g.items.map((it) => (
            <div key={it.id} className="line-item between">
              <span>{it.title}{it.slots.length > 0 && !(it.slots.length === 1 && ['存放位置', '位置', '上级位置'].includes(it.slots[0])) && <small className="muted"> · {it.slots.join('、')}</small>}</span>
              <small className="muted">{it.statusLabel}</small>
            </div>
          ))}
        </section>
      ))}
    </>
  );
}

const RESULTS: Array<{ value: 'present' | 'moved' | 'missing'; label: string }> = [
  { value: 'present', label: '在位' },
  { value: 'moved', label: '位置变动' },
  { value: 'missing', label: '未找到' },
];

/** 盘点：逐项选结果（在位/位置变动/未找到），提交后写入每项资产的流转记录。 */
export function InventoryDialog({ onClose, onDone }: { onClose: () => void; onDone: (message: string) => void }) {
  const locations = useOptions('locations');
  const [rows, setRows] = useState<ResourceDto[] | null>(null);
  const [results, setResults] = useState<Record<number, string>>({});
  const [locs, setLocs] = useState<Record<number, string>>({});
  const [query, setQuery] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const all: ResourceDto[] = [];
      for (let page = 1; page <= 20; page++) {
        const r = await resourceApi.list('fixed-assets', { page, pageSize: 200, showHidden: false });
        all.push(...r.items);
        if (all.length >= r.total) break;
      }
      if (alive) setRows(all.filter((x) => x.status !== 'retired'));
    })().catch((e) => alive && setError(e instanceof ApiError ? e.message : '加载失败'));
    return () => { alive = false; };
  }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (rows ?? []).filter((r) => !q || `${r.title} ${String(r.data.assetNo ?? '')} ${r.refLabels.userId ?? ''} ${r.refLabels.locationId ?? ''}`.toLowerCase().includes(q));
  }, [rows, query]);
  const checked = Object.keys(results).length;
  const count = (v: string) => Object.values(results).filter((x) => x === v).length;

  const exportSheet = useCallback(() => {
    const head = ['资产编号', '资产名称', '使用人', '账面位置', '状态', '盘点结果（在位/位置变动/未找到）', '实际位置', '备注'];
    const body = (rows ?? []).map((r) => [String(r.data.assetNo ?? ''), r.title, r.refLabels.userId ?? '', r.refLabels.locationId ?? '', r.status, '', '', '']);
    downloadText(`固定资产盘点表-${new Date().toISOString().slice(0, 10)}.csv`, toCsv([head, ...body]));
  }, [rows]);

  async function submit() {
    const noLoc = Object.entries(results).filter(([id, v]) => v === 'moved' && !locs[Number(id)]);
    if (noLoc.length) return setError(`有 ${noLoc.length} 项选了「位置变动」但没有选实际位置`);
    if (!checked) return setError('还没有盘点任何资产');
    if (count('missing') && !window.confirm(`${count('missing')} 项资产会标记为「丢失」，之后可以在详情里「找回」。确认提交？`)) return;
    setBusy(true);
    setError('');
    try {
      const items = Object.entries(results).map(([id, result]) => ({ id: Number(id), result, locationId: locs[Number(id)] ? Number(locs[Number(id)]) : null }));
      const s = await assetApi.inventory(items, note.trim());
      onDone(`盘点已记录：在位 ${s.present} 项，位置更正 ${s.moved} 项，未找到 ${s.missing} 项${s.skipped.length ? `，跳过 ${s.skipped.length} 项` : ''}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '提交失败');
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal card" role="dialog" aria-label="盘点固定资产" style={{ maxWidth: 960 }}>
        <div className="modal-head between"><strong>盘点固定资产</strong><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <p className="muted">范围：未报废的 {rows?.length ?? '…'} 项资产。逐项选择结果，提交后写入每项资产的流转记录。</p>
          <div className="toolbar">
            <input className="grow" type="search" placeholder="搜索编号、名称、使用人、位置" aria-label="搜索盘点资产" value={query} onChange={(e) => setQuery(e.target.value)} />
            <button type="button" className="secondary-button" onClick={() => setResults((cur) => ({ ...cur, ...Object.fromEntries(shown.filter((r) => !cur[r.id]).map((r) => [r.id, 'present'])) }))}>未盘点的全部标为在位</button>
            <button type="button" className="secondary-button" onClick={exportSheet} disabled={!rows}>导出纸质盘点表</button>
          </div>
          {!rows && !error && <p className="muted">加载中…</p>}
          {rows && (
            <div className="table-scroll" style={{ maxHeight: 360 }}>
              <table className="data-table">
                <thead><tr><th>资产</th><th>使用人</th><th>账面位置</th><th>盘点结果</th></tr></thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.id}>
                      <td>{r.title}<br /><small className="muted">{String(r.data.assetNo ?? '')}</small></td>
                      <td>{r.refLabels.userId ?? '—'}</td>
                      <td>{r.refLabels.locationId ?? '未设置'}</td>
                      <td>
                        <span role="radiogroup" aria-label={`${r.title}的盘点结果`} className="pill-row">
                          {RESULTS.map((o) => (
                            <button key={o.value} type="button" role="radio" aria-checked={results[r.id] === o.value} className={results[r.id] === o.value ? 'chip active' : 'chip'}
                              onClick={() => setResults((cur) => { const n = { ...cur }; if (n[r.id] === o.value) delete n[r.id]; else n[r.id] = o.value; return n; })}>{o.label}</button>
                          ))}
                        </span>
                        {results[r.id] === 'moved' && (
                          <select aria-label="实际位置" value={locs[r.id] ?? ''} onChange={(e) => setLocs((cur) => ({ ...cur, [r.id]: e.target.value }))}>
                            <option value="">选择实际位置</option>
                            {(locations ?? []).map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                          </select>
                        )}
                      </td>
                    </tr>
                  ))}
                  {shown.length === 0 && <tr><td colSpan={4} className="muted center">没有可盘点的资产</td></tr>}
                </tbody>
              </table>
            </div>
          )}
          <label>盘点说明<input value={note} maxLength={200} placeholder="例如：2026 年 10 月行政盘点" onChange={(e) => setNote(e.target.value)} /></label>
          {error && <div role="alert" className="notice error">{error}</div>}
        </div>
        <div className="modal-foot">
          <span className="muted">已盘点 {checked} / {rows?.length ?? 0}　在位 {count('present')}　位置变动 {count('moved')}　未找到 {count('missing')}</span>
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="button" className="primary-button" disabled={busy || !checked} onClick={submit}>{busy ? '提交中…' : `提交 ${checked} 项盘点结果`}</button>
        </div>
      </div>
    </div>
  );
}
