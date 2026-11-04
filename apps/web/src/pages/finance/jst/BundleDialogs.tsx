import {BundleCompositionEditor} from './BundleCompositionEditor';
import { useEffect, useState } from 'react';
import { unitYuanText } from '@kudesi/shared';
import { ApiError } from '../../../api/client';
import { resourceApi, type ResourceDto } from '../../../resources/api';
import { ChangeTable } from './BaseCodeDialogs';
import { ROLE_LABEL } from './BundleLineEditor';
import { jstApi, type BundleReport, type LineInput } from './jstApi';

const msg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message || '操作失败');
export {BundleCreateDialog as GenerateDialog} from './BundleCreateDialog';
export {BundleNamingCenter as NamingCenterDialog} from './BundleNamingCenter';

/** 组合的核对并验证，和基础编码一样：先看报告，勾选“已核对”才能验证；构成修订会随验证发布。 */
export function BundleVerifyDialog({ ids, isAdmin, onClose, onDone }: { ids: number[]; isAdmin: boolean; onClose: () => void; onDone: () => void }) {
  const [reports, setReports] = useState<Record<number, BundleReport>>({});
  const [index, setIndex] = useState(0);
  const [ack, setAck] = useState(false);
  const [sync, setSync] = useState(false);
  const [replaceOk, setReplaceOk] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    (async () => { for (const id of ids) { try { const r = await jstApi.bundleReport(id); if (live) setReports((m) => ({ ...m, [id]: r })); } catch (e) { if (live) setError(msg(e)); } } })();
    return () => { live = false; };
  }, [ids, tick]);
  const list = ids.map((id) => reports[id]).filter(Boolean);
  const ready = list.filter((r) => r.issues.length === 0 && ['pending', 'reverify'].includes(r.status));
  const cur = reports[ids[index]];
  const anyReplace = sync && ready.some((r) => r.replacing);
  const role = (r: string) => ROLE_LABEL[r] ?? r;
  async function submit() {
    setBusy(true); setError('');
    try {
      const r = await jstApi.bundleVerify(ready.map((x) => ({ id: x.id, signature: x.signature, uploadSignature: x.uploadSignature })), ack, sync, replaceOk);
      const failed = r.results.filter((x) => !x.ok);
      setResult(`已验证 ${r.verified} 个${sync ? `，其中 ${r.results.filter((x) => x.queued).length} 个已加入聚水潭同步队列` : ''}${failed.length ? `；${failed.length} 个没通过：${failed.slice(0, 3).map((x) => x.error).join('；')}` : ''}`);
      if (r.verified) onDone();
      if (failed.length) setTick((n) => n + 1);
    } catch (e) { setError(msg(e)); }
    setBusy(false);
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal card wide" role="dialog" aria-label="核对并验证组合编码">
        <div className="modal-head between"><strong>核对并验证组合（共 {ids.length} 个）</strong><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          {error && <div role="alert" className="notice error">{error}</div>}
          {result && <div role="status" className="notice ok">{result}</div>}
          <div className="row-actions">
            <button type="button" className="secondary-button small" disabled={index <= 0} onClick={() => setIndex(index - 1)}>上一个</button>
            <span>第 {index + 1} / {ids.length} 个</span>
            <button type="button" className="secondary-button small" disabled={index >= ids.length - 1} onClick={() => setIndex(index + 1)}>下一个</button>
            <span className="muted">可验证 {ready.length} 个</span>
          </div>
          {!cur && <p className="muted">加载中…</p>}
          {cur && (
            <div>
              <h3>{cur.code} <span className="muted">{cur.name}</span></h3>
              {cur.issues.length > 0 && <div className="notice error" role="alert"><strong>验证前需要先处理这 {cur.issues.length} 个问题</strong><ul>{cur.issues.map((i, k) => <li key={k}>{i}</li>)}</ul></div>}
              {cur.pendingRevision && <div className="notice warn">有一份待发布的构成修订（原因：{cur.pendingRevision.reason}）。下面是修订后的构成，验证通过后随之生效。</div>}
              <table className="data-table">
                <thead><tr><th>用途</th><th>基础编码</th><th>名称</th><th className="num">数量</th><th>单位</th><th>进聚水潭</th><th className="num">损耗率%</th><th className="num">重量(克)</th>{cur.totalCost !== undefined && <th className="num">成本(分)</th>}</tr></thead>
                <tbody>{cur.components.map((c, i) => <tr key={i}><td>{role(c.role)}</td><td>{c.code}</td><td>{c.name}</td><td className="num">{c.qty}</td><td>{c.unit || '—'}</td><td>{c.includeInJst ? '是' : '否'}</td><td className="num">{c.lossRate ?? 0}</td><td className="num">{c.weightG ?? '—'}</td>{cur.totalCost !== undefined && <td className="num">{c.cost ?? '—'}</td>}</tr>)}</tbody>
              </table>
              <p>合计重量 {cur.totalWeightG} 克{cur.totalCost !== undefined ? `，合计成本 ${cur.totalCost === null ? '—' : unitYuanText(cur.totalCost)} 元` : ''}</p>
              {cur.secondVerification && (<><h4>二次验证：和上次相比改了什么</h4><ChangeTable changes={cur.changes} baselineMissing={cur.baselineMissing} /></>)}
              <h4>实际上传到聚水潭的资料</h4>
              <table className="data-table"><tbody>
                <tr><th style={{ width: 120 }}>商品编码</th><td>{cur.outbound.sku_id}</td></tr><tr><th>款式编码</th><td>{cur.outbound.i_id || '—'}</td></tr>
                <tr><th>名称</th><td>{cur.outbound.name}</td></tr><tr><th>简称</th><td>{cur.outbound.short_name || '—'}</td></tr><tr><th>重量(kg)</th><td>{cur.outbound.weight}</td></tr>
                {cur.outbound.cost_price !== undefined && <tr><th>成本价</th><td>{cur.outbound.cost_price}</td></tr>}
              </tbody></table>
              {cur.replacing && <div className="notice warn">聚水潭上已有旧编码「{cur.uploadedCode}」，上传会变成改码。</div>}
            </div>
          )}
          <hr />
          <label className="check"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> 我已核对以上 {ready.length} 个组合的构成和上传内容，确认无误</label>
          {isAdmin && <label className="check"><input type="checkbox" checked={sync} onChange={(e) => setSync(e.target.checked)} /> 验证后加入聚水潭同步队列（只排队，不直接发送）</label>}
          {anyReplace && <label className="check"><input type="checkbox" checked={replaceOk} onChange={(e) => setReplaceOk(e.target.checked)} /> 已处理旧编码的库存、在途订单和店铺映射关联，确认禁用旧编码并创建新编码</label>}
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={onClose}>关闭</button>
          <button type="button" className="primary-button" disabled={busy || !ack || ready.length === 0 || (anyReplace && !replaceOk)} onClick={() => void submit()}>验证 {ready.length} 个</button>
        </div>
      </div>
    </div>
  );
}

