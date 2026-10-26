import { useEffect, useMemo, useState } from 'react';
import { getResourceDef } from '@kudesi/shared';
import { ApiError } from '../../../api/client';
import { RecordDetail } from '../../../resources/RecordDetail';
import { jstApi, type BaseCodeReport, type Change, type DeleteExecResult, type DeleteGroup } from './jstApi';

const msg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message || '操作失败');
const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));

/** 二次验证的前后对比 */
export function ChangeTable({ changes, baselineMissing }: { changes: Change[]; baselineMissing: boolean }) {
  if (baselineMissing) return <div className="notice warn">这条是旧数据，没有上次验证时的记录，没法列出具体改了什么，请对照资料重新核对。</div>;
  if (changes.length === 0) return <p className="muted">和上次验证时相比，没有发现资料变化。</p>;
  return (
    <div className="table-scroll"><table className="data-table">
      <thead><tr><th>来源</th><th>项目</th><th>上次验证</th><th>现在</th></tr></thead>
      <tbody>{changes.map((c, i) => <tr key={i}><td>{c.source}</td><td>{c.label}</td><td>{show(c.before)}</td><td><strong>{show(c.after)}</strong></td></tr>)}</tbody>
    </table></div>
  );
}

/**
 * 核对并验证：逐条看资料问题、二次验证的变化和要上传聚水潭的内容，可上一条/下一条；
 * 勾选“已核对”之后才能批量验证。只有管理员能同时加入聚水潭同步队列（只排队，不直接发送）。
 */
