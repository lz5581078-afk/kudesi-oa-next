import { useEffect, useState } from 'react';
import { ALLOCATION_LABEL, EXCEPTION_LABEL, FEE_TYPE_LABEL, PAYMENT_MODE_LABEL, PURCHASE_STEP_GUIDE } from '@kudesi/shared';
import { ApiError } from '../../api/client';
import { EvidenceInput } from './PurchaseFields';
import { centsToYuan, money, purchaseApi, yuanToCents, type PurchaseOptions, type PurchaseViewDto } from './purchaseApi';

type Data = Record<string, unknown>;
interface P { runId: number; state: PurchaseViewDto; options: PurchaseOptions | null; data: Data; set: (d: Data) => void }
const name = (s: PurchaseViewDto, id: number) => s.lines.find((l) => l.productId === id)?.name ?? `商品 #${id}`;
const unit = (s: PurchaseViewDto, id: number) => s.lines.find((l) => l.productId === id)?.unit ?? '';
const last = (s: PurchaseViewDto) => s.batches[s.batches.length - 1];
const num = (v: unknown) => (v === '' || v === undefined ? NaN : Number(v));

/** 每个商品一行的数量表（发货、收货、质检用） */
function QtyTable({ s, rows, value, onChange, label, hint }: { s: PurchaseViewDto; rows: Array<{ productId: number; max: number }>; value: unknown; onChange: (v: Array<{ productId: number; qty: number }>) => void; label: string; hint?: string }) {
  const cur = (Array.isArray(value) ? value : []) as Array<{ productId: number; qty: number }>;
  const get = (id: number) => cur.find((x) => x.productId === id)?.qty;
  const put = (id: number, v: string) => onChange(rows.map((r) => ({ productId: r.productId, qty: r.productId === id ? (v === '' ? 0 : Number(v)) : get(r.productId) ?? 0 })));
  return (
    <table className="data-table purchase-qty" aria-label={label}>
      <thead><tr><th>商品</th><th>可办理</th><th>{label}</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.productId}>
            <td>{name(s, r.productId)}</td><td>{r.max}{unit(s, r.productId)}</td>
            <td><input type="number" min="0" max={r.max} step="0.0001" aria-label={`${name(s, r.productId)}${label}`} value={get(r.productId) ?? ''} onChange={(e) => put(r.productId, e.target.value)} /></td>
          </tr>
        ))}
      </tbody>
      {hint && <caption className="muted">{hint}</caption>}
    </table>
  );
}
const Money = ({ label, value, onChange, help }: { label: string; value: unknown; onChange: (v: string) => void; help?: string }) => (
  <label>{label}（元）<input inputMode="decimal" aria-label={label} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />{help && <small className="muted">{help}</small>}</label>
);

