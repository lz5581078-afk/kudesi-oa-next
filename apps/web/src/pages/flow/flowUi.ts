/** 流程/任务页面共用的小工具：到期提示、记住上次选择、剪贴板。 */

/** 距截止的人话提示：已超时 3 小时 / 2 天后截止。没有截止时间返回“不限时”。 */
export function dueHint(dueAt: string | null | undefined, now: number = Date.now()): { text: string; late: boolean } {
  if (!dueAt) return { text: '不限时', late: false };
  const due = new Date(dueAt).getTime();
  if (Number.isNaN(due)) return { text: '不限时', late: false };
  const diff = due - now;
  const abs = Math.abs(diff);
  const hours = Math.round(abs / 3_600_000);
  const span = abs < 3_600_000 ? `${Math.max(1, Math.round(abs / 60_000))} 分钟` : hours < 48 ? `${hours} 小时` : `${Math.floor(hours / 24)} 天`;
  return diff < 0 ? { text: `已超时 ${span}`, late: true } : { text: `${span}后截止`, late: false };
}

/** 停留了多久：用于流程总览的“当前步骤停留”。 */
export function dwell(since: string | null | undefined, now: number = Date.now()): string {
  if (!since) return '';
  const t = new Date(since).getTime();
  if (Number.isNaN(t) || t > now) return '';
  const min = Math.floor((now - t) / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} 小时`;
  return `${Math.floor(h / 24)} 天`;
}

/** 浏览器存储可能被禁用：读写都不抛错。只用于“记住上次选的筛选”这类个人便利。 */
export const remember = {
  get(key: string, fallback: string): string {
    try { return window.localStorage.getItem(key) || fallback; } catch { return fallback; }
  },
  set(key: string, value: string) {
    try { window.localStorage.setItem(key, value); } catch { /* 存储不可用就不记 */ }
  },
};

/** 复制文字：统一用资源模块的实现（含非 https 退回办法）。 */
export { copyText } from '../../resources/CopyValue';

/** 防抖：输入框停手 delay 毫秒后才触发。 */
import { useEffect, useState } from 'react';
export function useDebounced<T>(value: T, delay = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), delay); return () => clearTimeout(t); }, [value, delay]);
  return v;
}
