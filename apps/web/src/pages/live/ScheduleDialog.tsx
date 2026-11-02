import { ChannelPicker, initialChannels } from './ChannelPicker';
import { useEffect, useRef, useState } from 'react';
import { TrialPersonDialog } from './TrialPersonDialog';
import { liveApi, type Options, type ScheduleBody, type ScheduleRow } from './liveApi';
import { errText } from './liveFormat';
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
  const [picked, setPicked] = useState<LiveProductSnapshot[]>(initial?.products?.length ? initial.products : [emptyManualProduct()]);
  const [importing, setImporting] = useState(false);
  const [importNote, setImportNote] = useState('');
  const request = useRef(0);
  useEffect(() => { request.current++; setImporting(false); setImportNote(''); return () => { request.current++; }; }, [f.roomId, f.date, f.startTime]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [trial,setTrial]=useState(false);
  useEffect(() => { liveApi.options().then(setOpts).catch((e) => setError(errText(e, '加载选项失败'))); }, []);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((cur) => ({ ...cur, [k]: e.target.value }));
  async function save() {
    setError('');
    if (!f.roomId || !f.startTime || !f.endTime || !f.anchorId || !channels.length || channels.some(c=>!c.storeIds.length)) return setError('请填写直播间、开始结束时间、主播、直播账号及关联店铺');
    const body: ScheduleBody = { channels,date: f.date, roomId: Number(f.roomId), startTime: f.startTime, endTime: f.endTime, anchorId: Number(f.anchorId), controlId: f.controlId ? Number(f.controlId) : null, operatorId: f.operatorId ? Number(f.operatorId) : null, douyinAccountId: channels[0].accountId, storeId: channels[0].storeIds[0], note: f.note.trim() || undefined, productEntries: productEntries(picked) };
    setBusy(true);
    try { if (initial) await liveApi.updateSchedule(initial.id, body); else await liveApi.createSchedule(body); onDone(); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
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
    <><Modal title={initial ? '修改排场' : '新增排场'} onClose={onClose} foot={<><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="button" className="primary-button" disabled={busy || importing || !opts} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</button></>}>
      {error && <div role="alert" className="notice error">{error}</div>}
      {!initial && <div className="live-import-previous"><button type="button" className="secondary-button" disabled={!opts || !f.roomId || importing || busy} onClick={() => void importPrevious()}>{importing ? '导入中…' : '一键导入上次排场'}</button><small className="muted">先选择房间；导入开始时间之前最近一场未取消的配置。未填开始时间时读取所选日期及之前的最近一场，导入后需核对保存。</small></div>}
      {importNote && <p className="notice" role="status">{importNote}</p>}
      <p className="muted">结束时间早于开始时间表示跨到第二天；单场最长 16 小时；同一直播间时间段不能重叠，同一主播不能同时在两个房间。</p>
      {!opts ? <p className="muted" role="status">正在读取选项…</p> : (
        <div className="live-fields live-schedule-form">
          <label className="live-field">日期<select aria-label="排场日期" value={f.date} onChange={set('date')}>{days.map((d) => <option key={d} value={d}>{dayLabel(d)}</option>)}</select></label>
          <label className="live-field">直播间<select aria-label="直播间" value={f.roomId} onChange={set('roomId')}><option value="">请选择</option>{opts.rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
          <label className="live-field">开始时间<input aria-label="开始时间" type="time" value={f.startTime} onChange={set('startTime')} /></label>
          <label className="live-field">结束时间<input aria-label="结束时间" type="time" value={f.endTime} onChange={set('endTime')} /></label>
          <label className="live-field">主播<select aria-label="主播" value={f.anchorId} onChange={set('anchorId')}><option value="">请选择</option>{opts.anchors.map((p) => <option key={p.id} value={p.id}>{p.name}{p.trial?'（试播）':p.partTime?'（兼职）':''}</option>)}</select><button type="button" className="link-button" onClick={()=>setTrial(true)}>＋ 新增试播主播</button></label>
          <label className="live-field">中控（可选）<select aria-label="中控" value={f.controlId} onChange={set('controlId')}><option value="">无</option>{opts.controls.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label className="live-field">运营（可选）<select aria-label="运营" value={f.operatorId} onChange={set('operatorId')}><option value="">无</option>{opts.operators.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <ChannelPicker options={opts} value={channels} onChange={setChannels}/>
          <ManualProductEditor products={picked} onChange={setPicked} />
          <label className="live-field wide">备注（可选）<input aria-label="备注" maxLength={500} value={f.note} onChange={set('note')} /></label>
        </div>
      )}
    </Modal>{trial&&<TrialPersonDialog onClose={()=>setTrial(false)} onDone={p=>{setTrial(false);setF(f=>({...f,anchorId:String(p.id)}));liveApi.options().then(setOpts).catch(e=>setError(errText(e)));}}/>}</>
  );
}

