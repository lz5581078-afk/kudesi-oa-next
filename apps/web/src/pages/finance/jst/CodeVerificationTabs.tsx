import { useRef } from 'react';
import { ClipboardCheck, RefreshCw, ShieldCheck } from 'lucide-react';
import './codeVerificationTabs.css';
const TABS = [['pending', '待验证', ClipboardCheck], ['verified', '已验证', ShieldCheck], ['reverify', '二次验证', RefreshCw]] as const;
export function CodeVerificationTabs({ value, counts, onChange, scope = 'base' }: { value: string; counts: Record<string, number> | null; onChange: (value: string) => void; scope?: 'base' | 'bundle' }) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  return <nav className={`code-verification-tabs ${scope}`} role="tablist" aria-label={scope === 'base' ? '资料验证状态' : '组合验证状态'}>{TABS.map(([state, label, Icon], index) => <button key={state} data-status={state} ref={node => { buttons.current[index] = node; }} id={`${scope}-verification-tab-${state}`} type="button" role="tab" aria-selected={value === state} aria-controls={`${scope}-verification-workspace`} tabIndex={value === state ? 0 : -1} onClick={() => onChange(state)} onKeyDown={event => {
    const target = event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : -1;
    if (target < 0) return;
    event.preventDefault(); onChange(TABS[target][0]); buttons.current[target]?.focus();
  }}><Icon size={scope === 'base' ? 22 : 18}/><span>{label}</span><b>{counts ? counts[state] ?? 0 : '—'}</b></button>)}</nav>;
}
