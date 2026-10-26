/**
 * 远程输入的校验。规则和 packages/shared/src/remote-assist.ts 里的 parseRemoteInput 完全一致
 * （助手是独立打包的，不依赖 shared；两边的测试读同一份用例 packages/shared/src/remote-input.cases.json）。
 * 助手对服务器和网页发来的东西一律重新校验，不信任。
 */
export type MouseButton = 'left' | 'right' | 'middle';
export type RemoteInput =
  | { t: 'move'; id: string; x: number; y: number }
  | { t: 'down' | 'up'; id: string; x: number; y: number; button: MouseButton }
  | { t: 'click'; id: string; x: number; y: number; button: MouseButton; count: 1 | 2 }
  | { t: 'wheel'; id: string; x: number; y: number; dx: number; dy: number }
  | { t: 'key'; id: string; key: string; mods: number }
  | { t: 'text'; id: string; text: string };

export const NAMED_KEYS = [
  'Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown', 'Space',
] as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, lo: number, hi: number): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);

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

/** 键盘修饰位（alt=1 ctrl=2 meta=4 shift=8）转成 Playwright 的按键写法，如 Control+Shift+a */
export function keyCombo(key: string, mods: number): string {
  const parts: string[] = [];
  if (mods & 2) parts.push('Control');
  if (mods & 1) parts.push('Alt');
  if (mods & 4) parts.push('Meta');
  if (mods & 8) parts.push('Shift');
  parts.push(key === 'Space' ? ' ' : key);
  return parts.join('+');
}
