import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api/client';
import { resourceApi, type Relation, type ResourceDto } from './api';

const norm = (v: unknown) => String(v ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
const msg = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/** 适用店铺：按所属执照实时派生，只读（资质证照、税务资料共用）。 */
export function DerivedStoresPanel({ licenseId }: { licenseId: number | null }) {
  const [items, setItems] = useState<ResourceDto[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!licenseId) { setItems([]); return; }
    resourceApi.list('stores', { fieldKey: 'licenseId', fieldValue: licenseId, pageSize: 100, showHidden: true }).then((r) => setItems(r.items)).catch((e) => setError(msg(e, '加载失败')));
  }, [licenseId]);
  return (
    <section>
      <h2 className="section-title">适用店铺{items ? `（${items.length}）` : ''}</h2>
      {error && <div role="alert" className="notice error">{error}</div>}
      {!licenseId && <p className="muted">还没有关联营业执照</p>}
      {items?.length === 0 && licenseId && <p className="muted">这张执照下还没有店铺</p>}
      {items?.map((s) => (
        <div key={s.id} className="line-item between">
          <span>{s.title}<small className="muted"> {String(s.data.storeNo ?? '')} {s.refLabels.operatorUserId ? `· 运营 ${s.refLabels.operatorUserId}` : ''}</small></span>
          <small className="muted">{s.status === 'normal' ? '正常' : s.status === 'abnormal' ? '异常' : '已停用/注销'}</small>
        </div>
      ))}
      <small className="muted">由所属营业执照下的店铺自动列出，不能在这里修改。</small>
    </section>
  );
}

/** 借用记录：登记归还（填归还日期和说明，状态置为已归还；已归还的不能重复登记）。 */
export function ReturnBorrowButton({ id, onDone, onError }: { id: number; onDone: () => void; onError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [day, setDay] = useState(() => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  async function submit() {
    try {
      await resourceApi.changeStatus('license-borrows', id, 'returned');
      await resourceApi.update('license-borrows', id, { returnedAt: day, ...(note.trim() ? { note: note.trim() } : {}) });
      setOpen(false);
      onDone();
    } catch (e) { onError(msg(e, '登记失败')); }
  }
  return (
    <>
      <button type="button" className="link-button" onClick={() => setOpen(true)}>登记归还</button>
      {open && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal card" role="dialog" aria-label="登记归还">
            <div className="modal-head"><strong>登记归还</strong></div>
            <div className="modal-body">
              <label>归还日期<input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></label>
              <label>说明<input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} /></label>
            </div>
            <div className="modal-foot">
              <button type="button" className="secondary-button" onClick={() => setOpen(false)}>取消</button>
              <button type="button" className="primary-button" disabled={!day} onClick={() => void submit()}>确认归还</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** 合作人：法人主体（名下的所有执照，含同名未关联的）和银行卡（可一键建成银行账户并关联）。 */
export function PartnerSubjectPanel({ partner, onChanged }: { partner: ResourceDto; onChanged: () => void }) {
  const [rels, setRels] = useState<Relation[] | null>(null);
  const [same, setSame] = useState<ResourceDto[]>([]);
  const [kind, setKind] = useState('store_personal_card');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const [r, l] = await Promise.all([
        resourceApi.relations('partners', partner.id),
        resourceApi.list('licenses', { keyword: partner.title, pageSize: 50, showHidden: true }).catch(() => ({ items: [] as ResourceDto[] })),
      ]);
      setRels(r);
      setSame(l.items.filter((x) => norm(x.data.legalPerson) === norm(partner.title)));
      setError('');
    } catch (e) { setError(msg(e, '加载失败')); }
  }, [partner.id, partner.title]);
  useEffect(() => { void load(); }, [load]);

  const own = typeof partner.data.licenseId === 'number' ? (partner.data.licenseId as number) : 0;
  const linkedLicenses = (rels ?? []).filter((r) => r.type === 'licenses');
  const linkedIds = new Set([own, ...linkedLicenses.map((r) => r.id)].filter(Boolean));
  const unlinked = same.filter((l) => !linkedIds.has(l.id));
  const banks = (rels ?? []).filter((r) => r.type === 'bank-accounts');
  const cardNo = String(partner.data.cardNo ?? '');

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try { await fn(); await load(); onChanged(); } catch (e) { setError(msg(e, '操作失败')); }
    setBusy(false);
  }
  return (
    <section>
      <h2 className="section-title">法人主体</h2>
      {error && <div role="alert" className="notice error">{error}</div>}
      {rels === null && <p className="muted">加载中…</p>}
      {rels && [...new Map(linkedLicenses.map((r) => [r.id, r])).values()].length === 0 && !own && <p className="muted">还没有关联营业执照</p>}
      {own > 0 && <div className="line-item between"><span>{partner.refLabels.licenseId ?? `执照 #${own}`}</span><small className="muted">所属执照</small></div>}
      {linkedLicenses.map((r) => {
        const lic = same.find((l) => l.id === r.id);
        return (
          <div key={`${r.id}-${r.linkId ?? ''}`} className="line-item between">
            <span>{r.title}{lic === undefined && <small className="bad-text"> 执照法人与合作人名称不一致</small>}</span>
            <small className="muted">已关联</small>
          </div>
        );
      })}
      {unlinked.map((l) => (
        <div key={l.id} className="line-item between">
          <span>{l.title}<small className="muted"> 法人同名，尚未关联</small></span>
          <button type="button" className="link-button" disabled={busy} onClick={() => void run(() => (own ? resourceApi.addLink('partners', partner.id, 'licenses', l.id) : resourceApi.update('partners', partner.id, { licenseId: l.id })))}>关联为法人</button>
        </div>
      ))}
      <h2 className="section-title">银行账户</h2>
      {banks.length === 0 && <p className="muted">没有关联银行账户</p>}
      {banks.map((b) => <div key={b.id} className="line-item"><span>{b.title}</span></div>)}
      {cardNo && banks.length === 0 && (
        <div className="toolbar">
          <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="账户类型">
            <option value="store_personal_card">店铺个人银行卡</option>
            <option value="company_card">公司银行卡</option>
          </select>
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void run(async () => {
            const acc = await resourceApi.create('bank-accounts', {
              kind, accountName: String(partner.data.cardHolder || partner.title), bank: String(partner.data.cardBank || '待补充'), accountNo: cardNo, ownerName: partner.title,
              reservedPhoneNumber: partner.data.cardPhone || undefined, phoneId: partner.data.cardPhoneId || undefined, ...(own ? { licenseId: own } : {}),
            });
            await resourceApi.addLink('partners', partner.id, 'bank-accounts', acc.id);
          })}>把登记的银行卡建成银行账户并关联</button>
        </div>
      )}
    </section>
  );
}

/** 预留手机号还没有手机号档案时，一键建档并绑定（银行账户、合作人通用）。 */
export function PhoneArchiveButton({ type, record, numberKey, idKey, holder, onDone, onError }: {
  type: string; record: ResourceDto; numberKey: string; idKey: string; holder: string; onDone: () => void; onError: (m: string) => void;
}) {
  const number = String(record.data[numberKey] ?? '');
  if (!number || record.data[idKey]) return null;
  return (
    <button type="button" className="link-button" onClick={async () => {
      try {
        const phone = await resourceApi.create('phones', { number, usageType: 'external_used', externalUser: holder || undefined });
        await resourceApi.update(type, record.id, { [idKey]: phone.id });
        onDone();
      } catch (e) { onError(msg(e, '建档失败')); }
    }}>{number} 还没有手机号档案，一键建档并绑定</button>
  );
}
