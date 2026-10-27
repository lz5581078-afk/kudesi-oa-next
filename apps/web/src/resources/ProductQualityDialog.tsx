import { useEffect, useId, useState } from 'react';
import { resourceApi } from './api';
import { unitYuanText } from '@kudesi/shared';

/** 采购价、运费、装卸费明确填 0 时，旧系统要求“核算资料确认”：逐项选或写原因。这里的原因就是商品档案的“零值说明”。 */
export const ZERO_ITEMS = [
  { key: 'purchasePrice', label: '采购价' },
  { key: 'freight', label: '运费' },
  { key: 'handlingFee', label: '装卸费' },
] as const;

const lineLabel = (line: string) => line.split(/[：:]/)[0].trim();
const lineReason = (line: string) => line.replace(/^[^：:]*[：:]?/, '').trim();

/** 取“零值说明”里每一项已写的原因 */
export function parseZeroReasons(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const label = lineLabel(line);
    if (ZERO_ITEMS.some((z) => z.label === label)) out[label] = lineReason(line);
  }
  return out;
}

/** 填 0 且还没写原因的项目 */
export function zeroItemsMissingReason(body: Record<string, unknown>): Array<{ key: string; label: string }> {
  const have = parseZeroReasons(String(body.zeroValueReason ?? ''));
  return ZERO_ITEMS.filter((z) => body[z.key] === 0 && !have[z.label]);
}

/** 把确认的原因写回“零值说明”：该项一行，其它行原样保留 */
export function mergeZeroReasons(text: string, reasons: Record<string, string>): string {
  const keep = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !Object.keys(reasons).includes(lineLabel(l)));
  return [...Object.entries(reasons).map(([label, reason]) => `${label}：${reason.trim()}`), ...keep].join('\n');
}

export function ProductQualityDialog({ body, missing, onCancel, onConfirm }: {
  body: Record<string, unknown>;
  missing: Array<{ key: string; label: string }>;
  onCancel: () => void;
  onConfirm: (reasons: Record<string, string>) => void;
}) {
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [library, setLibrary] = useState<string[]>([]);
  const listId = useId();
  useEffect(() => {
    let alive = true;
    resourceApi.list('finance-zero-reasons', { page: 1, pageSize: 200 }).then((r) => alive && setLibrary(r.items.map((i) => i.title))).catch(() => undefined);
    return () => { alive = false; };
  }, []);
  const money = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? `${unitYuanText(v)} 元` : '未填写');
  const done = missing.every((m) => (reasons[m.label] ?? '').trim());
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal card small" role="dialog" aria-modal="true" aria-label="核算资料确认">
        <div className="modal-head between"><strong>核算资料确认</strong><button type="button" className="icon-button" aria-label="返回修改" onClick={onCancel}>✕</button></div>
        <div className="modal-body">
          <p className="muted">{String(body.name ?? '')}</p>
          <ul className="plain-list">
            <li className="between"><span>采购价</span><span>{money(body.purchasePrice)}</span></li>
            <li className="between"><span>运费</span><span>{money(body.freight)}</span></li>
            <li className="between"><span>装卸费</span><span>{money(body.handlingFee)}</span></li>
          </ul>
          <p>下面这些项目填了 0，请逐项选择或写明原因：</p>
          <datalist id={listId}>{library.map((r) => <option key={r} value={r} />)}</datalist>
          {missing.map((m) => (
            <label key={m.key}>{m.label}为 0 的原因
              <input list={listId} maxLength={180} placeholder="选择或输入原因" aria-label={`${m.label}零值原因`} value={reasons[m.label] ?? ''} onChange={(e) => setReasons({ ...reasons, [m.label]: e.target.value })} />
            </label>
          ))}
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={onCancel}>返回修改</button>
          <button type="button" className="primary-button" disabled={!done} onClick={() => onConfirm(Object.fromEntries(missing.map((m) => [m.label, (reasons[m.label] ?? '').trim()])))}>确认并保存</button>
        </div>
      </div>
    </div>
  );
}
