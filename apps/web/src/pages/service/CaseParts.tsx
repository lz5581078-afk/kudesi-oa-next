import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { CASE_STAGE_LABEL, CASE_STAGE_TONE, dueState, type CaseStage } from '@kudesi/shared';
import { ApiError } from '../../api/client';
import { RunDetail } from '../flow/RunDetail';
import { flowApi, fmtTime, type RunDetailDto } from '../flow/flowApi';
import type { FileInfo, LogRow } from './serviceApi';

/** 让“剩余时间”随时间走：每 30 秒重算一次。 */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

export const errText = (e: unknown, fallback = '操作失败') => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : fallback);

export function StageTag({ stage, returned }: { stage: CaseStage; returned?: boolean }) {
  return (
    <span className="pill-row">
      <span className={`pill ${CASE_STAGE_TONE[stage] === 'muted' ? '' : CASE_STAGE_TONE[stage]}`}>{CASE_STAGE_LABEL[stage]}</span>
      {returned && <span className="pill bad">被退回</span>}
    </span>
  );
}

/** 剩余时间：超时标红、6 小时内标橙；鼠标悬停看具体截止时间。 */
export function DueText({ dueAt, open, now }: { dueAt: string | null; open: boolean; now: number }) {
  const s = dueState(dueAt, open, now);
  return <span className={`svc-due is-${s.tone}`} title={dueAt ? `截止 ${fmtTime(dueAt)}` : ''}>{s.text}</span>;
}

