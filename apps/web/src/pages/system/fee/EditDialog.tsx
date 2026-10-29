import { useState } from 'react';
import { todayShanghai, type LedgerBroadbandRow, type LedgerPhoneRow } from '@kudesi/shared';
import { CascadePicker } from '../../../resources/CascadePicker';
import { SearchPick } from '../../finance/common';
import { buildBroadbandChanges, buildPhoneChanges, broadbandFormOf, phoneFormOf, type Built, type Change, type UseMap } from './batch';
import { MainCardPick } from './pickers';

type Props =
  | { kind: 'phones'; rows: LedgerPhoneRow[]; onClose: () => void; onSave: (changes: Change[]) => Promise<void>; canSeeFees: boolean }
  | { kind: 'broadband'; rows: LedgerBroadbandRow[]; onClose: () => void; onSave: (changes: Change[]) => Promise<void>; canSeeFees: boolean };

/**
 * 修改一条或批量修改：单条时所有项都预填、直接保存；批量时只写勾了“改这一项”的项，保存前先看预览。
 * 写入由页面统一走资料保存通道。
 */
export function EditDialog(p: Props) {
  const batch = p.rows.length > 1;
  const first = p.rows[0];
  const [phone, setPhone] = useState(() => phoneFormOf(p.kind === 'phones' ? (batch ? undefined : (first as LedgerPhoneRow)) : undefined));
  const [bb, setBb] = useState(() => broadbandFormOf(p.kind === 'broadband' && !batch ? (first as LedgerBroadbandRow) : undefined));
  const [use, setUse] = useState<UseMap>((): UseMap => (batch ? {} as UseMap : { carrier: true, plan: true, fee: p.canSeeFees, feeCycle: true, cycleDays: true, parent: true, cycle: true, expiresAt: true, locationId: true, phoneId: true }));
  const [preview, setPreview] = useState<Change[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const today = todayShanghai();

  const build = (): Built => (p.kind === 'phones' ? buildPhoneChanges(p.rows, phone, use, today, { single: !batch }) : buildBroadbandChanges(p.rows, bb, use));
  async function run(changes: Change[]) {
    setBusy(true);
    try { await p.onSave(changes); } finally { setBusy(false); }
  }
  async function submit() {
    setError('');
    const r = build();
    if ('error' in r) return setError(r.error);
    if (batch) return setPreview(r.changes);
    await run(r.changes);
  }
  const title = p.kind === 'phones'
    ? (batch ? `批量修改 ${p.rows.length} 张号码` : `修改 ${(first as LedgerPhoneRow).number}`)
    : (batch ? `批量修改 ${p.rows.length} 条宽带` : `修改宽带 ${(first as LedgerBroadbandRow).account}`);

  const field = (key: string, label: string, node: React.ReactNode) => (
    <div className={batch && !use[key] ? 'fee-field off' : 'fee-field'}>
      {batch ? <label className="check-line"><input type="checkbox" checked={Boolean(use[key])} onChange={(e) => setUse({ ...use, [key]: e.target.checked })} />改{label}</label> : <span className="fee-field-label">{label}</span>}
      {node}
    </div>
  );

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="card modal" role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head"><h2 style={{ margin: 0, fontSize: 16 }}>{title}</h2></header>
        <div className="modal-body">
          {error && <div role="alert" className="notice error">{error}</div>}
          {preview ? (
            <div role="region" aria-label="修改预览">
              <p style={{ margin: '0 0 8px' }}><strong>将修改 {preview.length} 条，请确认：</strong></p>
              <ul className="fee-preview">{preview.map((c) => <li key={c.id}><strong>{c.title}</strong><span>{c.lines.join('；')}</span></li>)}</ul>
              <p className="muted" style={{ margin: '8px 0 0' }}>保存后直接写回{p.kind === 'phones' ? '手机号' : '宽带账号'}档案，并在各自档案的操作记录里留痕。</p>
            </div>
          ) : p.kind === 'phones' ? (
            <div className="fee-form">
              {field('carrier', '运营商', <input aria-label="运营商" value={phone.carrier} onChange={(e) => setPhone({ ...phone, carrier: e.target.value })} />)}
              {field('plan', '套餐', <input aria-label="套餐" value={phone.plan} onChange={(e) => setPhone({ ...phone, plan: e.target.value })} />)}
              {p.canSeeFees && field('fee', '费用（元）', <input aria-label="费用（元）" inputMode="decimal" value={phone.fee} onChange={(e) => setPhone({ ...phone, fee: e.target.value })} />)}
              {field('feeCycle', '费用周期', (
                <select aria-label="费用周期" value={phone.feeCycle} onChange={(e) => setPhone({ ...phone, feeCycle: e.target.value })}>
                  <option value="monthly">月付</option><option value="quarterly">季付</option><option value="yearly">年付</option>
                </select>
              ))}
              {field('cycleDays', '充值周期（天）', <input aria-label="充值周期（天）" placeholder="默认 30" type="number" min={1} max={3650} value={phone.cycleDays} onChange={(e) => setPhone({ ...phone, cycleDays: e.target.value })} />)}
              {field('parent', '主卡', <MainCardPick value={phone.parentId} label={phone.parentLabel} excludeId={batch ? undefined : (first as LedgerPhoneRow).id} onChange={(id, label) => setPhone({ ...phone, parentId: id, parentLabel: label })} />)}
              {batch && (
                <div className="fee-field">
                  <label className="check-line"><input type="checkbox" checked={Boolean(use.recharge)} onChange={(e) => setUse({ ...use, recharge: e.target.checked })} />记录今天已充值（最后充值日 = 今天，下次充值日按周期推算）</label>
                </div>
              )}
              <p className="muted fee-hint">主卡留空 = 设为主卡。主子卡只有两级：子卡不能再有子卡，选主卡时只列主卡。</p>
            </div>
          ) : (
            <div className="fee-form">
              {p.canSeeFees && field('fee', '套餐金额（元）', <input aria-label="套餐金额（元）" inputMode="decimal" value={bb.fee} onChange={(e) => setBb({ ...bb, fee: e.target.value })} />)}
              {field('cycle', '套餐周期', (
                <select aria-label="套餐周期" value={bb.cycle} onChange={(e) => setBb({ ...bb, cycle: e.target.value })}><option value="monthly">月付</option><option value="yearly">年付</option></select>
              ))}
              {field('expiresAt', '到期日', <input aria-label="到期日" type="date" value={bb.expiresAt} onChange={(e) => setBb({ ...bb, expiresAt: e.target.value })} />)}
              {field('phoneId', '绑定手机号', <SearchPick type="phones" value={bb.phoneId} label={bb.phoneLabel} ariaLabel="绑定手机号" placeholder="输入号码搜索（必须绑定）" onChange={(id, label) => setBb({ ...bb, phoneId: id, phoneLabel: label })} />)}
              {field('locationId', '使用区域', <CascadePicker target="locations" label="使用区域" value={bb.locationId} onChange={(v) => setBb({ ...bb, locationId: v })} labelNow={!batch ? (first as LedgerBroadbandRow).location ?? '' : ''} />)}
            </div>
          )}
        </div>
        <footer className="modal-foot">
          {preview ? (
            <>
              <button type="button" className="secondary-button" onClick={() => setPreview(null)}>返回修改</button>
              <button type="button" className="primary-button" disabled={busy} onClick={() => void run(preview)}>{busy ? '保存中…' : '确认保存'}</button>
            </>
          ) : (
            <>
              <button type="button" className="secondary-button" onClick={p.onClose}>取消</button>
              <button type="button" className="primary-button" disabled={busy} onClick={() => void submit()}>{batch ? '预览修改' : busy ? '保存中…' : '保存'}</button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
