/**
 * 远程协助（店铺提现里看/协助授权电脑上的店铺窗口）的共用约定：模式、期限、信令消息和远程输入的校验。
 * 网页端、后端用同一份；助手（apps/agent）是独立打包的，`apps/agent/src/remote-input.ts` 里有同样规则的一份，两边的测试用同一组用例。
 */

export const REMOTE_MODES = ['view', 'control'] as const;
export type RemoteMode = (typeof REMOTE_MODES)[number];
export const REMOTE_MODE_LABEL: Record<RemoteMode, string> = { view: '只观看', control: '可操作' };

export const REMOTE_LIMITS = {
  /** 申请发出后，电脑上的助手多久内必须同意，否则作废 */
  requestWaitSeconds: 60,
  defaultMinutes: 15,
  minMinutes: 5,
  /** 单次协助从开始算起的总上限（含延长） */
  hardCapMinutes: 60,
  extendMinutes: 10,
  /** 助手 / 网页多久没有联系就判定掉线并结束 */
  agentLostSeconds: 30,
  viewerLostSeconds: 45,
  signalMaxBytes: 64 * 1024,
  sdpMaxChars: 60_000,
  maxSignalsPerSession: 4000,
  reasonMin: 2,
  reasonMax: 100,
} as const;

/** 会话结束原因（写在记录和操作日志里） */
export const REMOTE_END_REASON_LABEL: Record<string, string> = {
  completed: '正常结束',
  cancelled: '申请人取消',
  declined: '电脑一方拒绝',
  no_response: '电脑没有响应',
  expired: '到达时限',
  agent_lost: '电脑上的助手掉线',
  viewer_lost: '网页端掉线',
  device_revoked: '电脑已被撤销',
  device_disabled: '电脑关闭了远程协助',
  shop_changed: '店铺已移除或改绑电脑',
  killed: '管理员紧急停止',
  error: '助手报告出错',
  ended_by_admin: '被管理员结束',
};

export type SignalDirection = 'toAgent' | 'toViewer';
/** 网页 → 助手 */
export const VIEWER_SIGNAL_KINDS = ['join', 'answer', 'ice', 'bye'] as const;
/** 助手 → 网页 */
export const AGENT_SIGNAL_KINDS = ['offer', 'ice', 'info', 'bye'] as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 校验一条信令消息；返回 null 表示合格，否则返回原因。 */
export function validateSignal(direction: SignalDirection, kind: unknown, payload: unknown): string | null {
  const kinds: readonly string[] = direction === 'toAgent' ? VIEWER_SIGNAL_KINDS : AGENT_SIGNAL_KINDS;
  if (typeof kind !== 'string' || !kinds.includes(kind)) return '不支持的信令类型';
  const p = payload ?? {};
  if (!isObj(p)) return '信令内容格式不对';
  if (JSON.stringify(p).length > REMOTE_LIMITS.signalMaxBytes) return '信令内容过大';
  if (kind === 'offer' || kind === 'answer') {
    return typeof p.sdp === 'string' && p.sdp.length > 0 && p.sdp.length <= REMOTE_LIMITS.sdpMaxChars ? null : '缺少有效的 SDP';
  }
  if (kind === 'ice') {
    const c = p.candidate;
    if (c !== null && !(typeof c === 'string' && c.length <= 4096)) return '候选地址无效';
    if (p.sdpMid !== undefined && p.sdpMid !== null && (typeof p.sdpMid !== 'string' || p.sdpMid.length > 64)) return '候选地址无效';
    if (p.sdpMLineIndex !== undefined && p.sdpMLineIndex !== null && !(Number.isInteger(p.sdpMLineIndex) && (p.sdpMLineIndex as number) >= 0 && (p.sdpMLineIndex as number) < 16)) return '候选地址无效';
    return null;
  }
  if (kind === 'info') return p.message === undefined || (typeof p.message === 'string' && p.message.length <= 200) ? null : '提示文字过长';
  return null;
}

// ---------------- 远程输入（走 WebRTC 数据通道，网页 → 助手） ----------------

export type MouseButton = 'left' | 'right' | 'middle';
export type RemoteInput =
  | { t: 'move'; id: string; x: number; y: number }
  | { t: 'down' | 'up'; id: string; x: number; y: number; button: MouseButton }
  | { t: 'click'; id: string; x: number; y: number; button: MouseButton; count: 1 | 2 }
  | { t: 'wheel'; id: string; x: number; y: number; dx: number; dy: number }
  | { t: 'key'; id: string; key: string; mods: number }
  | { t: 'text'; id: string; text: string };

/** 键盘修饰键位：alt=1 ctrl=2 meta=4 shift=8（和浏览器调试协议一致） */
export const NAMED_KEYS = [
  'Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown', 'Space',
] as const;

const num = (v: unknown, lo: number, hi: number): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);

/** 校验一条远程输入。坐标是相对画面的 0~1 比例；不合格返回 null。 */
export function parseRemoteInput(raw: unknown): RemoteInput | null {
  if (!isObj(raw)) return null;
  const id = typeof raw.id === 'string' && /^[\w-]{1,40}$/.test(raw.id) ? raw.id : null;
  if (!id) return null;
  const t = raw.t;
  if (t === 'key') {
    const key = raw.key;
    const mods = raw.mods === undefined ? 0 : num(raw.mods, 0, 15);
    if (typeof key !== 'string' || mods === null || !Number.isInteger(mods)) return null;
    if (!((key.length === 1) || (NAMED_KEYS as readonly string[]).includes(key))) return null;
    return { t, id, key, mods };
  }
  if (t === 'text') {
    return typeof raw.text === 'string' && raw.text.length > 0 && raw.text.length <= 200 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(raw.text) ? { t, id, text: raw.text } : null;
  }
  const x = num(raw.x, 0, 1), y = num(raw.y, 0, 1);
  if (x === null || y === null) return null;
  if (t === 'move') return { t, id, x, y };
  const button: MouseButton | null = raw.button === undefined ? 'left' : raw.button === 'left' || raw.button === 'right' || raw.button === 'middle' ? raw.button : null;
  if (!button) return null;
  if (t === 'down' || t === 'up') return { t, id, x, y, button };
  if (t === 'click') {
    const count = raw.count === undefined ? 1 : raw.count;
    return count === 1 || count === 2 ? { t, id, x, y, button, count } : null;
  }
  if (t === 'wheel') {
    const dx = num(raw.dx, -3000, 3000), dy = num(raw.dy, -3000, 3000);
    return dx === null || dy === null ? null : { t, id, x, y, dx, dy };
  }
  return null;
}

/** 看一眼要不要在"只观看"模式下拒绝：所有输入都拒绝 */
export const inputAllowedIn = (mode: RemoteMode): boolean => mode === 'control';
