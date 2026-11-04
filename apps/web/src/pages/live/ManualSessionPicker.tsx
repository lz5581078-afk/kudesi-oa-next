import { PersonPhotoName, SelectedAnchorProfile } from './PersonPhotoName';
import { useEffect, useState } from 'react';
import { liveApi, type Options, type SessionList } from './liveApi';
import { errText } from './liveFormat';

export function ManualSessionPicker({ options, onPick }: { options: Options | null; onPick: (id: number) => void }) {
  const [date, setDate] = useState('');
  const [room, setRoom] = useState('');
  const [anchor, setAnchor] = useState('');
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<SessionList | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    setResult(null);
    setError('');
    liveApi.sessions({ from: date, to: date, roomId: room, anchorId: anchor, page, pageSize: 8 })
      .then(data => { if (current) setResult(data); })
      .catch(e => { if (current) setError(errText(e, '场次列表加载失败')); });
    return () => { current = false; };
  }, [date, room, anchor, page, retry]);
  return <fieldset><legend>选择要补报的场次</legend>
    <p className="muted">最近开播的场次排在最前。可按日期、直播间或主播缩小范围。</p>
    <div className="live-fields">
      <label className="live-field">直播日期<input type="date" value={date} onChange={e => { setDate(e.target.value); setPage(1); }}/></label>
      <label className="live-field">筛选直播间<select value={room} onChange={e => { setRoom(e.target.value); setPage(1); }}><option value="">全部直播间</option>{options?.rooms.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
      <label className="live-field">筛选主播<select value={anchor} onChange={e => { setAnchor(e.target.value); setPage(1); }}><option value="">全部主播</option>{options?.anchors.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select><SelectedAnchorProfile personId={Number(anchor)} name={options?.anchors.find(p=>String(p.id)===anchor)?.name}/></label>
    </div>
    {error ? <p role="alert">{error} <button className="link-button" onClick={() => setRetry(n=>n+1)}>重试</button></p> : !result ? <p role="status">正在查询场次…</p> : <>
      {!result.rows.length ? <p role="status">没有匹配的场次。可以调整筛选条件，或选择「新建补报」。</p> :
        <div className="live-scroll"><table className="data-table"><thead><tr><th>开播时间</th><th>直播间</th><th>主播</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>{result.rows.map(r => <tr key={r.id}><td>{r.startAt.slice(0,16)}</td><td>{r.roomName}</td><td><PersonPhotoName personId={r.anchor.id} name={r.anchor.name}/></td><td>{r.statusLabel}</td>
            <td>{['live','pending_report','returned'].includes(r.status) ? <button className="link-button" onClick={() => onPick(r.id)}>选择并载入</button> : '已进入审核，无法补报'}</td></tr>)}</tbody></table></div>}
      {result.total > result.pageSize && <div className="live-actions"><button disabled={page<=1} onClick={()=>setPage(page-1)}>上一页</button>第 {page} / {Math.ceil(result.total/result.pageSize)} 页<button disabled={page*result.pageSize>=result.total} onClick={()=>setPage(page+1)}>下一页</button></div>}
    </>}
  </fieldset>;
}
