import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { RunDetail } from './RunDetail';
import { flowApi, newRequestKey } from './flowApi';
import { exclusiveApi, type ExclusiveGrant, type ExclusiveOption, type ExclusiveOptions } from './exclusiveApi';

const STATUS: Record<ExclusiveGrant['status'], string> = { active: '专属生效中', expired: '已到期', cancelled: '已取消' };
const TONE: Record<ExclusiveGrant['status'], string> = { active: 'ok', expired: '', cancelled: 'bad' };
const day = (s: string) => (s ? new Date(s).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }) : '');

/** 专属品领取：选一个基础商品、写原因、提交流程；以及专属记录与历史（取消专属）。审批人和期限在“流程配置”里定，审批时填专属期。 */
export function ExclusivePage() {
  const { can } = useAuth();
  const canStart = can('flow.apply.view');
  const [tab, setTab] = useState<'apply' | 'grants'>('apply');
  const [opts, setOpts] = useState<ExclusiveOptions | null>(null);
  const [keyword, setKeyword] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [onlyFree, setOnlyFree] = useState(false);
  const [picked, setPicked] = useState<ExclusiveOption | null>(null);
  const [reason, setReason] = useState('');
  const [showMissing, setShowMissing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [openRun, setOpenRun] = useState<number | null>(null);
  const [grants, setGrants] = useState<ExclusiveGrant[] | null>(null);
  const [cancelling, setCancelling] = useState<{ id: number; reason: string } | null>(null);
  const keyRef = useRef(newRequestKey());

  const loadOptions = useCallback(() => {
    let alive = true;
    exclusiveApi.options({ keyword: keyword.trim() || undefined, categoryId: categoryId ? Number(categoryId) : undefined, onlyFree })
      .then((r) => alive && setOpts(r)).catch((e) => alive && setError(e instanceof ApiError ? e.message : '加载失败'));
    return () => { alive = false; };
  }, [keyword, categoryId, onlyFree]);
  useEffect(() => { const t = setTimeout(loadOptions, 250); return () => clearTimeout(t); }, [loadOptions]);
  const loadGrants = useCallback(() => { exclusiveApi.grants().then((r) => setGrants(r.rows)).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败')); }, []);
  useEffect(() => { if (tab === 'grants') loadGrants(); }, [tab, loadGrants]);

  const dirty = !!picked || !!reason.trim();
  const missing = [!picked && '基础商品', !reason.trim() && '领取原因'].filter(Boolean) as string[];
  const unavailable = (o: ExclusiveOption) => !!o.exclusive || (!!o.pending && !o.pending.mine);

  function ask() {
    if (missing.length) { setShowMissing(true); return; }
    setShowMissing(false); setError(''); setConfirm(true);
  }
  async function submit() {
    if (!picked) return;
    setBusy(true); setError('');
    try {
      const run = await flowApi.start('product-exclusive', { baseCodeId: picked.id, reason: reason.trim() }, keyRef.current);
      keyRef.current = newRequestKey();
      setNotice(`领取申请已提交（编号 #${run.id}）。通过后专属立即生效，可在“专属品管理与历史”查看；进度在“我发起的”。`);
      setPicked(null); setReason(''); setConfirm(false); setOpenRun(run.id); loadOptions();
    } catch (e) { setError(e instanceof ApiError ? e.message : '提交失败'); setConfirm(false); } finally { setBusy(false); }
  }
  async function doCancel() {
    if (!cancelling) return;
    if (!cancelling.reason.trim()) { setError('取消专属需要填写原因，本次没有取消。'); return; }
    setBusy(true); setError('');
    try {
      await exclusiveApi.cancel(cancelling.id, cancelling.reason.trim());
      setNotice('已取消专属：该基础商品恢复为可领取，历史记录已保留。'); setCancelling(null); loadGrants(); loadOptions();
    } catch (e) { setError(e instanceof ApiError ? e.message : '取消失败'); } finally { setBusy(false); }
  }
  function switchTab(t: 'apply' | 'grants') {
    if (t !== tab && tab === 'apply' && dirty && !window.confirm('领取申请还没有提交，切换后保留已填内容，确定切换吗？')) return;
    setTab(t);
  }

  return (
    <div className="exclusive-page">
      <div className="page-head"><h1>专属品领取</h1></div>
      <p className="muted">领取一个基础商品，其不同规格、平台和带赠品的组合共享专属归属；通过后到期前其他人不能再领。</p>
      <div className="tab-row" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'apply'} className={tab === 'apply' ? 'tab active' : 'tab'} onClick={() => switchTab('apply')}>申请领取</button>
        <button type="button" role="tab" aria-selected={tab === 'grants'} className={tab === 'grants' ? 'tab active' : 'tab'} onClick={() => switchTab('grants')}>专属品管理与历史</button>
      </div>
      {notice && <div role="status" className="notice ok-notice toast-line"><span>{notice}</span><button type="button" aria-label="关闭提示" onClick={() => setNotice('')}>✕</button></div>}
      {error && <div role="alert" className="notice error">{error}</div>}

      {tab === 'apply' && (
        <section className="card" style={{ padding: 16 }}>
          {!canStart && <div className="notice">你没有发起流程的权限，只能查看哪些商品可领取。</div>}
          <h3>选择基础商品 <b className="req">*</b></h3>
          {showMissing && !picked && <p className="field-error" role="alert">请先从下方列表选择要领取的基础商品。</p>}
          <div className="exclusive-filters">
            <select aria-label="商品分类" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">全部分类</option>
              {(opts?.categories ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <input type="search" aria-label="搜索基础商品" placeholder="输入商品名称或编码" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
            <label className="inline-check"><input type="checkbox" checked={onlyFree} onChange={(e) => setOnlyFree(e.target.checked)} /> 只看可领取</label>
          </div>
          {opts && (
            <p className="muted" role="status">
              共 {opts.total} 个商品，其中可领取 {opts.free} 个{opts.capped && `（只显示前 ${opts.rows.length} 个，请用搜索或分类缩小范围）`}
              {(keyword || categoryId || onlyFree) && <> · <button type="button" className="link-button" onClick={() => { setKeyword(''); setCategoryId(''); setOnlyFree(false); }}>清除筛选</button></>}
            </p>
          )}
          {opts && opts.rows.length === 0 && <div className="empty-state muted">没有符合条件的基础商品</div>}
          <div className="exclusive-options">
            {(opts?.rows ?? []).map((o) => (
              <button type="button" key={o.id} className="exclusive-option" aria-pressed={picked?.id === o.id} disabled={busy || unavailable(o) || !canStart}
                onClick={() => setPicked(o)}>
                <strong>{o.name}</strong>
                <small>{o.code}{o.categoryName ? ` · ${o.categoryName}` : ''}</small>
                <span className={`pill ${o.exclusive ? 'bad' : o.pending ? 'warn' : 'ok'}`}>
                  {o.exclusive ? `${o.exclusive.ownerName}专属，至${day(o.exclusive.endsAt)}` : o.pending ? (o.pending.mine ? '你已申请，审批中' : `${o.pending.requesterName}申请中`) : '可领取'}
                </span>
              </button>
            ))}
          </div>
          <p>已选：<strong>{picked ? `${picked.name}（${picked.code}）` : '尚未选择'}</strong></p>
          <label className="wide">
            <span>领取原因 <b className="req">*</b></span>
            <textarea aria-label="领取原因" maxLength={500} placeholder="说明为什么领取、计划如何经营（审批人会看到）" value={reason} onChange={(e) => setReason(e.target.value)} />
            <small className="muted">{reason.length}/500 字</small>
          </label>
          {showMissing && missing.length > 0 && <div className="notice error" role="alert"><strong>还有 {missing.length} 项没填好：</strong>{missing.join('、')}</div>}
          <div className="form-actions">
            {dirty && <span className="muted dirty-hint">有未提交的内容</span>}
            <button type="button" className="primary-button" disabled={busy || !canStart} onClick={ask}>提交领取申请</button>
          </div>
        </section>
      )}

      {tab === 'grants' && (
        <section className="card" style={{ padding: 16 }}>
          <p className="muted">本人可放弃专属；原审批人及管理员可取消。到期自动解除，历史保留。</p>
          {grants === null && <p role="status">正在读取…</p>}
          {grants?.length === 0 && <div className="empty-state muted">暂无专属领取记录</div>}
          <ul className="exclusive-grants">
            {(grants ?? []).map((g) => (
              <li key={g.id}>
                <div><strong>{g.productName}</strong> <span className={`pill ${TONE[g.status]}`}>{STATUS[g.status]}</span></div>
                <div className="muted">{g.ownerName} · {day(g.startsAt)} 至 {day(g.endsAt)} · 审批人：{g.approverName}{g.cancelReason && ` · 取消原因：${g.cancelReason}`}</div>
                {g.canCancel && cancelling?.id !== g.id && <button type="button" className="secondary-button" onClick={() => setCancelling({ id: g.id, reason: '' })}>取消专属</button>}
                {cancelling?.id === g.id && (
                  <div className="exclusive-cancel">
                    <label><span>取消“{g.productName}”专属的原因（必填）</span><input aria-label="取消原因" maxLength={500} value={cancelling.reason} onChange={(e) => setCancelling({ id: g.id, reason: e.target.value })} /></label>
                    <button type="button" className="primary-button" disabled={busy} onClick={doCancel}>确认取消专属</button>
                    <button type="button" className="secondary-button" onClick={() => setCancelling(null)}>先不取消</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {confirm && picked && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal card" role="dialog" aria-label="确认提交领取申请">
            <div className="modal-head between"><strong>确认提交？</strong></div>
            <div className="modal-body">
              <dl className="confirm-rows">
                <dt>领取商品</dt><dd>{picked.name}（{picked.code}）</dd>
                <dt>领取原因</dt><dd className="pre-wrap">{reason.trim()}</dd>
                <dt>提交后去向</dt><dd>交给流程配置的审批节点；通过后专属生效，可在“专属品管理与历史”查看。</dd>
              </dl>
            </div>
            <div className="modal-foot">
              <button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirm(false)}>返回修改</button>
              <button type="button" className="primary-button" disabled={busy} onClick={submit}>{busy ? '提交中…' : '确认提交申请'}</button>
            </div>
          </div>
        </div>
      )}
      {openRun && <RunDetail id={openRun} onClose={() => setOpenRun(null)} onChanged={loadOptions} />}
    </div>
  );
}
