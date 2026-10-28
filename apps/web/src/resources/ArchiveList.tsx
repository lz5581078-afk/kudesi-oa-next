import { useMemo, useState } from 'react';
import { getResourceDef } from '@kudesi/shared';
import { ArchiveStatusButtons } from './RowActions';
import type { ArchiveRow } from './locationModel';

const def = getResourceDef('archives');
const tone = (s: string) => def?.statuses.find((x) => x.value === s)?.tone ?? 'muted';
const label = (s: string) => def?.statuses.find((x) => x.value === s)?.label ?? s;

/**
 * 档案列表：编号、名称、类型、存放位置、保管人、状态，可以搜索（多个词用空格隔开），每行可改在库/借出/遗失。
 * 位置显示成相对路径（从当前位置往下），一眼看到在哪个柜子哪一层。
 */
export function ArchiveList({ rows, where, canStatus, onOpen, onChanged, empty, searchable = true }: {
  rows: ArchiveRow[];
  where: (a: ArchiveRow) => string;
  canStatus: boolean;
  onOpen: (id: number) => void;
  onChanged: (message?: string) => void;
  empty: string;
  searchable?: boolean;
}) {
  const [kw, setKw] = useState('');
  const shown = useMemo(() => {
    const words = kw.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return rows;
    return rows.filter((a) => { const text = `${a.archiveNo} ${a.title} ${a.archiveType} ${a.relatedLabel} ${a.keeperLabel} ${where(a)}`.toLowerCase(); return words.every((w) => text.includes(w)); });
  }, [rows, kw, where]);
  return (
    <div className="lb-archives">
      {searchable && rows.length > 0 && (
        <input type="search" className="lb-search" aria-label="搜索档案" placeholder="搜索档案编号、名称、类型、位置、保管人" value={kw} onChange={(e) => setKw(e.target.value)} />
      )}
      {shown.length === 0 ? <p className="muted lb-empty">{rows.length ? '没有符合搜索词的档案' : empty}</p> : (
        <div className="lb-table-wrap">
          <table className="lb-table">
            <thead><tr><th>档案</th><th>类型</th><th>存放位置</th><th>关联</th><th>保管人</th><th>状态</th>{canStatus && <th>办理</th>}</tr></thead>
            <tbody>
              {shown.map((a) => (
                <tr key={a.id} tabIndex={0} onClick={() => onOpen(a.id)} onKeyDown={(e) => { if (e.target === e.currentTarget && e.key === 'Enter') onOpen(a.id); }}>
                  <td data-label="档案"><strong>{a.title}</strong>{a.archiveNo && <small className="muted"> {a.archiveNo}</small>}</td>
                  <td data-label="类型">{a.archiveType || '—'}</td>
                  <td data-label="存放位置">{where(a) || '未设置'}</td>
                  <td data-label="关联">{a.relatedLabel || '—'}</td>
                  <td data-label="保管人">{a.keeperLabel || '—'}</td>
                  <td data-label="状态"><span className={`pill ${tone(a.status) === 'muted' ? 'warn' : tone(a.status)}`}>{label(a.status)}</span></td>
                  {canStatus && <td data-label="办理"><ArchiveStatusButtons row={a} onDone={onChanged} /></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