export function VerifyDialog({ ids, isAdmin, onClose, onDone }: { ids: number[]; isAdmin: boolean; onClose: () => void; onDone: () => void }) {
  const [reports, setReports] = useState<Record<number, BaseCodeReport>>({});
  const [index, setIndex] = useState(0);
  const [ack, setAck] = useState(false);
  const [sync, setSync] = useState(false);
  const [replaceOk, setReplaceOk] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const [editProduct, setEditProduct] = useState<number | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    setReports({});
    (async () => {
      for (const id of ids) {
        try {
          const r = await jstApi.baseReport(id);
          if (live) setReports((m) => ({ ...m, [id]: r }));
        } catch (e) { if (live) setError(msg(e)); }
      }
    })();
    return () => { live = false; };
  }, [ids, tick]);

  const list = ids.map((id) => reports[id]).filter(Boolean);
  const ready = list.filter((r) => r.issueCount === 0 && ['pending', 'reverify'].includes(r.status));
  const cur = reports[ids[index]];
  const anyReplace = sync && ready.some((r) => r.replacing);

  async function submit() {
    setBusy(true); setError('');
    try {
      const r = await jstApi.baseVerify(ready.map((x) => ({ id: x.id, signature: x.signature, uploadSignature: x.uploadSignature })), ack, sync, replaceOk);
      const failed = r.results.filter((x) => !x.ok);
      setResult(`已验证 ${r.verified} 条${sync ? `，其中 ${r.results.filter((x) => x.queued).length} 条已加入聚水潭同步队列` : ''}${failed.length ? `；${failed.length} 条没通过：${failed.slice(0, 3).map((x) => `${reports[x.id]?.code ?? x.id} ${x.error}`).join('；')}` : ''}`);
      if (r.verified > 0) onDone();
      if (failed.length) setTick((n) => n + 1);
    } catch (e) { setError(msg(e)); }
    setBusy(false);
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal card wide" role="dialog" aria-label="核对并验证基础编码">
        <div className="modal-head between"><strong>核对并验证（共 {ids.length} 条）</strong><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          {error && <div role="alert" className="notice error">{error}</div>}
          {result && <div role="status" className="notice ok">{result}</div>}
          <div className="row-actions">
            <button type="button" className="secondary-button small" disabled={index <= 0} onClick={() => setIndex(index - 1)}>上一条</button>
            <span>第 {index + 1} / {ids.length} 条</span>
            <button type="button" className="secondary-button small" disabled={index >= ids.length - 1} onClick={() => setIndex(index + 1)}>下一条</button>
            <span className="muted">可验证 {ready.length} 条，有问题或已验证的 {list.length - ready.length} 条会被跳过</span>
          </div>
          {!cur && <p className="muted">加载中…</p>}
          {cur && (
            <div>
              <h3>{cur.code} <span className="muted">{cur.name}</span></h3>
              {cur.aliasOf && <p className="muted">这是「{cur.aliasOf.code}」的马甲（别名），只能改资料和状态。</p>}
              {cur.issueCount > 0 && (
                <div className="notice error">
                  <strong>还有 {cur.issueCount} 个资料问题，处理完才能验证</strong>
                  <ul>
                    {cur.issues.map((g) => (
                      <li key={`${g.archiveKey}${g.parentPath.join('>')}`}>
                        <strong>{g.archiveName}</strong>{g.parentPath.length > 0 && <span className="muted">（来自 {g.parentPath.join(' › ')}）</span>}：{g.messages.join('；')}
                        {' '}<button type="button" className="link-button" onClick={() => setEditProduct(g.productId)}>去修改</button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {cur.secondVerification && (<><h4>二次验证：和上次相比改了什么</h4><ChangeTable changes={cur.changes} baselineMissing={cur.baselineMissing} /></>)}
              <h4>实际上传到聚水潭的资料</h4>
              <table className="data-table"><tbody>
                {Object.entries(cur.outbound.labels).filter(([k]) => k in cur.outbound.values).map(([k, label]) => <tr key={k}><th style={{ width: 120 }}>{label}</th><td>{show(cur.outbound.values[k])}</td></tr>)}
              </tbody></table>
              {cur.replacing && <div className="notice warn">聚水潭上已有旧编码「{cur.uploadedCode}」，和现在的编码不同。上传会变成“改码”：旧编码被停用、新编码被创建。</div>}
              <p className="muted">聚水潭状态：{({ not_synced: '未同步', pending: '排队中', synced: '已同步', failed: '同步失败' } as Record<string, string>)[cur.jstStatus] ?? cur.jstStatus}</p>
            </div>
          )}
          <hr />
          <label className="check"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> 我已核对以上 {ready.length} 条的资料和上传内容，确认无误</label>
          {isAdmin && <label className="check"><input type="checkbox" checked={sync} onChange={(e) => setSync(e.target.checked)} /> 验证后加入聚水潭同步队列（只排队；总开关打开并接入接口后才会真正发送）</label>}
          {anyReplace && <label className="check"><input type="checkbox" checked={replaceOk} onChange={(e) => setReplaceOk(e.target.checked)} /> 已处理旧编码的库存、在途订单、组合装及店铺映射关联，确认禁用旧编码并创建新编码</label>}
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={onClose}>关闭</button>
          <button type="button" className="primary-button" disabled={busy || !ack || ready.length === 0 || (anyReplace && !replaceOk)} onClick={() => void submit()}>验证 {ready.length} 条</button>
        </div>
      </div>
      {editProduct !== null && getResourceDef('finance-products') && (
        <RecordDetail def={getResourceDef('finance-products')!} id={editProduct} onClose={() => { setEditProduct(null); setTick((n) => n + 1); }} onChanged={() => setTick((n) => n + 1)} />
      )}
    </div>
  );
}

/** 删除：两种方式——没验证过、没同步过的直接删；来源商品档案已删除的，标记为“来源已删除”（上传过聚水潭的同时排停用任务）。 */
export function DeleteDialog({ mode, ids, onClose, onDone }: { mode: 'pending' | 'source'; ids?: number[]; onClose: () => void; onDone: () => void }) {
  const [groups, setGroups] = useState<DeleteGroup[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [disableOk, setDisableOk] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DeleteExecResult | null>(null);
  useEffect(() => {
    jstApi.baseDeletePreview(mode, ids).then((r) => { setGroups(r.groups); setPicked(r.groups.filter((g) => g.canDelete).map((g) => g.token)); }).catch((e) => setError(msg(e)));
  }, [mode, ids]);
  const chosen = useMemo(() => (groups ?? []).filter((g) => picked.includes(g.token)), [groups, picked]);
  const needDisable = mode === 'source' && chosen.some((g) => g.everSynced);
  async function run() {
    setBusy(true); setError('');
    try {
      setResult(await jstApi.baseDeleteExecute(mode, chosen.map((g) => ({ token: g.token, ids: g.ids })), reason.trim(), disableOk));
      onDone();
    } catch (e) { setError(msg(e)); }
    setBusy(false);
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal card" role="dialog" aria-label={mode === 'pending' ? '删除未验证的基础编码' : '处理来源已删除的基础编码'}>
        <div className="modal-head between"><strong>{mode === 'pending' ? '删除未验证、未同步的基础编码' : '来源档案已删除的基础编码'}</strong><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <p className="muted">{mode === 'pending' ? '只有从没验证过、没同步过聚水潭、没被组合用到的编码才能彻底删除；马甲会跟着真实编码一起删。' : '商品档案删除后，它的基础编码改为“来源已删除”；上传过聚水潭的，会同时排一个停用任务（在同步队列里可以看到进度、失败可重试）。'}</p>
          {error && <div role="alert" className="notice error">{error}</div>}
          {!groups && !error && <p className="muted">加载中…</p>}
          {groups && groups.length === 0 && <p className="muted">没有需要处理的基础编码。</p>}
          {groups && groups.length > 0 && (
            <table className="data-table">
              <thead><tr><th /><th>基础编码</th><th>名称</th><th>马甲</th><th>说明</th></tr></thead>
              <tbody>{groups.map((g) => (
                <tr key={g.token}>
                  <td><input type="checkbox" aria-label={`选择 ${g.code}`} disabled={!g.canDelete} checked={picked.includes(g.token)} onChange={(e) => setPicked(e.target.checked ? [...picked, g.token] : picked.filter((t) => t !== g.token))} /></td>
                  <td>{g.code}</td><td>{g.name}</td><td className="num">{g.aliasCount}</td><td className={g.canDelete ? undefined : 'bad-text'}>{g.canDelete ? (g.everSynced ? '上传过聚水潭' : '可以处理') : g.reason}</td>
                </tr>))}
              </tbody>
            </table>
          )}
          {groups && chosen.length > 0 && !result && (
            <>
              <label>原因（必填）<textarea rows={2} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} /></label>
              {needDisable && <label className="check"><input type="checkbox" checked={disableOk} onChange={(e) => setDisableOk(e.target.checked)} /> 已确认：同时在聚水潭停用这些编码（排入同步队列）</label>}
            </>
          )}
          {result && (
            <ul>{result.results.map((r, i) => <li key={i} className={r.ok ? undefined : 'bad-text'}>{r.code || '（资料已变）'}：{r.ok ? `已处理${r.disableQueued ? '，停用任务已排队' : ''}` : r.error}</li>)}</ul>
          )}
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={onClose}>关闭</button>
          {!result && <button type="button" className="primary-button danger-fill" disabled={busy || chosen.length === 0 || reason.trim().length < 2 || (needDisable && !disableOk)} onClick={() => void run()}>{mode === 'pending' ? `删除 ${chosen.length} 组` : `处理 ${chosen.length} 组`}</button>}
        </div>
      </div>
    </div>
  );
}
