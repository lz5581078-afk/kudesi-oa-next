import { useEffect, useRef, useState } from 'react';
import type { FieldDef, ResourceDef } from '@kudesi/shared';

/** 复制到剪贴板：先用浏览器接口，不可用（非 https、权限被拒）时退回选中复制。成功返回 true。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 下面用备用办法 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** 值后面的“复制”小按钮：点了变成“已复制”，1.5 秒后恢复；失败时提示手动复制。不触发所在行/卡片的点击。 */
export function CopyButton({ value, label, className }: { value: string; label: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!value) return null;
  return (
    <button
      type="button"
      className={`link-button copy-btn${className ? ` ${className}` : ''}`}
      aria-label={`复制${label}`}
      onKeyDown={(e) => e.stopPropagation()}
      title={state === 'fail' ? '浏览器不允许复制，请手动选中后复制' : `复制${label}`}
      onClick={(e) => {
        e.stopPropagation();
        void copyText(value).then((ok) => {
          setState(ok ? 'ok' : 'fail');
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setState('idle'), 1500);
        });
      }}
    >
      {state === 'ok' ? '已复制' : state === 'fail' ? '复制失败' : '复制'}
    </button>
  );
}

const COPY_KEY = /(No|Id|Phone|Account|Code|Number|Url)$/;
const COPY_TYPES = new Set(['text', 'phone', 'sensitive', 'number']);

/** 哪些字段值得一键复制：证件号/银行卡（sensitive）、手机号、公司内唯一的编号，以及编号/账号/网址一类的文本字段。 */
export function isCopyable(def: ResourceDef, f: FieldDef): boolean {
  if (!COPY_TYPES.has(f.type)) return false;
  if (f.type === 'sensitive' || f.type === 'phone') return true;
  return f.key === def.uniqueField || COPY_KEY.test(f.key) || f.key === 'account' || f.key === 'loginName';
}

/** 主页链接、登录地址一类的网址字段：详情里做成可点的链接（旧系统自媒体、账号备忘的主页/登录地址可直接打开）。 */
export function urlOf(f: FieldDef, value: string): string | null {
  if (!/^(homepage|url)$/.test(f.key)) return null;
  const v = value.trim();
  if (!v) return null;
  return /^https?:\/\//i.test(v) ? v : /^[\w-]+(\.[\w-]+)+/.test(v) ? `https://${v}` : null;
}