const sizeText = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function Thumb({ file, urlOf, onRemove }: { file: FileInfo; urlOf: (id: number) => Promise<{ url: string }>; onRemove?: () => void }) {
  const isImage = file.mime.startsWith('image/');
  const [src, setSrc] = useState<string | null>(null);
  const [zoom, setZoom] = useState(false);
  const [bad, setBad] = useState(false);
  useEffect(() => {
    if (!isImage) return;
    let alive = true;
    urlOf(file.id).then((r) => alive && setSrc(r.url)).catch(() => alive && setBad(true));
    return () => { alive = false; };
  }, [file.id, isImage, urlOf]);
  async function open() {
    if (isImage && src) { setZoom(true); return; }
    try { window.open((await urlOf(file.id)).url, '_blank', 'noopener'); } catch { setBad(true); }
  }
  return (
    <div className="file-thumb">
      <button type="button" className="file-open" onClick={() => void open()} title={`${file.name}（${sizeText(file.size)}）`}>
        {isImage && src ? <img src={src} alt={file.name} loading="lazy" /> : <span className="file-icon">{bad ? '无法加载' : isImage ? '…' : 'PDF'}</span>}
      </button>
      <span className="file-name">{file.name}</span>
      {onRemove && <button type="button" className="icon-button file-remove" aria-label={`移除 ${file.name}`} onClick={onRemove}>✕</button>}
      {zoom && src && (
        <div className="modal-backdrop" role="presentation" onClick={() => setZoom(false)}>
          <div className="modal card image-zoom" role="dialog" aria-label={`查看图片 ${file.name}`} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') setZoom(false); }}>
            <div className="modal-head between"><strong>{file.name}</strong>
              <span className="pill-row"><a className="secondary-button" href={src} download={file.name} target="_blank" rel="noopener noreferrer">另存为</a><button type="button" className="secondary-button" autoFocus onClick={() => setZoom(false)}>关闭</button></span>
            </div>
            <div className="modal-body"><img src={src} alt={file.name} style={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain' }} /></div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 凭证/附件：选文件、拖进来、或直接 Ctrl+V 粘贴截图都能上传（旧系统“粘贴截图”的习惯）。
 * 一次选多张按顺序上传，某一张失败会停下并说明是哪一张。
 */
export function CaseFiles({ files, editable, max = 20, onAdd, onRemove, urlOf, title = '附件', hint }: {
  files: FileInfo[]; editable: boolean; max?: number; onAdd: (f: File) => Promise<unknown>; onRemove: (id: number) => Promise<unknown>; urlOf: (id: number) => Promise<{ url: string }>; title?: string; hint?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [over, setOver] = useState(false);
  const stableUrl = useCallback(urlOf, []); // eslint-disable-line react-hooks/exhaustive-deps
  const filesRef = useRef(files);
  filesRef.current = files;

  const add = useCallback(async (list: File[]) => {
    if (!list.length) return;
    setBusy(true); setError('');
    let count = filesRef.current.length;
    for (const f of list) {
      if (count >= max) { setError(`最多 ${max} 个文件`); break; }
      try { await onAdd(f); count += 1; } catch (e) { setError(`${f.name || '截图'}：${errText(e, '上传失败')}`); break; }
    }
    setBusy(false);
    if (input.current) input.current.value = '';
  }, [max, onAdd]);

  useEffect(() => {
    if (!editable) return undefined;
    const h = (e: ClipboardEvent) => {
      const imgs = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
      if (imgs.length) { e.preventDefault(); void add(imgs); }
    };
    document.addEventListener('paste', h);
    return () => document.removeEventListener('paste', h);
  }, [editable, add]);

  return (
    <section className={`svc-files${over ? ' is-over' : ''}`}
      onDragOver={editable ? (e) => { e.preventDefault(); setOver(true); } : undefined} onDragLeave={() => setOver(false)}
      onDrop={editable ? (e) => { e.preventDefault(); setOver(false); void add([...e.dataTransfer.files]); } : undefined}>
      <h3 className="section-title">{title}（{files.length}）</h3>
      {files.length === 0 && <p className="muted">{editable ? (hint ?? '还没有文件。可以点“上传”选择、把图片拖进来，或直接 Ctrl+V 粘贴截图。') : '没有文件'}</p>}
      <div className="file-grid">
        {files.map((f) => <Thumb key={f.id} file={f} urlOf={stableUrl} onRemove={editable ? () => { setError(''); onRemove(f.id).catch((e) => setError(errText(e))); } : undefined} />)}
      </div>
      {editable && (
        <div className="row-actions">
          <button type="button" className="secondary-button small" disabled={busy || files.length >= max} onClick={() => input.current?.click()}>{busy ? '上传中…' : '上传图片/PDF'}</button>
          <span className="muted">可拖入或粘贴截图，每个不超过 10MB，最多 {max} 个</span>
          <input ref={input} type="file" accept="image/*,application/pdf" multiple hidden aria-label="选择文件" onChange={(e) => void add([...(e.target.files ?? [])])} />
        </div>
      )}
      {error && <div role="alert" className="notice error">{error}</div>}
    </section>
  );
}

/** 跟进记录：写一条、催办（给当前办理人发站内通知）、时间倒序。 */
export function FollowUps({ logs, canWrite, canUrge, onAdd }: { logs: LogRow[]; canWrite: boolean; canUrge: boolean; onAdd: (content: string, kind: 'note' | 'urge') => Promise<unknown> }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function go(kind: 'note' | 'urge') {
    if (!text.trim() && kind === 'note') { setError('先写点跟进内容'); return; }
    setBusy(true); setError('');
    try { await onAdd(text.trim() || '请尽快处理', kind); setText(''); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }
  return (
    <section>
      <h3 className="section-title">跟进记录（{logs.length}）</h3>
      {canWrite && (
        <div className="svc-follow">
          <textarea rows={2} maxLength={1000} aria-label="跟进内容" placeholder="写一条跟进，例如：已电话联系买家，约定明天寄回" value={text} onChange={(e) => setText(e.target.value)} />
          <div className="row-actions">
            <button type="button" className="secondary-button small" disabled={busy} onClick={() => void go('note')}>记录跟进</button>
            {canUrge && <button type="button" className="secondary-button small" disabled={busy} title="给当前办理人发一条站内通知" onClick={() => void go('urge')}>催办</button>}
          </div>
        </div>
      )}
      {error && <div role="alert" className="notice error">{error}</div>}
      <ul className="event-list">
        {logs.length === 0 && <li className="muted">还没有记录</li>}
        {logs.map((l) => (
          <li key={l.id} className="log-item">
            <strong>{l.userName || '系统'}</strong>{l.kind === 'urge' && <span className="pill warn">催办</span>} · <span className="muted">{fmtTime(l.createdAt)}</span>
            <div>{l.content}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 流程进度和“去办理”入口：办理本身在统一的流程详情里做（审批、退回、转交等都和其他流程一样）。 */
export function FlowStrip({ runId, refreshKey, onChanged }: { runId: number; refreshKey: number; onChanged: () => void }) {
  const [run, setRun] = useState<RunDetailDto | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { flowApi.run(runId).then((r) => { setRun(r); setError(''); }).catch((e) => setError(errText(e, '流程进度加载失败'))); }, [runId, refreshKey]);
  const mine = !!run && (run.me.canPass || run.me.canResubmit);
  return (
    <section>
      <h3 className="section-title">办理进度</h3>
      {error && <div role="alert" className="notice error">{error}</div>}
      {run && (
        <>
          <ol className="step-progress" aria-label="办理进度">
            {run.steps.map((s) => <li key={s.id} className={s.status === 'active' ? 'active' : s.status === 'done' || s.status === 'transferred' ? 'done' : 'bad'}>{s.name}</li>)}
          </ol>
          {run.activeStep && <p className="muted">现在：{run.activeStep.name} · 办理人 {run.activeStep.recipients.map((r) => r.name).join('、')}{run.activeStep.dueAt ? ` · 截止 ${fmtTime(run.activeStep.dueAt)}` : ''}</p>}
        </>
      )}
      <div className="row-actions">
        <button type="button" className={mine ? 'primary-button' : 'secondary-button small'} onClick={() => setOpen(true)}>{mine ? '去办理' : '查看办理记录 / 操作'}</button>
      </div>
      {open && <RunDetail id={runId} onClose={() => setOpen(false)} onChanged={onChanged} />}
    </section>
  );
}

/** 详情弹窗外壳：标题区 + 内容 + Esc 关闭。 */
export function DetailModal({ title, sub, tags, onClose, onRefresh, refreshing, children, label }: { title: ReactNode; sub?: ReactNode; tags?: ReactNode; onClose: () => void; onRefresh: () => void; refreshing: boolean; children: ReactNode; label: string }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.modal-backdrop ~ .modal-backdrop')) onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal card" role="dialog" aria-label={label} style={{ width: 'min(900px, 100%)' }}>
        <div className="modal-head between">
          <div><strong>{title}</strong> {tags}{sub && <div className="muted">{sub}</div>}</div>
          <div className="row-actions">
            <button type="button" className="secondary-button small" disabled={refreshing} onClick={onRefresh}>刷新</button>
            <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>✕</button>
          </div>
        </div>
        <div className="modal-body">{children}</div>
        <div className="modal-foot"><button type="button" className="secondary-button" onClick={onClose}>关闭</button></div>
      </div>
    </div>
  );
}
