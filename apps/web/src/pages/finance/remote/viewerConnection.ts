import { parseRemoteInput, type RemoteInput } from '@kudesi/shared';
import type { IceServer, RemoteSignal } from './remoteApi';

/**
 * 网页端的 WebRTC：用浏览器自带的 RTCPeerConnection 收助手发来的画面（视频轨道），
 * 通过数据通道 "input" 把操作发回去。信令（offer / answer / ice）走 OA 服务器的信箱，由对话框轮询后交给这里。
 * 这里不依赖 React，便于测试；`RTC` 可以替换成假的实现。
 */
/** 还没编号的操作（编号由连接补上） */
export type InputDraft = RemoteInput extends infer T ? (T extends { id: string } ? Omit<T, 'id'> & { id?: string } : never) : never;

export interface ViewerConnectionOptions {
  iceServers: IceServer[];
  /** 发信令给助手（join / answer / ice / bye） */
  sendSignal: (kind: 'join' | 'answer' | 'ice' | 'bye', payload: Record<string, unknown>) => Promise<unknown>;
  onStream: (stream: MediaStream) => void;
  /** idle → connecting → connected / failed / closed */
  onState: (state: 'connecting' | 'connected' | 'failed' | 'closed') => void;
  /** 助手通过数据通道发来的提示（如页面离开平台域名、当前模式） */
  onMessage?: (m: { t: string; [k: string]: unknown }) => void;
  RTC?: typeof RTCPeerConnection;
  resultTimeoutMs?: number;
}

export interface ViewerConnection {
  /** 处理一批从信箱领来的信令（按顺序） */
  handleSignals(signals: RemoteSignal[]): Promise<void>;
  /** 发一条操作；助手确认后 resolve，失败/超时 reject */
  sendInput(input: InputDraft): Promise<void>;
  readonly channelOpen: boolean;
  close(): void;
}

