import { ArrowLeft } from 'lucide-react';
/** 分级布局进入某个顶级分类后的页头：返回上一级 + 顶级分类名 + 说明（旧版“返回上一级”） */
export function HierBar({ title, subtitle, onBack, showBack = true }: { showBack?:boolean; title: string; subtitle: string; onBack: () => void }) {
  return (
    <header className="hier-bar">
      {showBack && <button type="button" className="res-btn" onClick={onBack} aria-label="返回上一级"><ArrowLeft size={16} /><span>返回上一级</span></button>}
      <div className="hier-bar-text">
        <h2>{title}</h2>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
    </header>
  );
}