function Plan({ runId, state: s, options, data, set }: P) {
  const prices = (data.prices ?? {}) as Record<string, string>;
  const setPrice = (id: number, v: string) => { const ps = { ...prices, [id]: v }; set({ ...data, prices: ps }); };
  return (
    <div className="form-grid">
      <label>供应商<select aria-label="供应商" value={String(data.supplierId ?? '')} onChange={(e) => set({ ...data, supplierId: e.target.value })}><option value="">（选择）</option>{options?.suppliers?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
      <label>收货仓库<select aria-label="收货仓库" value={String(data.warehouseId ?? '')} onChange={(e) => set({ ...data, warehouseId: e.target.value })}><option value="">（选择）</option>{options?.warehouses?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
      <label>货款方式<select aria-label="货款方式" value={String(data.paymentMode ?? '')} onChange={(e) => set({ ...data, paymentMode: e.target.value })}><option value="">（选择）</option>{Object.entries(PAYMENT_MODE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label>收款人<input aria-label="收款人" value={String(data.payeeName ?? '')} onChange={(e) => set({ ...data, payeeName: e.target.value })} /></label>
      <label className="wide">收款账户<input aria-label="收款账户" value={String(data.payeeAccount ?? '')} onChange={(e) => set({ ...data, payeeAccount: e.target.value })} /></label>
      <div className="wide">
        <h4>商品单价（元 / 计价单位，最多 6 位小数）</h4>
        {s.lines.map((l) => (
          <label key={l.productId}>{l.name}（{l.qty}{l.unit}）<input inputMode="decimal" aria-label={`${l.name}单价`} value={prices[l.productId] ?? ''} onChange={(e) => setPrice(l.productId, e.target.value)} /></label>
        ))}
      </div>
      <div className="wide"><EvidenceInput runId={runId} label="方案附件（报价单等，选填）" ids={(data.files as number[]) ?? []} onChange={(files) => set({ ...data, files })} /></div>
    </div>
  );
}

function Pay({ runId, state: s, options, data, set }: P) {
  const pays = (Array.isArray(data.payments) ? data.payments : []) as Array<Record<string, unknown>>;
  const setPay = (i: number, patch: Record<string, unknown>) => set({ ...data, payments: pays.map((p, k) => (k === i ? { ...p, ...patch } : p)) });
  return (
    <div className="purchase-pay">
      <p>批准金额 <strong>{money(s.approvedCents)}</strong>；收款人 {s.payeeName}，账户 {s.payeeAccount}。{s.payments?.length ? <> 已登记付款 {s.payments.length} 笔。</> : null}</p>
      {options?.prepay && <p className="muted">该供应商预付款余额 {money(options.prepay.balanceCents)}，可占用 {money(options.prepay.availableCents)}。</p>}
      <Money label="占用已有预付款" value={data.claimYuan} onChange={(v) => set({ ...data, claimYuan: v })} help="不占用就留空" />
      {pays.map((p, i) => (
        <fieldset key={i} className="purchase-card">
          <legend>新付款 {i + 1}</legend>
          <Money label={`付款金额${i + 1}`} value={p.amountYuan} onChange={(v) => setPay(i, { amountYuan: v })} />
          <label>付款账户<select aria-label={`付款账户${i + 1}`} value={String(p.bankAccountId ?? '')} onChange={(e) => setPay(i, { bankAccountId: e.target.value })}><option value="">（选择）</option>{options?.banks?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
          <label>银行流水号<input aria-label={`银行流水号${i + 1}`} value={String(p.reference ?? '')} onChange={(e) => setPay(i, { reference: e.target.value })} /></label>
          <label>实际收款人<input aria-label={`实际收款人${i + 1}`} value={String(p.payeeName ?? s.payeeName ?? '')} onChange={(e) => setPay(i, { payeeName: e.target.value })} /></label>
          <label>实际收款账户<input aria-label={`实际收款账户${i + 1}`} value={String(p.payeeAccount ?? s.payeeAccount ?? '')} onChange={(e) => setPay(i, { payeeAccount: e.target.value })} /></label>
          <EvidenceInput runId={runId} label={`付款凭证${i + 1}`} ids={(p.files as number[]) ?? []} onChange={(files) => setPay(i, { files })} />
          <button type="button" className="link-button" onClick={() => set({ ...data, payments: pays.filter((_, k) => k !== i) })}>删除这笔</button>
        </fieldset>
      ))}
      <button type="button" className="secondary-button small" onClick={() => set({ ...data, payments: [...pays, { payeeName: s.payeeName, payeeAccount: s.payeeAccount, files: [] }] })}>＋ 新增一笔付款</button>
    </div>
  );
}

function Dispatch({ runId, state: s, data, set }: P) {
  const [promised, setPromised] = useState('');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');
  async function follow() {
    try { await purchaseApi.followup(runId, { promisedShipAt: promised, comment: note || undefined }); setMsg('已登记承诺发货时间，刷新后可见'); } catch (e) { setMsg(e instanceof ApiError ? e.message : '登记失败'); }
  }
  return (
    <div className="purchase-dispatch">
      <section className="purchase-card">
        <strong>还没发货？登记供应商承诺的发货时间</strong>
        <label>承诺发货日期<input type="date" aria-label="承诺发货日期" value={promised} onChange={(e) => setPromised(e.target.value)} /></label>
        <label>跟进说明<input aria-label="跟进说明" value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <button type="button" className="secondary-button small" onClick={() => void follow()}>登记跟进</button>
        {msg && <span role="status" className="muted">{msg}</span>}
        {s.followups.length > 0 && <ul>{s.followups.map((f, i) => <li key={i}>{f.byName}：承诺 {f.promisedShipAt} 发货{f.comment ? `（${f.comment}）` : ''}</li>)}</ul>}
      </section>
      <strong>已发货？登记本批发货</strong>
      <QtyTable s={s} label="本批发货数量" rows={s.lines.filter((l) => l.toShip > 0).map((l) => ({ productId: l.productId, max: l.toShip }))} value={data.lines} onChange={(lines) => set({ ...data, lines })} />
      <div className="form-grid">
        <label>物流单号<input aria-label="物流单号" value={String(data.logisticsNo ?? '')} onChange={(e) => set({ ...data, logisticsNo: e.target.value })} /></label>
        <label>预计到货日期<input type="date" aria-label="预计到货日期" value={String(data.expectedArrivalAt ?? '')} onChange={(e) => set({ ...data, expectedArrivalAt: e.target.value })} /></label>
      </div>
      <p className="muted">要求到货日期 {s.requestedArrivalAt}；预计到货晚于要求日期时，下面的“发货备注”必须写原因。</p>
      <EvidenceInput runId={runId} label="发货凭证（物流单照片等）" ids={(data.files as number[]) ?? []} onChange={(files) => set({ ...data, files })} />
    </div>
  );
}

function Arrival({ runId, state: s, data, set }: P) {
  const b = last(s);
  return (<div><p>物流单号 {b?.logisticsNo}，预计到货 {b?.expectedArrivalAt}。确认货已到仓后上传到货凭证。</p><EvidenceInput runId={runId} label="到货凭证" ids={(data.files as number[]) ?? []} onChange={(files) => set({ ...data, files })} /></div>);
}

function Receive({ runId, state: s, data, set }: P) {
  const b = last(s);
  const sh = s.shipments.find((x) => x.id === b?.shipmentId);
  return (
    <div>
      <QtyTable s={s} label="实收数量" rows={(sh?.lines ?? []).filter((l) => l.outstanding > 0).map((l) => ({ productId: l.productId, max: l.outstanding }))} value={data.lines} onChange={(lines) => set({ ...data, lines })} hint="实收少于发货时，请勾选下面的“少收部分不会再到”，或在差异说明里写原因" />
      <label className="check"><input type="checkbox" checked={!!data.receiptComplete} onChange={(e) => set({ ...data, receiptComplete: e.target.checked })} /> 少收部分不会再到（按短缺处理，进入异常）</label>
      <EvidenceInput runId={runId} label="收货凭证" ids={(data.files as number[]) ?? []} onChange={(files) => set({ ...data, files })} />
    </div>
  );
}

function Quality({ runId, state: s, data, set }: P) {
  const b = last(s);
  return (
    <div>
      <QtyTable s={s} label="合格数量" rows={(b?.received ?? []).map((l) => ({ productId: l.productId, max: l.qty }))} value={data.lines} onChange={(lines) => set({ ...data, lines })} hint="有不合格时，意见栏必须写不合格说明" />
      <EvidenceInput runId={runId} label="质检凭证" ids={(data.files as number[]) ?? []} onChange={(files) => set({ ...data, files })} />
    </div>
  );
}

function Exception({ runId, state: s, data, set }: P) {
  const b = last(s);
  const only = s.cancelRequested ? ['cancel_remaining'] : Object.keys(EXCEPTION_LABEL);
  return (
    <div>
      {s.cancelRequested && <p className="notice">申请人申请终止未到货部分并退款：{s.cancelRequestComment}</p>}
      {b && !s.cancelRequested && <p className="muted">本批异常：{b.difference || b.qualityComment || '质检有不合格'}</p>}
      <label>处置方式<select aria-label="处置方式" value={String(data.resolution ?? '')} onChange={(e) => set({ ...data, resolution: e.target.value })}><option value="">（选择）</option>{only.map((k) => <option key={k} value={k}>{EXCEPTION_LABEL[k as keyof typeof EXCEPTION_LABEL]}</option>)}</select></label>
      <EvidenceInput runId={runId} label="处置凭证（沟通记录等）" ids={(data.files as number[]) ?? []} onChange={(files) => set({ ...data, files })} />
    </div>
  );
}

function Refund({ runId, state: s, data, set }: P) {
  const rows = (Array.isArray(data.refunds) ? data.refunds : []) as Array<Record<string, unknown>>;
  const upd = (docId: number, patch: Record<string, unknown>) => set({ ...data, refunds: (s.payments ?? []).map((p) => ({ ...(rows.find((r) => r.docId === p.docId) ?? { docId: p.docId }), ...(p.docId === docId ? patch : {}) })) });
  return (
    <div>
      <p className="muted">逐笔确认：新付款里没用掉的部分会退回原付款账户；占用的已有预付款只是释放，不退款。</p>
      {(s.payments ?? []).map((p) => {
        const r = rows.find((x) => x.docId === p.docId) ?? {};
        return (
          <fieldset key={p.docId} className="purchase-card">
            <legend>{p.docNo} · {money(p.amountCents)}</legend>
            <label>退款银行流水号<input aria-label={`退款流水号${p.docNo}`} value={String(r.reference ?? '')} onChange={(e) => upd(p.docId, { reference: e.target.value })} /></label>
            <EvidenceInput runId={runId} label={`退款凭证${p.docNo}`} ids={(r.files as number[]) ?? []} onChange={(files) => upd(p.docId, { files })} />
          </fieldset>
        );
      })}
    </div>
  );
}

function Expense({ runId, state: s, data, set }: P) {
  const fees = (Array.isArray(data.fees) ? data.fees : []) as Array<Record<string, unknown>>;
  const upd = (i: number, patch: Record<string, unknown>) => set({ ...data, fees: fees.map((f, k) => (k === i ? { ...f, ...patch } : f)) });
  return (
    <div>
      <p className="muted">本批实际发生的运费、装卸费。没有费用就不加，并写明原因。</p>
      {fees.map((f, i) => (
        <fieldset key={i} className="purchase-card">
          <legend>费用 {i + 1}</legend>
          <label>类型<select aria-label={`费用类型${i + 1}`} value={String(f.type ?? '')} onChange={(e) => upd(i, { type: e.target.value })}><option value="">（选择）</option>{Object.entries(FEE_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <Money label={`费用金额${i + 1}`} value={f.amountYuan} onChange={(v) => upd(i, { amountYuan: v })} />
          <label>收款人<input aria-label={`费用收款人${i + 1}`} value={String(f.payeeName ?? '')} onChange={(e) => upd(i, { payeeName: e.target.value })} /></label>
          <label>收款账户<input aria-label={`费用收款账户${i + 1}`} value={String(f.payeeAccount ?? '')} onChange={(e) => upd(i, { payeeAccount: e.target.value })} /></label>
          <EvidenceInput runId={runId} label={`费用凭证${i + 1}`} ids={(f.files as number[]) ?? []} onChange={(files) => upd(i, { files })} />
          <button type="button" className="link-button" onClick={() => set({ ...data, fees: fees.filter((_, k) => k !== i) })}>删除</button>
        </fieldset>
      ))}
      <button type="button" className="secondary-button small" onClick={() => set({ ...data, fees: [...fees, { files: [] }] })}>＋ 新增费用</button>
      {!fees.length && <label>无需费用的原因<input aria-label="无需费用的原因" value={String(data.zeroReason ?? '')} onChange={(e) => set({ ...data, zeroReason: e.target.value })} /></label>}
      <span className="muted"> 批次 {s.batches.length}</span>
    </div>
  );
}

function Settle({ state: s, data, set }: P) {
  const b = last(s);
  const lines = (Array.isArray(data.lines) ? data.lines : []) as Array<{ productId: number; unitPriceYuan?: string }>;
  const setLine = (id: number, v: string) => set({ ...data, lines: (b?.accepted ?? []).map((a) => ({ productId: a.productId, unitPriceYuan: a.productId === id ? v : lines.find((x) => x.productId === a.productId)?.unitPriceYuan ?? '' })) });
  return (
    <div>
      <p>本批合格入库：{(b?.accepted ?? []).map((a) => `${name(s, a.productId)} ${a.qty}${unit(s, a.productId)}`).join('，')}；运费和装卸费 {b?.fees.length ? `${b.fees.length} 笔` : '无'}。</p>
      <label>费用分摊方式<select aria-label="费用分摊方式" value={String(data.allocationMethod ?? '')} onChange={(e) => set({ ...data, allocationMethod: e.target.value })}><option value="">（选择）</option>{Object.entries(ALLOCATION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      {b?.discountApproval && (
        <div><h4>折价接收：逐项确认结算单价（元，不能高于原批准单价）</h4>
          {(b.accepted ?? []).map((a) => (
            <label key={a.productId}>{name(s, a.productId)}（原价 ¥{centsToYuan(a.unitPriceCents)}）
              <input inputMode="decimal" aria-label={`${name(s, a.productId)}结算单价`} value={lines.find((x) => x.productId === a.productId)?.unitPriceYuan ?? ''} onChange={(e) => setLine(a.productId, e.target.value)} />
            </label>
          ))}
        </div>
      )}
      <Money label="冲抵预付款" value={data.offsetYuan} onChange={(v) => set({ ...data, offsetYuan: v })} help={s.prepay ? `本采购还可冲抵 ${money(s.prepay.unusedCents)}` : undefined} />
    </div>
  );
}

function ExpensePay({ runId, state: s, options, data, set }: P) {
  const unpaid = s.batches.flatMap((b) => b.fees.filter((f) => !f.paid).map((f) => ({ ...f, batch: b.id })));
  const rows = (Array.isArray(data.payments) ? data.payments : []) as Array<Record<string, unknown>>;
  const cur = rows[0] ?? {};
  const upd = (patch: Record<string, unknown>) => set({ ...data, payments: [{ ...cur, ...patch }] });
  const ids = (cur.feeIds as string[]) ?? [];
  return (
    <div>
      <p className="muted">逐笔勾选已经付出的费用，登记付款账户、流水号和凭证；全部登记完才能办完这一步。</p>
      {unpaid.map((f) => (
        <label key={f.id} className="check"><input type="checkbox" checked={ids.includes(f.id)} onChange={(e) => upd({ feeIds: e.target.checked ? [...ids, f.id] : ids.filter((x) => x !== f.id) })} /> {FEE_TYPE_LABEL[f.type]} {money(f.amountCents)} · {f.payeeName}</label>
      ))}
      <label>付款账户<select aria-label="费用付款账户" value={String(cur.bankAccountId ?? '')} onChange={(e) => upd({ bankAccountId: e.target.value })}><option value="">（选择）</option>{options?.banks?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
      <label>银行流水号<input aria-label="费用流水号" value={String(cur.reference ?? '')} onChange={(e) => upd({ reference: e.target.value })} /></label>
      <EvidenceInput runId={runId} label="费用付款凭证" ids={(cur.files as number[]) ?? []} onChange={(files) => upd({ files })} />
    </div>
  );
}

const FORMS: Record<string, (p: P) => JSX.Element> = { plan: Plan, pay: Pay, dispatch: Dispatch, arrival: Arrival, receive: Receive, quality: Quality, exception: Exception, refund: Refund, expense: Expense, settle: Settle, expense_pay: ExpensePay };

/** 页面输入（元、字符串）→ 接口要的数据（分、数字） */
export function toPayload(stepKey: string, d: Data): Data {
  const c = (v: unknown, label: string): number => { const x = yuanToCents(String(v ?? '')); if (x === null) throw new Error(`${label}格式不对（元，最多 6 位小数）`); return x; };
  const cents = (v: unknown, label: string): number => Math.round(c(v, label));
  const id = (v: unknown) => (v === '' || v === undefined ? undefined : Number(v));
  switch (stepKey) {
    case 'plan': {
      const prices: Record<string, number> = {};
      for (const [k, v] of Object.entries((d.prices ?? {}) as Record<string, string>)) prices[k] = c(v, '商品单价');
      return { supplierId: id(d.supplierId), warehouseId: id(d.warehouseId), paymentMode: d.paymentMode, payeeName: d.payeeName, payeeAccount: d.payeeAccount, prices, ...(Array.isArray(d.files) && d.files.length ? { files: d.files } : {}) };
    }
    case 'pay': {
      const claim = String(d.claimYuan ?? '').trim();
      return {
        payments: ((d.payments ?? []) as Array<Record<string, unknown>>).map((p) => ({ amountCents: cents(p.amountYuan, '付款金额'), bankAccountId: id(p.bankAccountId), reference: p.reference, payeeName: p.payeeName, payeeAccount: p.payeeAccount, files: p.files ?? [] })),
        ...(claim ? { claimCents: cents(claim, '占用的预付款') } : {}),
      };
    }
    case 'dispatch': return { lines: ((d.lines ?? []) as Array<{ productId: number; qty: number }>).filter((l) => l.qty > 0), logisticsNo: d.logisticsNo, expectedArrivalAt: d.expectedArrivalAt, files: d.files ?? [] };
    case 'arrival': return { files: d.files ?? [] };
    case 'receive': return { lines: d.lines ?? [], files: d.files ?? [], ...(d.receiptComplete ? { receiptComplete: true } : {}) };
    case 'quality': return { lines: d.lines ?? [], files: d.files ?? [] };
    case 'exception': return { resolution: d.resolution, files: d.files ?? [] };
    case 'refund': return { refunds: ((d.refunds ?? []) as Array<Record<string, unknown>>).map((r) => ({ docId: r.docId, reference: r.reference, files: r.files ?? [] })) };
    case 'expense': {
      const fees = ((d.fees ?? []) as Array<Record<string, unknown>>).map((f) => ({ type: f.type, amountCents: cents(f.amountYuan, '费用金额'), payeeName: f.payeeName, payeeAccount: f.payeeAccount, files: f.files ?? [] }));
      return { fees, ...(!fees.length ? { zeroReason: d.zeroReason } : {}) };
    }
    case 'settle': {
      const lines = ((d.lines ?? []) as Array<{ productId: number; unitPriceYuan?: string }>).map((l) => ({ productId: l.productId, unitPriceCents: c(l.unitPriceYuan, '结算单价') }));
      const off = String(d.offsetYuan ?? '').trim();
      return { allocationMethod: d.allocationMethod, ...(lines.length ? { lines } : {}), ...(off ? { offsetCents: cents(off, '冲抵预付款') } : {}) };
    }
    case 'expense_pay': return { payments: ((d.payments ?? []) as Array<Record<string, unknown>>).map((p) => ({ feeIds: p.feeIds ?? [], bankAccountId: id(p.bankAccountId), reference: p.reference, files: p.files ?? [] })) };
    default: return {};
  }
}

/** 办理某一步时的表单。本地保存页面输入，转换成接口数据后交给 onChange('data', …)；转换失败时把错误交给 onError。 */
export function PurchaseStepFields({ runId, stepKey, refreshKey, onChange }: { runId: number; stepKey: string; refreshKey: number; onChange: (k: string, v: unknown) => void }) {
  const [convErr, setConvErr] = useState('');
  const [state, setState] = useState<PurchaseViewDto | null>(null);
  const [options, setOptions] = useState<PurchaseOptions | null>(null);
  const [data, setData] = useState<Data>({});
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    purchaseApi.state(runId).then((r) => alive && setState(r)).catch((e) => alive && setErr(e instanceof ApiError ? e.message : '加载失败'));
    purchaseApi.options(runId).then((r) => alive && setOptions(r)).catch(() => undefined);
    return () => { alive = false; };
  }, [runId, refreshKey]);
  useEffect(() => { setData({}); }, [stepKey, refreshKey]);
  // 重新做方案时，用已有的单价、付款方式和收款资料预填（供应商和仓库要重新选）
  useEffect(() => {
    if (stepKey !== 'plan' || !state?.planReady) return;
    const prices = Object.fromEntries(state.lines.filter((l) => l.unitPriceCents != null).map((l) => [l.productId, centsToYuan(l.unitPriceCents)]));
    setData((d) => (d.paymentMode !== undefined ? d : { paymentMode: state.paymentMode ?? '', payeeName: state.payeeName ?? '', payeeAccount: state.payeeAccount ?? '', prices }));
  }, [stepKey, state]);
  const guide = PURCHASE_STEP_GUIDE[stepKey as keyof typeof PURCHASE_STEP_GUIDE];
  const Form = FORMS[stepKey];
  const set = (d: Data) => {
    setData(d);
    try { onChange('data', toPayload(stepKey, d)); setConvErr(''); } catch (e) { onChange('data', undefined); setConvErr((e as Error).message); }
  };
  if (err) return <div role="alert" className="notice error">{err}</div>;
  if (!state) return <p className="muted">加载中…</p>;
  return (
    <section className="purchase-step" aria-label={guide?.title}>
      {guide && <><p>{guide.description}</p><ul className="muted">{guide.tasks.map((t) => <li key={t}>{t}</li>)}</ul></>}
      {Form && <Form runId={runId} state={state} options={options} data={data} set={set} />}
      {convErr && <div role="alert" className="notice error">{convErr}</div>}
    </section>
  );
}
