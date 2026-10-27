import { useEffect, useState } from 'react';
import { liveApi, type Options, type Product, type ScheduleRow } from './liveApi';
import { errText, nowText } from './liveFormat';
import { Modal, names } from './liveUi';

/** 报上播：从排场带出（人、房间已定），或临时加场；必须选抖音号、店铺和至少 1 个在卖产品。 */
export function StartDialog({ schedule, identity, onClose, onDone }: { schedule: ScheduleRow | null; identity: { isAnchor: boolean; isControl: boolean; canManage: boolean }; onClose: () => void; onDone: (sessionId: number) => void }) {
  const [opts, setOpts] = useState<Options | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [roomId, setRoomId] = useState('');
  const [anchorId, setAnchorId] = useState('');
  const [controlId, setControlId] = useState('');
  const [operatorId, setOperatorId] = useState('');
  const [accountId, setAccountId] = useState(schedule ? String(schedule.douyinAccount.id) : '');
  const [storeId, setStoreId] = useState(schedule?.store ? String(schedule.store.id) : '');
  const [startAt, setStartAt] = useState(nowText());
  const [keyword, setKeyword] = useState('');
  const [found, setFound] = useState<Product[]>([]);
  const [picked, setPicked] = useState<Product[]>([]);

  useEffect(() => { liveApi.options().then(setOpts).catch((e) => setError(errText(e, '加载选项失败'))); }, []);
  useEffect(() => {
    const t = setTimeout(() => { liveApi.products(keyword.trim()).then(setFound).catch(() => setFound([])); }, 250);
    return () => clearTimeout(t);
  }, [keyword]);

  const toggle = (p: Product) => setPicked((cur) => (cur.some((x) => x.id === p.id) ? cur.filter((x) => x.id !== p.id) : cur.length >= 100 ? cur : [...cur, p]));
  const store = opts?.stores.find((s) => String(s.id) === storeId);

  async function submit() {
    setError('');
    if (!schedule && !roomId) return setError('请选择直播间');
    if (!accountId) return setError('请选择抖音号');
    if (!storeId) return setError('请选择抖音店铺');
    if (!picked.length) return setError('请至少选择 1 个在卖产品');
    setBusy(true);
    try {
      const r = await liveApi.start({
        scheduleId: schedule?.id ?? null, roomId: roomId ? Number(roomId) : null, anchorId: anchorId ? Number(anchorId) : null, controlId: controlId ? Number(controlId) : null, operatorId: operatorId ? Number(operatorId) : null,
        douyinAccountId: Number(accountId), storeId: Number(storeId), productIds: picked.map((p) => p.id), startAt: startAt.length === 16 ? `${startAt}:00` : startAt,
      });
      onDone(r.id);
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }

  return (
    <Modal title={schedule ? '报上播（按排场）' : '报上播（临时加场）'} onClose={onClose} foot={<>
      <button type="button" className="secondary-button" onClick={onClose}>取消</button>
      <button type="button" className="primary-button" disabled={busy || !opts} onClick={() => void submit()}>{busy ? '提交中…' : '确认上播'}</button>
    </>}>
      {error && <div role="alert" className="notice error">{error}</div>}
      {schedule && <p className="muted">{schedule.roomName} · {schedule.startTime}–{schedule.endTime} · 主播 {schedule.anchor.name}{schedule.control ? `，中控 ${schedule.control.name}` : ''}{schedule.operator ? `，运营 ${schedule.operator.name}` : ''}</p>}
      {!opts ? <p className="muted" role="status">正在读取选项…</p> : (
        <div className="live-fields">
          {!schedule && (
            <>
              <label className="live-field">直播间<select value={roomId} onChange={(e) => setRoomId(e.target.value)}><option value="">请选择</option>{opts.rooms.map((r) => <option key={r.id} value={r.id} disabled={r.live}>{r.name}{r.live ? '（正在直播）' : ''}</option>)}</select></label>
              {(!identity.isAnchor || identity.canManage) && <label className="live-field">主播<select value={anchorId} onChange={(e) => setAnchorId(e.target.value)}><option value="">{identity.isAnchor ? '本人' : '请选择'}</option>{opts.anchors.map((p) => <option key={p.id} value={p.id} disabled={p.live}>{p.name}{p.live ? '（正在直播）' : ''}</option>)}</select></label>}
              <label className="live-field">中控（可选）<select value={controlId} onChange={(e) => setControlId(e.target.value)}><option value="">{identity.isControl && !identity.isAnchor ? '本人' : '无'}</option>{opts.controls.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
              <label className="live-field">运营（可选，审核时由人事确认）<select value={operatorId} onChange={(e) => setOperatorId(e.target.value)}><option value="">无</option>{opts.operators.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            </>
          )}
          <label className="live-field">抖音号<select value={accountId} onChange={(e) => setAccountId(e.target.value)}><option value="">请选择</option>{opts.douyinAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
          <label className="live-field">抖音店铺<select value={storeId} onChange={(e) => setStoreId(e.target.value)}><option value="">请选择</option>{opts.stores.map((s) => <option key={s.id} value={s.id}>{s.name}{s.hasJstShop ? '' : '（未绑定聚水潭店铺）'}</option>)}</select></label>
          <label className="live-field">上播时间<input aria-label="上播时间" value={startAt} onChange={(e) => setStartAt(e.target.value)} placeholder="2026-03-01 20:00" /></label>
          {store && !store.hasJstShop && <div className="notice warn wide">这个店铺的资料里还没有填「聚水潭店铺编号」，不能上播，请联系管理员补全。</div>}
          <div className="wide live-field">
            <span>在卖产品（{picked.length}/100，至少 1 个）</span>
            <input aria-label="搜索产品" type="search" placeholder="按编码或名称搜索" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
            <div className="live-pickbox" aria-label="产品列表">
              {found.length === 0 && <p className="muted pad">没有找到产品</p>}
              {found.map((p) => (
                <label key={p.id}><input type="checkbox" checked={picked.some((x) => x.id === p.id)} onChange={() => toggle(p)} />{p.code} · {p.name}{p.spec ? ` · ${p.spec}` : ''}</label>
              ))}
            </div>
            {picked.length > 0 && <div className="live-chips" aria-label="已选产品">{picked.map((p) => <button type="button" key={p.id} className="pill" onClick={() => toggle(p)} title="点击移除">{p.code} ×</button>)}</div>}
          </div>
        </div>
      )}
      {schedule && opts && <p className="muted">本场人员：{names(schedule.anchor, schedule.control, schedule.operator)}</p>}
    </Modal>
  );
}