/** 构成修订：已验证的组合要改主品时，提交一份“待发布”的新构成；赠品原样不能动；随组合验证生效。 */
export function RevisionDialog(props:{bundle:ResourceDto;onClose:()=>void;onDone:()=>void;onVerify?:()=>void;onApply?:()=>void}){return <BundleCompositionEditor {...props}/>;}

/** 删除（没验证过、没同步过、没有成本历史才能删，要输入编码确认）或失效归档（上传过聚水潭的同时排停用任务）。 */
export function RemoveDialog({ bundle, isAdmin, onClose, onDone }: { bundle: ResourceDto; isAdmin: boolean; onClose: () => void; onDone: () => void }) {
  const [pre, setPre] = useState<{ canDelete: boolean; reason: string; token: string; code: string } | null>(null);
  const [mode, setMode] = useState<'delete' | 'archive'>('archive');
  const [confirmCode, setConfirmCode] = useState('');
  const [reason, setReason] = useState('');
  const [disableOk, setDisableOk] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const synced = !!bundle.data.jstUploadedCode;
  useEffect(() => { jstApi.bundleDeletion(bundle.id).then((p) => { setPre(p); if (p.canDelete) setMode('delete'); }).catch((e) => setError(msg(e))); }, [bundle.id]);
  async function run() {
    setBusy(true); setError('');
    try { if (mode === 'delete') await jstApi.bundleDelete(bundle.id, pre!.token, confirmCode, reason.trim()); else await jstApi.bundleArchive(bundle.id, reason.trim(), disableOk); onDone(); onClose(); } catch (e) { setError(msg(e)); }
    setBusy(false);
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal card" role="dialog" aria-label="删除或归档组合">
        <div className="modal-head between"><strong>{bundle.title}</strong><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          {error && <div role="alert" className="notice error">{error}</div>}
          <div className="pill-row">
            <label className="check"><input type="radio" name="rm" checked={mode === 'delete'} disabled={!pre?.canDelete} onChange={() => setMode('delete')} /> 彻底删除</label>
            <label className="check"><input type="radio" name="rm" checked={mode === 'archive'} disabled={bundle.status === 'archived'} onChange={() => setMode('archive')} /> 失效归档</label>
          </div>
          {pre && !pre.canDelete && <p className="muted">不能彻底删除：{pre.reason}</p>}
          {mode === 'delete' && <label>请输入组合编码「{bundle.title}」确认<input value={confirmCode} onChange={(e) => setConfirmCode(e.target.value)} /></label>}
          {mode === 'archive' && synced && (isAdmin
            ? <label className="check"><input type="checkbox" checked={disableOk} onChange={(e) => setDisableOk(e.target.checked)} /> 这个组合上传过聚水潭，确认同时在聚水潭停用（排入同步队列）</label>
            : <p className="bad-text">这个组合上传过聚水潭，只有公司管理员能归档。</p>)}
          <label>原因（必填）<textarea rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="button" className="primary-button danger-fill" disabled={busy || reason.trim().length < 2 || (mode === 'delete' && !confirmCode.trim()) || (mode === 'archive' && synced && !disableOk)} onClick={() => void run()}>{mode === 'delete' ? '彻底删除' : '归档'}</button>
        </div>
      </div>
    </div>
  );
}
