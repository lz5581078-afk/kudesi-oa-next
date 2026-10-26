import { useCallback, useEffect, useRef, useState } from 'react';
import { REMOTE_MODE_LABEL, type RemoteMode } from '@kudesi/shared';
import { ApiError } from '../../../api/client';
import { remoteApi, type RemoteApi, type RemoteSession, type RemoteShopState } from './remoteApi';
import { createViewerConnection, keyInputFrom, mapPointer, type ViewerConnection } from './viewerConnection';

const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
const POLL_MS = 500;
const MOVE_MS = 40;

type Phase = 'form' | 'waiting' | 'active' | 'ended';
type Link = 'connecting' | 'connected' | 'failed' | 'closed';

/**
 * 远程协助窗口（店铺提现 → 某家店铺 → “远程协助”）。
 * 流程：填事由、选“只观看/可操作” → 申请 → 等电脑上的助手（和电脑主人）同意 → 建立 WebRTC 连接，看到店铺窗口画面。
 * 全程有倒计时；关闭窗口就是结束协助。画面和操作不经过服务器，只有申请、结束和信令会记录。
 */
export function RemoteAssistDialog({ shopId, storeName, deviceName, state, client = remoteApi, onClose }: { shopId: number; storeName: string; deviceName: string; state: RemoteShopState; client?: RemoteApi; onClose: () => void }) {
  const resume = state.live?.mine ? state.live : null; // 我有一场没结束的：还在等同意就接着等；已经开始的画面接不回来（刷新过页面），先结束旧的再重新申请
  const [phase, setPhase] = useState<Phase>(resume?.status === 'requested' ? 'waiting' : 'form');
  const [mode, setMode] = useState<RemoteMode>('view');
  const [reason, setReason] = useState('');
  const [sessionId, setSessionId] = useState<number | null>(resume?.status === 'requested' ? resume.id : null);
  const [info, setInfo] = useState<RemoteSession | null>(null);
  const [link, setLink] = useState<Link>('connecting');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [left, setLeft] = useState(0);
  const video = useRef<HTMLVideoElement | null>(null);
  const conn = useRef<ViewerConnection | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const alive = useRef(true);
  const lastMove = useRef(0);
  const pressed = useRef(false);
  const modeRef = useRef<RemoteMode>('view');
  modeRef.current = info?.mode ?? mode;

  const fail = (e: unknown, fallback: string) => setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : fallback);

  const attachStream = useCallback((s: MediaStream | null) => { stream.current = s; if (video.current && s) { video.current.srcObject = s; void video.current.play?.().catch(() => undefined); } }, []);
  useEffect(() => { if (phase === 'active') attachStream(stream.current); }, [phase, attachStream]);

  // 轮询：状态 + 信令。轮询本身是网页端的“心跳”，停了 45 秒 OA 会结束这场协助。
  useEffect(() => {
    if (sessionId === null || phase === 'form' || phase === 'ended') return;
    let cursor = 0, stopped = false, timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      try {
        const r = await client.poll(sessionId, cursor);
        if (stopped) return;
        setInfo(r); setLeft(r.secondsLeft);
        if (r.status === 'ended') { conn.current?.close(); conn.current = null; setPhase('ended'); return; }
        if (r.status === 'active') {
          if (!conn.current) {
            const full = await client.get(sessionId);
            if (stopped) return;
            conn.current = createViewerConnection({
              iceServers: full.iceServers ?? [],
              sendSignal: (kind, payload) => client.signal(sessionId, kind, payload),
              onStream: attachStream,
              onState: (s) => { if (alive.current) setLink(s); },
              onMessage: (m) => { if (m.t === 'notice' && typeof m.message === 'string') setNotice(m.message); },
            });
            setPhase('active');
          }
          if (r.signals.length) { cursor = Math.max(cursor, ...r.signals.map((s) => s.id)); await conn.current.handleSignals(r.signals); }
        }
      } catch (e) {
        if (!stopped) fail(e, '和 OA 的连接出了问题');
        if (e instanceof ApiError && [403, 404].includes(e.status)) return;
      }
      if (!stopped) timer = setTimeout(loop, POLL_MS);
    };
    void loop();
    return () => { stopped = true; clearTimeout(timer); };
  }, [sessionId, phase === 'form' || phase === 'ended', client, attachStream]); // eslint-disable-line react-hooks/exhaustive-deps

  // 倒计时
  useEffect(() => {
    if (phase !== 'active') return;
    const t = setInterval(() => setLeft((x) => Math.max(0, x - 1)), 1000);
    return () => clearInterval(t);
  }, [phase]);

  useEffect(() => { if (resume?.status === 'active') void client.end(resume.id).catch(() => undefined); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 关掉窗口 = 结束协助（离开页面也尽力通知）
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; conn.current?.close(); conn.current = null; };
  }, []);

  const start = async () => {
    setError('');
    try { const r = await client.request(shopId, { mode, reason: reason.trim() }); setSessionId(r.id); setPhase('waiting'); }
    catch (e) { fail(e, '申请失败'); }
  };
  const finish = async () => {
    if (sessionId !== null && phase !== 'ended') await client.end(sessionId).catch(() => undefined);
    conn.current?.close(); conn.current = null;
    onClose();
  };
  const extend = () => { if (sessionId !== null) client.extend(sessionId).then((r) => { setInfo((x) => (x ? { ...x, ...r } : r)); setLeft(r.secondsLeft); }).catch((e) => fail(e, '延长失败')); };

  // ---------- 操作：鼠标、滚轮、键盘、粘贴 ----------
  const send = (input: Parameters<ViewerConnection['sendInput']>[0]) => { conn.current?.sendInput(input).catch((e) => setNotice((e as Error).message)); };
  const point = (e: { clientX: number; clientY: number }) => {
    const v = video.current;
    return v ? mapPointer(v.getBoundingClientRect(), v.videoWidth, v.videoHeight, e.clientX, e.clientY) : null;
  };
  const buttonOf = (b: number) => (b === 2 ? 'right' : b === 1 ? 'middle' : 'left') as 'left' | 'right' | 'middle';
  const control = modeRef.current === 'control';

  const screen = (
    <div
      className="remote-screen" tabIndex={0} role="application" aria-label="远程画面"
      style={{ background: '#111', borderRadius: 6, outline: 'none', position: 'relative', minHeight: 360 }}
      onContextMenu={(e) => e.preventDefault()}
      onMouseDown={(e) => { if (!control) return; e.currentTarget.focus(); const p = point(e); if (p) { pressed.current = true; send({ t: 'down', x: p.x, y: p.y, button: buttonOf(e.button) }); } }}
      onMouseUp={(e) => { if (!control || !pressed.current) return; pressed.current = false; const p = point(e); if (p) send({ t: 'up', x: p.x, y: p.y, button: buttonOf(e.button) }); }}
      onMouseMove={(e) => { if (!control) return; const now = Date.now(); if (now - lastMove.current < MOVE_MS) return; lastMove.current = now; const p = point(e); if (p) send({ t: 'move', x: p.x, y: p.y }); }}
      onWheel={(e) => { if (!control) return; const p = point(e); if (p) { e.preventDefault(); send({ t: 'wheel', x: p.x, y: p.y, dx: Math.max(-3000, Math.min(3000, e.deltaX)), dy: Math.max(-3000, Math.min(3000, e.deltaY)) }); } }}
      onKeyDown={(e) => { if (!control) return; const k = keyInputFrom(e.nativeEvent); if (k) { e.preventDefault(); send(k); } }}
      onCompositionEnd={(e) => { if (control && e.data) for (let i = 0; i < e.data.length; i += 200) send({ t: 'text', text: e.data.slice(i, i + 200) }); }}
      onPaste={(e) => { if (!control) return; const t = e.clipboardData.getData('text'); if (t) { e.preventDefault(); for (let i = 0; i < Math.min(t.length, 1000); i += 200) send({ t: 'text', text: t.slice(i, i + 200) }); } }}
    >
      <video ref={video} autoPlay muted playsInline style={{ width: '100%', maxHeight: '62vh', display: 'block', objectFit: 'contain' }} />
      {link !== 'connected' && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ddd', pointerEvents: 'none' }}>
        {link === 'failed' ? '连接失败：网络可能无法直连，请联系管理员检查 TURN 服务' : '正在建立连接…'}</div>}
    </div>
  );

  return (
    <div className="modal-backdrop" role="presentation"><div className="modal card wide" role="dialog" aria-label="远程协助">
      <div className="modal-head between"><strong>远程协助 · {storeName}</strong><span className="muted">电脑：{deviceName}</span></div>
      <div className="modal-body">
        {phase === 'form' && (
          <>
            <p className="muted">让电脑「{deviceName}」上的助手把「{storeName}」的店铺窗口画面传给你（点对点传输，不经过服务器）。需要这台电脑上的助手同意，最长 {state.maxMinutes} 分钟；对方只能看到并操作这家店铺的浏览器窗口。申请、开始、结束和时长都会记入操作日志。</p>
            <label className="check-line"><input type="radio" name="remote-mode" checked={mode === 'view'} onChange={() => setMode('view')} />只观看（不能点击、输入）</label>
            <label className="check-line"><input type="radio" name="remote-mode" disabled={!state.allowControl} checked={mode === 'control'} onChange={() => setMode('control')} />可操作（可以点击、滑动验证、输入）{!state.allowControl && <span className="muted">　这台电脑只允许观看</span>}</label>
            <label>事由 *<input value={reason} maxLength={100} placeholder="例如：拼多多提现要滑块验证，需要在电脑上完成" onChange={(e) => setReason(e.target.value)} /></label>
          </>
        )}
        {phase === 'waiting' && <div role="status" className="notice">已向电脑「{deviceName}」发出申请，正在等对方同意（最多等 1 分钟）…{info?.mode ? `（${REMOTE_MODE_LABEL[info.mode]}）` : ''}</div>}
        {phase === 'active' && (
          <>
            <div className="toolbar" style={{ padding: 0, border: 0 }}>
              <span className={`pill ${link === 'connected' ? 'ok' : link === 'failed' ? 'bad' : 'warn'}`}>{link === 'connected' ? '已连接' : link === 'failed' ? '连接失败' : '连接中'}</span>
              <span className="pill">{REMOTE_MODE_LABEL[info?.mode ?? mode]}</span>
              <span>剩余 <b className="mono" aria-label="剩余时间">{mmss(left)}</b></span>
              {info?.canExtend && <button type="button" className="secondary-button" onClick={extend}>延长 10 分钟</button>}
              {notice && <span className="muted">{notice}</span>}
            </div>
            {screen}
            {control ? <p className="muted">点击画面后可用键盘；中文请直接输入或粘贴。滑块验证：按住鼠标拖动即可。</p> : <p className="muted">当前是只观看，不能操作。</p>}
          </>
        )}
        {phase === 'ended' && (
          <div role="status" className={`notice ${info?.endReason === 'completed' || info?.endReason === 'cancelled' ? 'ok' : 'warn'}`}>
            协助已结束：{info?.endReasonLabel ?? '已结束'}{info?.durationSeconds ? `，用时 ${mmss(info.durationSeconds)}` : '（未开始）'}。
          </div>
        )}
        {error && <div role="alert" className="notice error">{error}</div>}
      </div>
      <div className="modal-foot">
        {phase === 'form' && <><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="button" className="primary-button" disabled={reason.trim().length < 2} onClick={start}>申请协助</button></>}
        {phase === 'waiting' && <button type="button" className="secondary-button" onClick={finish}>取消申请</button>}
        {phase === 'active' && <button type="button" className="primary-button" onClick={finish}>结束协助</button>}
        {phase === 'ended' && <button type="button" className="primary-button" onClick={onClose}>关闭</button>}
      </div>
    </div></div>
  );
}
