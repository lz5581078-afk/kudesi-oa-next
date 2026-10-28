import type { ReactNode } from 'react';
import type { ResourceDef } from '@kudesi/shared';
import type { ResourceDto } from './api';
import { CopyButton } from './CopyValue';
import { statusOf } from './format';
import { KeyFacts } from './KeyFacts';
import { CloseIcon, DownIcon, ExpandIcon, ShrinkIcon, UpIcon } from './ResIcons';
import type { FieldDef } from '@kudesi/shared';

export interface DetailNav { index: number; total: number; onPrev?: () => void; onNext?: () => void }

/**
 * 详情顶部固定头：名称（带复制）、状态、上一条/下一条、主要操作（编辑），次要操作收进“更多”，
 * 下面一排关键事实。滚动正文时这一块不动，随时能切换记录、改状态、关闭。
 */
export function DetailHead(p: {
  def: ResourceDef;
  record: ResourceDto;
  nav?: DetailNav;
  wide: boolean;
  onToggleWide: () => void;
  onClose: () => void;
  statusSlot?: ReactNode;
  primary?: ReactNode;
  more?: ReactNode;
  quick?: ReactNode;
  canSee: (f: FieldDef) => boolean;
}) {
  const { def, record, nav } = p;
  const st = statusOf(def, record.status);
  const code = def.uniqueField && def.uniqueField !== def.titleField && record.data[def.uniqueField] ? String(record.data[def.uniqueField]) : '';
  return (
    <header className="rd-head">
      <div className="rd-line">
        <button type="button" className="rd-back res-btn" onClick={p.onClose}>← 返回列表</button>
        <h2 className="rd-title" title={record.title}>{record.title}</h2>
        <CopyButton value={record.title} label="名称" />
        {p.statusSlot ?? <span className={`pill ${st.tone === 'muted' ? 'warn' : st.tone}`}>{st.label}</span>}
        <span className="rd-gap" />
        {nav && (
          <div className="rd-nav" role="group" aria-label="切换记录">
            <button type="button" className="res-btn icon" aria-label="上一条" title="上一条（↑）" disabled={!nav.onPrev} onClick={nav.onPrev}><UpIcon /></button>
            <button type="button" className="res-btn icon" aria-label="下一条" title="下一条（↓）" disabled={!nav.onNext} onClick={nav.onNext}><DownIcon /></button>
            <span className="rd-pos" aria-label={`第 ${nav.index} 条，共 ${nav.total} 条`}>{nav.index}/{nav.total}</span>
          </div>
        )}
        {p.primary}
        {p.more}
        <button type="button" className="res-btn icon rd-expand" aria-pressed={p.wide} aria-label={p.wide ? '还原宽度' : '展开到全宽'} title={p.wide ? '还原宽度' : '展开到全宽'} onClick={p.onToggleWide}>{p.wide ? <ShrinkIcon /> : <ExpandIcon />}</button>
        <button type="button" className="res-btn icon rd-close" aria-label="关闭详情" title="关闭（Esc）" onClick={p.onClose}><CloseIcon /></button>
      </div>
      <div className="rd-sub">
        <span className="muted">{def.label}</span>
        {code && <span className="rd-code"><span className="mono">{code}</span><CopyButton value={code} label="编码" /></span>}
        {record.statusReason && <span className="muted">原因：{record.statusReason}</span>}
        {record.archived && <span className="rd-archived">已归档{record.archived.reason ? `：${record.archived.reason}` : ''}（{new Date(record.archived.at).toLocaleDateString('zh-CN')}）</span>}
      </div>
      <KeyFacts def={def} record={record} canSee={p.canSee} />
      {p.quick && <div className="rd-quick">{p.quick}</div>}
    </header>
  );
}
