import { ChannelPicker, snapshotChannels } from './ChannelPicker';
import { StorePerformanceTable, storeDrafts, storePayload, type StoreDraft } from './StorePerformanceTable';
import { type LiveChannelInput, type LiveChannel } from '@kudesi/shared';
import { manualApiTime, manualSessionDraft } from './manualSessionDraft';
import { productText } from './liveProducts';
import { useEffect, useRef, useState } from 'react';
import { liveApi, type Options, type ManualBody, type SubmissionStatus, type SessionDetail } from './liveApi';
import { SubmissionNotice } from './SubmissionNotice';
import { errText, nowText, yuanCents } from './liveFormat';
import { TrialPersonDialog } from './TrialPersonDialog';
export function ManualReportsTab({ onOpen }: { onOpen: (id: number) => void }) {
  const [submission, setSubmission] = useState<SubmissionStatus | null>(null);
  const feedback = useRef<HTMLDivElement>(null);
  const checkSubmission = () => liveApi.submissionStatus().then(setSubmission).catch(() => setSubmission({ ready: false, message: '暂时无法检查审核流程，请重试。' }));
  useEffect(() => { void checkSubmission(); }, []);
  const [loadedSession,setLoadedSession]=useState<SessionDetail|null>(null);
  const [loading,setLoading]=useState(false);
  const loadVersion=useRef(0);
  useEffect(()=>()=>{loadVersion.current++;},[]);
  const [channels,setChannels]=useState<LiveChannelInput[]>([]),[storeRows,setStoreRows]=useState<StoreDraft[]>([]),[loadedChannels,setLoadedChannels]=useState<LiveChannel[]|null>(null);
  const [opts, setOpts] = useState<Options | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [trial, setTrial] = useState(false),
    [saved, setSaved] = useState<number | null>(null);
  useEffect(() => { if (error) feedback.current?.focus(); }, [error]);
  const [f, setF] = useState({
    sessionId: '',
    roomId: '',
    anchorId: '',
    controlId: '',
    operatorId: '',
    douyinAccountId: '',
    storeId: '',
    startAt: nowText(),
    endAt: nowText(),
    sales: '',
    controlSales: '',
    operatorSales: '',
    ad: '0',
    reason: '',
    orders: '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => {
    setSaved(null);
    if(k==='sessionId'){loadVersion.current++;setLoading(false);setLoadedSession(null);setLoadedChannels(null);setChannels([]);setStoreRows([]);}
    setF((v) => ({ ...v, [k]: e.target.value }));
  };
  useEffect(() => {
    liveApi
      .options()
      .then(setOpts)
      .catch((e) => setError(errText(e)));
  }, []);
  async function loadSession() {
    const id=Number(f.sessionId);
    if(!Number.isSafeInteger(id)||id<1)return setError('请输入有效的原场次编号');
    const version=++loadVersion.current;
    setError('');setSaved(null);setLoading(true);setLoadedSession(null);setLoadedChannels(null);setChannels([]);setStoreRows([]);
    try {
      const session=await liveApi.session(id);
      if(version!==loadVersion.current)return;
      const draft=manualSessionDraft(session,nowText());
      setLoadedSession(session);setChannels(draft.channels);setLoadedChannels(draft.snapshot);setStoreRows(draft.rows);setF(draft.fields);
    } catch(e) {if(version===loadVersion.current)setError(errText(e,'载入原场次失败'));}
    finally {if(version===loadVersion.current)setLoading(false);}
  }
  async function save() {
    setError('');
    if(loading || (f.sessionId && Number(f.sessionId)!==loadedSession?.id))return setError('请先成功载入该原场次，再填写和保存');
    if(loadedSession && !['live','pending_report','returned'].includes(loadedSession.status))return setError('该场次已提交审核或已审核，不能补报');
    const sales = channels.length?storeRows.reduce((n,r)=>n+(yuanCents(r.sales)||0),0):yuanCents(f.sales),
      ad = channels.length?storeRows.reduce((n,r)=>n+(yuanCents(r.ad)||0),0):yuanCents(f.ad),
      controlSales = yuanCents(f.controlSales),
      operatorSales = yuanCents(f.operatorSales);
    if (
      (f.controlSales && !Number.isSafeInteger(controlSales)) ||
      (f.operatorSales && !Number.isSafeInteger(operatorSales))
    )
      return setError('各角色销售额须为有效金额');
    if (
      !f.roomId ||
      !f.anchorId ||
      !channels.length || channels.some(c=>!c.storeIds.length) ||
      sales === null ||
      ad === null ||
      !Number.isSafeInteger(sales) ||
      !Number.isSafeInteger(ad) ||
      !f.reason.trim()
    )
      return setError('请完整填写房间、人员、账号、店铺、金额及特殊原因');
    setBusy(true);
    try {
      const body: ManualBody = {
        sessionId: f.sessionId ? Number(f.sessionId) : undefined,
        roomId: Number(f.roomId),
        anchorId: Number(f.anchorId),
        controlId: f.controlId ? Number(f.controlId) : null,
        operatorId: f.operatorId ? Number(f.operatorId) : null,
        channels,storeLines:storePayload(storeRows),
        douyinAccountId: channels[0].accountId,
        storeId: channels[0].storeIds[0],
        startAt: manualApiTime(f.startAt),
        endAt: manualApiTime(f.endAt),
        salesCents: sales,
        adSpendCents: ad,
        controlSalesCents: controlSales ?? undefined,
        operatorSalesCents: operatorSales ?? undefined,
        reason: f.reason.trim(),
        orderIds: f.orders.split(/[\s,，]+/).filter(Boolean),
      };
      const r = await liveApi.manualReport(body);
      setSaved(r.id);
      const fresh=loadedSession ? {...loadedSession,startAt:manualApiTime(f.startAt),endAt:manualApiTime(f.endAt)} : null;
      if(fresh)setLoadedSession(fresh);
      setF((v) => ({ ...v, sessionId: String(r.id) }));
      onOpen(r.id);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }
  const select = (
    key: 'roomId' | 'anchorId' | 'controlId' | 'operatorId' | 'douyinAccountId' | 'storeId',
    label: string,
    rows: Array<{ id: number; name: string; trial?: boolean }>,
  ) => (
    <label className="live-field">
      {label}
      <select disabled={!!loadedSession || loading} aria-label={label} value={f[key]} onChange={set(key)}>
        <option value="">请选择</option>
        {loadedSession&&f[key]&&!rows.some(row=>String(row.id)===f[key])&&<option value={f[key]}>原记录：{({roomId:loadedSession.roomName,anchorId:loadedSession.anchor.name,controlId:loadedSession.control?.name,operatorId:loadedSession.operator?.name,douyinAccountId:loadedSession.douyinAccount.name,storeId:loadedSession.store?.name})[key]??f[key]}</option>}
        {rows.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.trial ? '（试播）' : ''}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <section className="card live-section live-manual-report">
      <h2>人事手工业绩填报</h2>
      <div className="pad live-page">
        <p className="notice warn">
          用于试播、漏报或接口异常。填写后保存并核对，再提交审核；审核通过后才计入提成与工资。无订单的业绩需填写特殊原因。
        </p>
        {submission ? <SubmissionNotice status={submission} onRefresh={() => void checkSubmission()} /> : <p role="status" className="muted">正在检查审核流程…</p>}
        <div className="live-fields">
          <label className="live-field">
            已有场次编号（补报时填写）
            <input aria-label="补报场次编号" inputMode="numeric" value={f.sessionId} onChange={set('sessionId')} />
            <button type="button" disabled={busy||loading} className="link-button" onClick={() => void loadSession()}>
              载入原场次
            </button>
          </label>
        </div>
        {!!f.sessionId&&!loadedSession&&!loading&&<p className="muted">请输入场次编号并点击「载入原场次」，成功载入后才能保存补报。</p>}
        {loading&&<p role="status">正在载入原场次…</p>}
        {loadedSession&&<div className="notice" role="status"><strong>已载入原场次 #{loadedSession.id} · {loadedSession.statusLabel}</strong><p>房间、人员、账号、店铺和开播时间沿用原记录；可补充或修改营业额、投流费用、下播时间、订单及核定原因。保存后仍需审核。</p><p>原场次产品：{productText(loadedSession.products)}</p>{!['live','pending_report','returned'].includes(loadedSession.status)&&<p>该场次已提交审核或已审核，当前只供核对，不能补报。</p>}</div>}
        {opts && (
          <>
            <fieldset>
              <legend>房间与参与人员</legend>
              <div className="live-fields">
                {select('roomId', '直播间', opts.rooms)}
                {select('anchorId', '主播', opts.anchors)}
                {select('controlId', '中控（可选）', opts.controls)}
                {select('operatorId', '运营（可选）', opts.operators)}
                <button disabled={!!loadedSession||loading} className="secondary-button" onClick={() => setTrial(true)}>
                  新增试播主播
                </button>
              </div>
            </fieldset>
            <fieldset>
              <legend>场次与业绩</legend>
              <div className="live-fields">
                {loadedChannels ? <p className="muted wide">沿用原场次平台、账号和店铺：{loadedChannels.map(c=>c.accountName).join('、')}</p> : <ChannelPicker options={opts} value={channels} onChange={next=>{setChannels(next);const draft=storeDrafts(snapshotChannels(opts,next));setStoreRows(draft.map(r=>storeRows.find(old=>old.storeId===r.storeId)??r));setSaved(null);}}/>}
                <label className="live-field">
                  上播时间（北京时间）
                  <input
                    type="datetime-local"
                    step="1"
                    aria-label="补报上播时间"
                    disabled={!!loadedSession||loading}
                    value={f.startAt.replace(' ', 'T')}
                    onChange={set('startAt')}
                  />
                </label>
                <label className="live-field">
                  下播时间（北京时间）
                  <input
                    type="datetime-local"
                    step="1"
                    disabled={loading||!!loadedSession&&!['live','pending_report','returned'].includes(loadedSession.status)}
                    aria-label="补报下播时间"
                    value={f.endAt.replace(' ', 'T')}
                    onChange={set('endAt')}
                  />
                </label>
                <StorePerformanceTable readOnly={!!loadedSession&&!['live','pending_report','returned'].includes(loadedSession.status)} key={loadedSession?.id??'new'} channels={loadedChannels??snapshotChannels(opts,channels)} rows={storeRows} onChange={r=>{setStoreRows(r);setSaved(null);}} sessionId={f.sessionId?Number(f.sessionId):undefined} endAt={manualApiTime(f.endAt)}/>
                <label className="live-field wide">
                  特殊原因（必填）
                  <textarea disabled={loading||!!loadedSession&&!['live','pending_report','returned'].includes(loadedSession.status)} aria-label="补报原因" maxLength={500} rows={3} value={f.reason} onChange={set('reason')} />
                </label>
              </div>
            </fieldset>
          </>
        )}
        <div className="live-manual-feedback" ref={feedback} tabIndex={-1}>
          {error && <div role="alert" className="notice error">{error}</div>}
          {saved && <div role="status" className="notice ok">已保存场次 #{saved}，可在详情中核对并提交。<button type="button" className="link-button" onClick={() => onOpen(saved)}>打开场次详情</button></div>}
        </div>
        <div className="live-actions live-manual-actions">
          <p className="muted">保存后自动打开核对页面，填写内容会保留。</p>
          <button className="primary-button" disabled={busy || loading || !opts || saved !== null || (!!f.sessionId && Number(f.sessionId)!==loadedSession?.id) || (!!loadedSession&&!['live','pending_report','returned'].includes(loadedSession.status))} onClick={() => void save()}>
            {busy ? '保存中…' : saved ? '已保存' : '保存并核对'}
          </button>
        </div>
      </div>
      {trial && (
        <TrialPersonDialog
          onClose={() => setTrial(false)}
          onDone={(p) => {
            setTrial(false);
            setF((f) => ({ ...f, anchorId: String(p.id) }));
            liveApi
              .options()
              .then(setOpts)
              .catch((e) => setError(errText(e)));
          }}
        />
      )}
    </section>
  );
}
