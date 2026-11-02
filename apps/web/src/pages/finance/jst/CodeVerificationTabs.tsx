import { ClipboardCheck, RefreshCw, ShieldCheck } from 'lucide-react';
const TABS = [['pending','待验证',ClipboardCheck],['verified','已验证',ShieldCheck],['reverify','二次验证',RefreshCw]] as const;
export function CodeVerificationTabs({value, counts, onChange}: {value: string; counts: Record<string,number>; onChange:(status:string)=>void}) {
  return <div className="code-verification-tabs" role="tablist" aria-label="资料验证状态">{TABS.map(([key,label,Icon])=><button type="button" role="tab" key={key} aria-selected={value===key} onClick={()=>onChange(key)}><Icon size={18}/><span>{label}</span><strong>{counts[key] ?? 0}</strong></button>)}</div>;
}
