import { AnchorMonthSelect } from './AnchorMonthSelect';
import { ChannelPicker, initialChannels } from './ChannelPicker';
import { useEffect, useRef, useState } from 'react';
import { TrialPersonDialog } from './TrialPersonDialog';
import { liveApi, type Options, type ScheduleBody, type ScheduleRow } from './liveApi';
import { errText, yuanCents, yuanText } from './liveFormat';
import { Modal } from './liveUi';
import type { LiveProductSnapshot } from '@kudesi/shared';
import { ManualProductEditor } from './ManualProductEditor';
import { emptyManualProduct, productEntries } from './liveProducts';

const dayLabel = (day: string) => `${day.slice(5)} 周${['日','一','二','三','四','五','六'][new Date(`${day}T00:00:00Z`).getUTCDay()]}`;

export function ScheduleDialog({ initial, days, defaultRoom, defaultDay,onClose, onDone }: { initial: ScheduleRow | null; days: string[];defaultRoom?:number;defaultDay?:string; onClose: () => void; onDone: () => void }) {
  const [opts, setOpts] = useState<Options | null>(null);
  const [channels,setChannels]=useState(initialChannels(initial));
  const [f, setF] = useState({
    date: initial?.date ?? defaultDay ?? days[0], roomId: initial ? String(initial.roomId) : String(defaultRoom??''), startTime: initial?.startTime ?? '', endTime: initial?.endTime ?? '', anchorId: initial ? String(initial.anchor.id) : '',
    controlId: initial?.control ? String(initial.control.id) : '', operatorId: initial?.operator ? String(initial.operator.id) : '', douyinAccountId: initial ? String(initial.douyinAccount.id) : '', storeId: initial?.store ? String(initial.store.id) : '', note: initial?.note ?? '',
  });
  const [rate,setRate]=useState(yuanText(initial?.trialHourlyRateCents));
  const isTrial=opts?.anchors.some(p=>p.id===Number(f.anchorId)&&p.trial);
  const [picked, setPicked] = useState<LiveProductSnapshot[]>(initial?.products?.length ? initial.products : [emptyManualProduct()]);
  const [importing, setImporting] = useState(false);
  const [importNote, setImportNote] = useState('');
  const request = useRef(0);
  useEffect(() => { request.current++; setImporting(false); setImportNote(''); return () => { request.current++; }; }, [f.roomId, f.date, f.startTime]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [missingAnchor, setMissingAnchor] = useState(false);
  const [pending, setPending] = useState<ScheduleBody | null>(null);
  const saving = useRef(false);
  const [trial,setTrial]=useState(false);
  useEffect(() => { liveApi.options().then(setOpts).catch((e) => setError(errText(e, '加载选项失败'))); }, []);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((cur) => ({ ...cur, [k]: e.target.value }));
  async function save() {
    setError('');
    if (!f.anchorId) { setMissingAnchor(true); return; }
    if (!f.roomId || !f.startTime || !f.endTime) return setError('请填写直播间、开始结束时间');
    if (!channels.length) return setError('请勾选本场使用的直播账号');
    const missingStore = channels.find(c => !c.storeIds.length);
    if (missingStore) return setError(`请为「${opts?.douyinAccounts.find(a => a.id === missingStore.accountId)?.name ?? '已选账号'}」选择至少一个本场店铺；没有关联店铺时，请先维护自媒体账号档案。`);
    const cents=yuanCents(rate);
    if(isTrial && (!cents || !Number.isSafeInteger(cents) || cents<=0 || cents>2147483647)) return setError('请填写本场试播主播时薪');
    const body: ScheduleBody = { ...(isTrial ? {trialHourlyRateCents:cents!} : {}), channels,date: f.date, roomId: Number(f.roomId), startTime: f.startTime, endTime: f.endTime, anchorId: Number(f.anchorId), controlId: f.controlId ? Number(f.controlId) : null, operatorId: f.operatorId ? Number(f.operatorId) : null, douyinAccountId: channels[0].accountId, storeId: channels[0].storeIds[0], note: f.note.trim() || undefined, productEntries: productEntries(picked) };
    if (!f.controlId) { setPending(body); return; }
    await persist(body);
  }
  async function persist(body: ScheduleBody) {
    if (saving.current) return;
    saving.current = true;
    setPending(null);
    setBusy(true);
    try { if (initial) await liveApi.updateSchedule(initial.id, body); else await liveApi.createSchedule(body); onDone(); } catch (e) { setError(errText(e)); } finally { saving.current = false; setBusy(false); }
  }
  async function importPrevious() {
    if (!opts || !f.roomId) return;
    const token = ++request.current;
    setImporting(true); setError(''); setImportNote('');
    try {
      const row = await liveApi.previousSchedule({ roomId: Number(f.roomId), date: f.date, startTime: f.startTime || undefined });
      if (token !== request.current) return;
      if (!row) { setImportNote('该房间在所选日期和时间之前没有可导入的排场。'); return; }
      const available = (list: Array<{id:number}>, id?: number) => id && list.some((p) => p.id === id) ? String(id) : '';
      const imported = { anchorId: available(opts.anchors, row.anchor.id), controlId: available(opts.controls, row.control?.id), operatorId: available(opts.operators, row.operator?.id), douyinAccountId: available(opts.douyinAccounts, row.douyinAccount.id), storeId: available(opts.stores, row.store?.id) };
      let unavailable = !imported.anchorId || !imported.douyinAccountId || (row.control && !imported.controlId) || (row.operator && !imported.operatorId) || (row.store && !imported.storeId);
      setRate(yuanText(row.trialHourlyRateCents));
      setF((cur) => ({ ...cur, ...imported, note: row.note ?? '' }));
      const previousChannels=initialChannels(row);
      const usableChannels=previousChannels.filter(c=>opts.douyinAccounts.some(a=>a.id===c.accountId)).map(c=>({...c,storeIds:c.storeIds.filter(id=>{const a=opts.douyinAccounts.find(a=>a.id===c.accountId);return a?.storeIds?.includes(id)&&opts.stores.some(s=>s.id===id&&s.platform===a.platform);})}));
      unavailable ||= previousChannels.length!==usableChannels.length || usableChannels.some(c=>c.storeIds.length!==previousChannels.find(p=>p.accountId===c.accountId)?.storeIds.length);
      setChannels(usableChannels);
      setPicked(row.products?.length ? row.products : [emptyManualProduct()]);
      setImportNote(`已导入 ${row.date} ${row.startTime}–${row.endTime} 的人员、账号、店铺、产品和备注。本次日期、时间保持不变。${unavailable ? '部分人员或账号已停用，已清空，请重新选择。' : '请核对后保存。'}`);
    } catch (e) { if (token === request.current) setError(errText(e, '导入失败')); }
    finally { if (token === request.current) setImporting(false); }
  }
  return (
    <><Modal error={error} size="wide" title={initial ? '修改排场' : '新增排场'} onClose={onClose} foot={<><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="button" className="primary-button" disabled={busy || importing || !opts} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</button></>}>
      {!initial && <div className="live-import-previous"><button type="button" className="secondary-button" disabled={!opts || !f.roomId || importing || busy} onClick={() => void importPrevious()}>{importing ? '导入中…' : '一键导入上次排场'}</button><small className="muted">先选择房间；导入开始时间之前最近一场未取消的配置。未填开始时间时读取所选日期及之前的最近一场，导入后需核对保存。</small></div>}
      {importNote && <p className="notice" role="status">{importNote}</p>}
      <p className="live-schedule-intro">安排直播时间、人员与账号。保存后，相关人员将按系统通知设置收到排班通知。</p>
      {!opts ? <p className="muted" role="status">正在读取选项…</p> : (
        <div className="live-fields live-schedule-form">
          <section className="wide live-schedule-section"><h3><span>01</span> 时间与直播间</h3><div className="live-fields">
          <label className="live-field">日期<select aria-label="排场日期" value={f.date} onChange={set('date')}>{days.map((d) => <option key={d} value={d}>{dayLabel(d)}</option>)}</select></label>
          <label className="live-field">直播间<select aria-label="直播间" value={f.roomId} onChange={set('roomId')}><option value="">请选择</option>{opts.rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
          <label className="live-field">开始时间<input aria-label="开始时间" type="time" value={f.startTime} onChange={set('startTime')} /></label>
          <label className="live-field">结束时间<input aria-label="结束时间" type="time" value={f.endTime} onChange={set('endTime')} /></label>
          </div><p className="live-section-help">时间均为北京时间。结束时间早于开始时间表示次日结束，单场最长 16 小时；直播间和主播的时间不能冲突。</p></section>
          <section className="wide live-schedule-section"><h3><span>02</span> 本场人员</h3><div className="live-fields live-people-fields"><label className="live-field">主播<AnchorMonthSelect people={opts.anchors} value={f.anchorId} onChange={e=>{setRate('');set('anchorId')(e);}}/><button type="button" className="link-button" onClick={()=>setTrial(true)}>＋ 新增试播主播</button></label>
            {isTrial && <label className="live-field trial-rate-required">本场试播时薪（元/小时）· 必填<input aria-label="本场试播时薪" inputMode="decimal" required value={rate} onChange={e=>setRate(e.target.value)}/></label>}
          <label className="live-field">中控（可选）<select aria-label="中控" value={f.controlId} onChange={set('controlId')}><option value="">无</option>{opts.controls.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label className="live-field">运营（可选）<select aria-label="运营" value={f.operatorId} onChange={set('operatorId')}><option value="">无</option>{opts.operators.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          </div></section>
          <section className="wide live-schedule-section"><h3><span>03</span> 直播账号与本场店铺</h3><ChannelPicker options={opts} value={channels} onChange={setChannels}/></section>
          <section className="wide live-schedule-section"><h3><span>04</span> 产品与备注</h3>
          <ManualProductEditor products={picked} onChange={setPicked} />
          <label className="live-field wide">备注（可选）<input aria-label="备注" maxLength={500} value={f.note} onChange={set('note')} /></label></section>
        </div>
      )}
    </Modal>{missingAnchor&&<Modal title="请选择本场主播" onClose={()=>setMissingAnchor(false)} foot={<button type="button" className="primary-button" onClick={()=>{setMissingAnchor(false);requestAnimationFrame(()=>document.querySelector<HTMLSelectElement>('select[aria-label="主播"]')?.focus());}}>返回补选主播</button>}><p className="notice">本场尚未选择主播，不能保存排班。请返回选择主播后再保存。</p>{!f.controlId&&<p>中控也尚未选择，请一并核对。</p>}</Modal>}{pending&&<Modal title="确认未安排中控" onClose={()=>setPending(null)} foot={<><button type="button" className="secondary-button" onClick={()=>setPending(null)}>返回补选</button><button type="button" className="primary-button" disabled={busy} onClick={()=>void persist(pending)}>确认无中控并保存</button></>}>
      <p className="notice">本场尚未选择中控，请确认是否继续保存。</p>
      <p>{pending.date} · {pending.startTime}–{pending.endTime} · {opts?.rooms.find(r=>r.id===pending.roomId)?.name}</p>
      <p>主播：{opts?.anchors.find(p=>p.id===pending.anchorId)?.name}　中控：未安排</p>
    </Modal>}{trial&&<TrialPersonDialog onClose={()=>setTrial(false)} onDone={(p,cents)=>{setTrial(false);setRate(yuanText(cents));setF(f=>({...f,anchorId:String(p.id)}));liveApi.options().then(setOpts).catch(e=>setError(errText(e)));}}/>}</>
  );
}