export function createViewerConnection(o: ViewerConnectionOptions): ViewerConnection {
  const RTC = o.RTC ?? RTCPeerConnection;
  const pc = new RTC({ iceServers: o.iceServers as RTCIceServer[], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
  pc.addTransceiver('video', { direction: 'recvonly' });
  let channel: RTCDataChannel | null = null;
  let remoteSet = false, closed = false, seq = 0;
  const buffered: RTCIceCandidateInit[] = [];
  const pending = new Map<string, { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let outChain: Promise<unknown> = Promise.resolve();
  // 信令必须按顺序送出（answer 先于 ice）
  const out = (kind: 'join' | 'answer' | 'ice' | 'bye', payload: Record<string, unknown>) => {
    outChain = outChain.then(() => o.sendSignal(kind, payload)).catch(() => undefined);
    return outChain;
  };
  o.onState('connecting');

  pc.ontrack = (e) => { o.onStream(e.streams[0] ?? new MediaStream([e.track])); };
  pc.onicecandidate = (e) => {
    void out('ice', e.candidate ? { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex } : { candidate: null });
  };
  pc.onconnectionstatechange = () => {
    if (closed) return;
    if (pc.connectionState === 'failed') o.onState('failed');
    else if (pc.connectionState === 'disconnected') o.onState('connecting');
  };
  pc.ondatachannel = (e) => {
    if (e.channel.label !== 'input' || channel) { e.channel.close(); return; }
    channel = e.channel;
    channel.onopen = () => { if (!closed) o.onState('connected'); };
    channel.onclose = () => { for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new Error('连接已断开')); pending.delete(id); } if (!closed) o.onState('failed'); };
    channel.onmessage = (ev) => {
      let m: { t?: string; id?: string; ok?: boolean; error?: string } & Record<string, unknown>;
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.t === 'result' && m.id && pending.has(m.id)) {
        const p = pending.get(m.id)!; pending.delete(m.id); clearTimeout(p.timer);
        if (m.ok) p.resolve(); else p.reject(new Error(m.error || '操作失败'));
      } else if (typeof m.t === 'string') o.onMessage?.(m as { t: string });
    };
  };

  // 对话框已确认电脑同意：马上告诉助手“我准备好了”，助手收到后生成 offer
  void out('join', {});

  const flushIce = async () => { remoteSet = true; for (const c of buffered.splice(0)) await pc.addIceCandidate(c).catch(() => undefined); };

  return {
    get channelOpen() { return channel?.readyState === 'open'; },
    async handleSignals(signals) {
      for (const s of signals) {
        if (closed) return;
        if (s.kind === 'offer' && typeof s.payload.sdp === 'string') {
          await pc.setRemoteDescription({ type: 'offer', sdp: s.payload.sdp });
          await flushIce();
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          void out('answer', { sdp: answer.sdp ?? '' });
        } else if (s.kind === 'ice') {
          const c = s.payload.candidate;
          if (c === null || c === undefined) continue; // 候选结束标记，不需要处理
          const init: RTCIceCandidateInit = { candidate: String(c), sdpMid: (s.payload.sdpMid as string | null) ?? null, sdpMLineIndex: (s.payload.sdpMLineIndex as number | null) ?? null };
          if (remoteSet) await pc.addIceCandidate(init).catch(() => undefined); else buffered.push(init);
        } else if (s.kind === 'bye') { o.onMessage?.({ t: 'bye' }); }
      }
    },
    sendInput(input) {
      if (!channel || channel.readyState !== 'open') return Promise.reject(new Error('连接还没建立'));
      const id = input.id ?? `i${Date.now().toString(36)}${(seq++).toString(36)}`;
      const msg = { ...input, id };
      if (!parseRemoteInput(msg)) return Promise.reject(new Error('无效的操作'));
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('操作确认超时')); }, o.resultTimeoutMs ?? 5000);
        pending.set(id, { resolve, reject, timer });
        try { channel!.send(JSON.stringify(msg)); } catch (e) { clearTimeout(timer); pending.delete(id); reject(e as Error); }
      });
    },
    close() {
      if (closed) return;
      closed = true;
      void out('bye', {});
      for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new Error('已关闭')); pending.delete(id); }
      try { channel?.close(); pc.close(); } catch { /* 已经关了 */ }
      o.onState('closed');
    },
  };
}

/** 把鼠标位置换算成画面里的 0~1 比例（视频按 contain 居中显示，黑边不算）；点在黑边上返回 null */
export function mapPointer(rect: { left: number; top: number; width: number; height: number }, videoWidth: number, videoHeight: number, clientX: number, clientY: number): { x: number; y: number } | null {
  if (![rect.width, rect.height, videoWidth, videoHeight, clientX, clientY].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0 || videoWidth <= 0 || videoHeight <= 0) return null;
  const scale = Math.min(rect.width / videoWidth, rect.height / videoHeight);
  const w = videoWidth * scale, h = videoHeight * scale;
  const left = rect.left + (rect.width - w) / 2, top = rect.top + (rect.height - h) / 2;
  if (clientX < left || clientY < top || clientX > left + w || clientY > top + h) return null;
  return { x: Math.min(1, Math.max(0, (clientX - left) / w)), y: Math.min(1, Math.max(0, (clientY - top) / h)) };
}

const KEY_MAP: Record<string, string> = { Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Escape: 'Escape', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ' ': 'Space' };

/** 键盘事件 → 远程按键；输入法组合中、功能键等不支持的返回 null */
export function keyInputFrom(e: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; isComposing?: boolean }): { t: 'key'; key: string; mods: number } | null {
  if (e.isComposing || e.key === 'Process' || e.key === 'Dead') return null;
  const key = KEY_MAP[e.key] ?? (e.key.length === 1 ? e.key : null);
  if (!key) return null;
  const mods = (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey && key.length > 1 ? 8 : 0);
  return { t: 'key', key, mods };
}
