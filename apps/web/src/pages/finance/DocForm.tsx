import { FormEvent, useEffect, useMemo, useState } from 'react';
import { unitYuanText, yuanToPreciseCents, ACCOUNT_LABEL, DOC_TYPE_MAP, FEE_BOOKING_NODES, FEE_BOOKING_NODE_MAP, PARTY_KIND_LABEL, PARTY_KIND_RESOURCE, SETTLE_BY_LABEL, SETTLEMENT_DOC_TYPES, docTotal, hasBankRef, lineAmount, todayInChina as today, validateDoc, type DocType, type PartyKind, type PayMode, type SettleBy } from '@kudesi/shared';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { resourceApi } from '../../resources/api';
import { SearchPick, centsToYuan, money, yuanToCents } from './common';
import { financeApi, type DocDetailDto, type OpenItem } from './financeApi';
import { sessionApi, type VoucherFile } from './sessionApi';
import { VoucherPanel } from './VoucherPanel';

const unitPriceOf=(v:string)=>{if(!v.trim())return null;try{return yuanToPreciseCents(v);}catch{return NaN;}};
interface LineState {
  productId: number | null; productName: string; feeItemId: number | null; feeItemName: string; qty: string; price: string; memo: string;
  /** 费用/收入行的挂账节点和对象 */
  node: string; relatedId: number | null; relatedName: string; needObject: boolean;
}
interface AcctState { id: number; name: string; amount: string }
const emptyLine = (): LineState => ({ productId: null, productName: '', feeItemId: null, feeItemName: '', qty: '1', price: '', memo: '', node: '', relatedId: null, relatedName: '', needObject: false });
const emptyLines = (n: number) => Array.from({ length: n }, emptyLine);

interface Props {
  type: DocType;
  doc?: DocDetailDto;
  preset?: { storeId: number; storeName: string };
  /** 制单中心：整页开单；否则是编辑草稿的弹窗 */
  inline?: boolean;
  onClose?: () => void;
  onSaved: (d: DocDetailDto, how: 'draft' | 'issued' | 'posted') => void;
}

/**
 * 开单页（管家婆式）：上面是单据头（编号、日期、往来对象及来源、仓库/部门、经办人），
 * 中间是明细表，下面是“收款/付款情况”——选结算方式（全款/部分/欠款/预收预付冲抵）、收付款账户、实收实付金额，
 * 没结清的部分自动挂应收/应付。保存草稿时允许没填完，开立/过账时严格校验。
 */
export function DocForm({ type, doc, preset, inline, onClose, onSaved }: Props) {
  const def = DOC_TYPE_MAP.get(type)!;
  const { can, user } = useAuth();
  const ui = def.ui;
  const kinds = def.partyKinds;
  const initial = useMemo(() => ({ date: doc?.docDate ?? today() }), [doc]);
  const [date, setDate] = useState(initial.date);
  const [docNo, setDocNo] = useState(doc?.docNo ?? '');
  const [partyKind, setPartyKind] = useState<PartyKind>((doc?.partyKind as PartyKind | null) ?? kinds[0] ?? 'customer');
  const [party, setParty] = useState<{ id: number | null; name: string }>({ id: doc?.partyId ?? null, name: doc?.partyName ?? '' });
  const [wh, setWh] = useState<{ id: number | null; name: string }>({ id: doc?.warehouseId ?? null, name: doc?.warehouseName ?? '' });
  const [bank, setBank] = useState<{ id: number | null; name: string }>({ id: doc?.bankAccountId ?? null, name: doc?.bankName ?? '' });
  const [toBank, setToBank] = useState<{ id: number | null; name: string }>({ id: doc?.toBankAccountId ?? null, name: doc?.toBankName ?? '' });
  const [store, setStore] = useState<{ id: number | null; name: string }>({ id: doc?.storeId ?? preset?.storeId ?? null, name: doc?.storeName ?? preset?.storeName ?? '' });
  const [refNo, setRefNo] = useState(doc?.refNo ?? '');
  const [handler, setHandler] = useState(doc?.handler ?? user?.name ?? '');
  const [department, setDepartment] = useState(doc?.department ?? (def.warehouse ? '' : '财务部'));
  const [amount, setAmount] = useState(def.lines ? '' : centsToYuan(doc?.amountCents));
  const [offset, setOffset] = useState(doc?.offsetCents ? centsToYuan(doc.offsetCents) : '');
  const [paid, setPaid] = useState(doc?.paidCents ? centsToYuan(doc.paidCents) : '');
  const [payMode, setPayMode] = useState<PayMode | ''>(doc ? (doc.paidCents || doc.offsetCents ? 'part' : 'credit') : '');
  const [memo, setMemo] = useState(doc?.memo ?? '');
  const [lines, setLines] = useState<LineState[]>(
    doc?.lines.length
      ? doc.lines.map((l) => ({ productId: l.productId ?? null, productName: l.productName, feeItemId: l.feeItemId ?? null, feeItemName: l.feeItemName, qty: String(l.qty), price: unitYuanText(l.unitPriceCents), memo: l.memo ?? '', node: l.relatedNode ?? '', relatedId: l.relatedId ?? null, relatedName: l.relatedName ?? '', needObject: false }))
      : def.lines ? emptyLines(inline ? 3 : 1) : [],
  );
  const toAccts = (role: 'out' | 'in'): AcctState[] => (doc?.accounts ?? []).filter((a) => a.role === role).map((a) => ({ id: a.bankAccountId, name: a.bankName, amount: centsToYuan(a.amountCents) }));
  const [outs, setOuts] = useState<AcctState[]>(() => (doc?.accounts?.length ? toAccts('out') : doc?.bankAccountId && doc.docType === 'transfer' ? [{ id: doc.bankAccountId, name: doc.bankName, amount: centsToYuan(doc.amountCents) }] : []));
  const [ins, setIns] = useState<AcctState[]>(() => (doc?.accounts?.length ? toAccts('in') : doc?.toBankAccountId ? [{ id: doc.toBankAccountId, name: doc.toBankName, amount: centsToYuan(doc.amountCents) }] : []));
  const canSettle = SETTLEMENT_DOC_TYPES.includes(type);
  const [settleBy, setSettleBy] = useState<SettleBy>((doc?.settleBy as SettleBy | null) ?? 'amount');
  const [alloc, setAlloc] = useState<Record<string, string>>(() => Object.fromEntries((doc?.settlements ?? []).map((x) => [x.productId ? `${x.sourceDocId}:${x.productId}` : `${x.sourceDocId}`, centsToYuan(x.amountCents)])));
  const [open, setOpen] = useState<OpenItem[]>([]);
  // 网店销售：往来对象是店铺时，店铺只有一个收款账户就自动填上；平台佣金率只用来估算净到账，不入账
  const [feeRate, setFeeRate] = useState('');
  useEffect(() => {
    if (type !== 'online-sale' || partyKind !== 'store' || !party.id || doc) return;
    let alive = true;
    resourceApi.list('bank-accounts', { fieldKey: 'storeId', fieldValue: String(party.id), pageSize: 5 })
      .then((r) => { const act = r.items.filter((x) => x.status !== 'inactive' && x.status !== 'deleted'); if (alive && act.length === 1) setBank((b) => (b.id ? b : { id: act[0].id, name: act[0].title })); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [type, partyKind, party.id, doc]);
  // 销售退货：选了客户后列出他已过账的销售单，可关联原单并带入明细（旧系统同款）
  const [origSales, setOrigSales] = useState<Array<{ id: number; docNo: string; docDate: string; amountCents: number }>>([]);
  const [origId, setOrigId] = useState('');
  const [origNote, setOrigNote] = useState('');
  useEffect(() => {
    setOrigId(''); setOrigNote(''); setOrigSales([]);
    if (type !== 'sale-return' || partyKind !== 'customer' || !party.id || !party.name) return;
    let alive = true;
    financeApi.docs({ scope: 'sale', status: 'posted', keyword: party.name })
      .then((r) => alive && setOrigSales(r.rows.filter((x) => x.partyName === party.name).map((x) => ({ id: x.id, docNo: x.docNo, docDate: x.docDate, amountCents: x.amountCents }))))
      .catch(() => alive && setOrigNote('没有权限查看销售单，不能关联原单'));
    return () => { alive = false; };
  }, [type, partyKind, party.id, party.name]);
  async function importOriginal() {
    if (!origId) return;
    try {
      const d = await financeApi.doc(Number(origId));
      const goods = d.lines.filter((l) => l.productId && l.qty > 0);
      if (!goods.length) { setOrigNote('该销售单没有商品明细，无法带入'); return; }
      if (lines.some((l) => l.productId || l.price) && !window.confirm('当前已填写的退货商品会被原销售单的商品替换，数量默认为原单全部数量，可再修改。')) return;
      setLines(goods.map((l) => ({ ...emptyLine(), productId: l.productId ?? null, productName: l.productName, qty: String(l.qty), price: unitYuanText(l.unitPriceCents) })));
      setOrigNote(`已带入 ${goods.length} 种商品，数量默认为原单全部数量，请改成实际退回数量`);
    } catch { setOrigNote('原销售单明细加载失败，请稍后重试'); }
  }
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [vouchers, setVouchers] = useState<VoucherFile[]>([]);
  const [vouchersDirty, setVouchersDirty] = useState(false);
  const [shopId, setShopId] = useState<number | null>(null);
  useEffect(() => { if (doc && def.store) sessionApi.docVouchers(doc.id).then(setVouchers).catch(() => undefined); }, [doc, def.store]);
  useEffect(() => {
    if (!def.store || !store.id) { setShopId(null); return; }
    sessionApi.overview({ storeId: store.id }).then((o) => setShopId(o.shops.find((x) => x.storeId === store.id)?.id ?? null)).catch(() => setShopId(null));
  }, [def.store, store.id]);

  useEffect(() => {
    if (!canSettle || settleBy === 'amount' || !party.id) { setOpen([]); return; }
    financeApi.openItems({ dir: type === 'receipt' ? 'in' : 'out', partyKind, partyId: party.id }).then(setOpen).catch(() => setOpen([]));
  }, [canSettle, settleBy, party.id, partyKind, type]);

  const parse = (t: string) => { const v = yuanToCents(t); if (Number.isNaN(v)) throw new Error('金额格式不对（最多两位小数）'); return v; };
  const body = () => {
    const parsedLines = lines
      .filter((l) => !(inline && !doc && !l.productId && !l.feeItemId && !l.price)) // 开单页预留的空行不算
      .map((l) => ({ productId: l.productId, feeItemId: l.feeItemId, qty: Number(l.qty), unitPriceCents: (()=>{const v=unitPriceOf(l.price);if(Number.isNaN(v))throw new Error('单价格式不对（最多六位小数）');return v??0;})(), memo: l.memo || undefined, relatedNode: l.node || null, relatedId: l.relatedId, relatedName: l.relatedId ? null : l.relatedName.trim() || null }));
    const accounts = def.bank === 'transfer'
      ? [...outs.map((a) => ({ role: 'out' as const, bankAccountId: a.id, amountCents: parse(a.amount) ?? 0 })), ...ins.map((a) => ({ role: 'in' as const, bankAccountId: a.id, amountCents: parse(a.amount) ?? 0 }))]
      : null;
    return {
      accounts, type, date, docNo: docNo.trim() || null, partyId: party.id, partyKind: def.party ? partyKind : null, bankAccountId: bank.id, toBankAccountId: toBank.id, warehouseId: wh.id,
      storeId: def.store ? store.id : null, refNo: hasBankRef(def) ? refNo : null, amountCents: def.lines || def.bank === 'transfer' ? null : parse(amount), offsetCents: parse(offset) ?? 0,
      paidCents: def.settle ? (parse(paid) ?? (def.lines === 'fee' ? null : 0)) : 0, handler: handler.trim() || null, department: department.trim() || null,
      lines: def.lines ? parsedLines : [], memo: memo || undefined,
      settleBy: canSettle ? settleBy : null,
      settlements: canSettle && settleBy !== 'amount'
        ? Object.entries(alloc).filter(([, v]) => v.trim() !== '' && (parse(v) ?? 0) > 0).map(([k, v]) => { const [d, pr] = k.split(':'); return { sourceDocId: Number(d), productId: pr ? Number(pr) : null, amountCents: parse(v) ?? 0 }; })
        : null,
    };
  };
  let total = 0;
  try { total = docTotal(def, body()); } catch { total = 0; }
  const sumAcct = (l: AcctState[]) => l.reduce((s, a) => s + (yuanToCents(a.amount) || 0), 0);
  const paidC = (() => { try { return def.settle ? parse(paid) ?? 0 : 0; } catch { return 0; } })();
  const offsetC = (() => { try { return parse(offset) ?? 0; } catch { return 0; } })();
  const rest = total - paidC - offsetC;
  const settleTotal = (() => { try { return (parse(amount) ?? 0) + offsetC; } catch { return 0; } })();
  const allocated = Object.values(alloc).reduce((a, v) => { const c = yuanToCents(v); return a + (Number.isNaN(c) || !c ? 0 : c); }, 0);
  /** 按业务发生先后自动分配（管家婆“按业务发生顺序自动结算”）；按商品时先分完一张单的商品再下一张 */
  const autoAlloc = () => {
    let left = settleTotal;
    const next: Record<string, string> = {};
    for (const it of open) {
      if (left <= 0) break;
      if (settleBy === 'doc') { const v = Math.min(left, it.outstandingCents); next[`${it.id}`] = centsToYuan(v); left -= v; }
      else for (const p of it.products) { if (left <= 0) break; const v = Math.min(left, p.outstandingCents, it.outstandingCents); if (v > 0) { next[`${it.id}:${p.productId}`] = centsToYuan(v); left -= v; } }
    }
    setAlloc(next);
  };
  const restLabel = def.settle === 'in' ? (type === 'purchase-return' ? '还没退回' : '欠款（挂应收）') : type === 'sale-return' ? '暂未退款（冲客户欠款）' : type === 'purchase-in' ? '欠款（挂应付）' : '未结清';

  const pickMode = (m: PayMode) => {
    setPayMode(m);
    if (m === 'full') { setPaid(centsToYuan(total)); setOffset(''); }
    else if (m === 'credit') { setPaid(''); setOffset(''); }
    else if (m === 'offset') { setPaid(''); setOffset(centsToYuan(total)); }
  };

  const reset = () => {
    setDocNo(''); setParty({ id: null, name: '' }); setWh({ id: null, name: '' }); setBank({ id: null, name: '' }); setToBank({ id: null, name: '' }); setRefNo('');
    setOuts([]); setIns([]); setAmount(''); setOffset(''); setPaid(''); setPayMode(''); setMemo(''); setLines(def.lines ? emptyLines(3) : []); setVouchers([]); setVouchersDirty(false); setError('');
  };

  const save = async (e: FormEvent | null, then?: 'issue' | 'post') => {
    e?.preventDefault();
    setError(''); setNotice('');
    setBusy(true);
    try {
      const b = body();
      if (then) {
        const errs = validateDoc(b);
        if (errs.length) throw new Error(errs.join('；'));
      }
      let saved = doc ? await financeApi.update(doc.id, b) : await financeApi.create(b);
      if (def.store && (vouchersDirty || (vouchers.length > 0 && !doc))) await sessionApi.bindVouchers(saved.id, vouchers.map((v) => v.id));
      if (then === 'issue') saved = await financeApi.issue(saved.id);
      if (then === 'post') saved = await financeApi.post(saved.id);
      if (inline && !doc) { reset(); setNotice(`已保存 ${saved.docNo}（${then === 'post' ? '已过账' : then === 'issue' ? '已开立' : '草稿'}），可以接着开下一张`); }
      setBusy(false);
      onSaved(saved, then === 'post' ? 'posted' : then === 'issue' ? 'issued' : 'draft');
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : '保存失败');
      setBusy(false);
    }
  };
  const setLine = (i: number, patch: Partial<LineState>) => setLines((ls) => ls.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  /** 选了费用项目：按费用档案里的默认挂账节点预选，并记下是否必须挂对象 */
  const pickFee = async (i: number, id: number | null, name: string) => {
    setLine(i, { feeItemId: id, feeItemName: name, ...(id ? {} : { needObject: false }) });
    if (!id) return;
    try {
      const r = await resourceApi.get('finance-fee-items', id);
      const first = String(r.data.defaultObject ?? '').split(/[、,，]/).map((x) => x.trim()).find((x) => FEE_BOOKING_NODE_MAP.has(x) && x !== '不固定');
      setLines((ls) => ls.map((l, k) => (k === i && l.feeItemId === id ? { ...l, needObject: r.data.requiredObject === 'yes', node: l.node || first || '' } : l)));
    } catch { /* 取不到默认值不影响开单 */ }
  };
  const moneyItem = ui.moneyItemLabel ?? '备注';

  const content = (
    <>
      <p className="muted slip-hint">过账结果：{def.posting}</p>
      <section className="slip-head">
        <label>单据编号<input aria-label="单据编号" value={docNo} maxLength={32} onChange={(e) => setDocNo(e.target.value)} placeholder={doc ? '' : `不填则自动生成（${def.prefix}${date.replace(/-/g, '')}001）`} disabled={!!doc && doc.status !== 'draft'} /></label>
        <label>单据日期<input type="date" aria-label="单据日期" value={date} onChange={(e) => setDate(e.target.value)} required /></label>
        {def.party && (
          <label className="slip-party">{ui.partyLabel}{def.partyRequired ? ' *' : ''}
            <div className="slip-party-row">
              {kinds.length > 1 && (
                <select aria-label="往来对象来源" value={partyKind} onChange={(e) => { if (e.target.value === 'employee') void financeApi.syncEmployees().catch(() => undefined); setPartyKind(e.target.value as PartyKind); setParty({ id: null, name: '' }); }}>
                  {kinds.map((k) => <option key={k} value={k}>来自{PARTY_KIND_LABEL[k]}档案</option>)}
                </select>
              )}
              <SearchPick ariaLabel={ui.partyLabel} type={PARTY_KIND_RESOURCE[partyKind]} value={party.id} label={party.name} placeholder={`搜索${PARTY_KIND_LABEL[partyKind]}`} onChange={(id, name) => setParty({ id, name })} />
            </div>
          </label>
        )}
        {type === 'sale-return' && partyKind === 'customer' && (
          <div className="slip-orig">
            <label>关联原销售单（选填，用于对照退货数量）
              <select aria-label="关联原销售单" value={origId} disabled={!party.id} onChange={(e) => setOrigId(e.target.value)}>
                <option value="">{party.id ? (origSales.length ? '不关联原单' : '该客户暂无已过账的销售单') : '请先选择客户'}</option>
                {origSales.map((o) => <option key={o.id} value={o.id}>{o.docNo} · {o.docDate} · {money(o.amountCents)}</option>)}
              </select>
            </label>
            <button type="button" className="secondary-button" disabled={!origId} onClick={() => void importOriginal()}>带入原单明细</button>
            {origNote && <span className="muted">{origNote}</span>}
          </div>
        )}
        {def.store && <label>店铺 *<SearchPick ariaLabel="店铺" type="stores" value={store.id} label={store.name} onChange={(id, name) => setStore({ id, name })} /></label>}
        {def.store && <label>平台提现流水号 *<input aria-label="平台提现流水号" value={refNo} maxLength={80} onChange={(e) => setRefNo(e.target.value)} placeholder="平台后台提现记录里的流水号，不能重复" /></label>}
        {!def.store && hasBankRef(def) && <label>银行流水号<input aria-label="银行流水号" value={refNo} maxLength={80} onChange={(e) => setRefNo(e.target.value)} placeholder="选填；银行回单上的流水号，同一个流水号只能登记一次" /></label>}
        {def.warehouse
          ? <label>{ui.warehouseLabel} *<SearchPick ariaLabel="仓库" type="finance-warehouses" value={wh.id} label={wh.name} onChange={(id, name) => setWh({ id, name })} /></label>
          : <label>归属部门<input aria-label="归属部门" value={department} maxLength={60} onChange={(e) => setDepartment(e.target.value)} /></label>}
        <label>经办人<input aria-label="经办人" value={handler} maxLength={60} onChange={(e) => setHandler(e.target.value)} /></label>
      </section>

      {def.bank === 'transfer' && (
        <section className="transfer-grid">
          {([['out', '转出账户', outs, setOuts], ['in', '转入账户', ins, setIns]] as const).map(([role, label, list, setList]) => (
            <div key={role} className="transfer-side">
              <h3 className="section-title">{label} *</h3>
              <SearchPick ariaLabel={`添加${label}`} type="bank-accounts" value={null} label="" placeholder={`搜索并添加${label}`}
                onChange={(id, name) => { if (id && !list.some((a) => a.id === id)) setList([...list, { id, name, amount: '' }]); }} />
              <ul className="transfer-list">
                {list.map((a, k) => (
                  <li key={a.id}>
                    <span>{a.name}</span>
                    <input inputMode="decimal" aria-label={`${label}${a.name}金额`} placeholder="金额（元）" value={a.amount} onChange={(e) => setList(list.map((x, j) => (j === k ? { ...x, amount: e.target.value } : x)))} />
                    <button type="button" className="link-button" onClick={() => setList(list.filter((_, j) => j !== k))}>移除</button>
                  </li>
                ))}
                {list.length === 0 && <li className="muted">还没有选{label}</li>}
              </ul>
              <div className="muted">{label.slice(0, 2)}合计：{money(sumAcct(list))}</div>
            </div>
          ))}
          <div className={`transfer-diff${sumAcct(outs) === sumAcct(ins) && sumAcct(outs) > 0 ? ' ok' : ' bad'}`}>
            {sumAcct(outs) === sumAcct(ins) && sumAcct(outs) > 0 ? `转款 ${money(sumAcct(outs))}，两边相等` : `转出与转入相差 ${money(Math.abs(sumAcct(outs) - sumAcct(ins)))}，两边必须相等`}
          </div>
        </section>
      )}

      {def.lines && (
        <section>
          <h3 className="section-title">{ui.detailTitle}</h3>
          <div className="table-scroll">
            <table className="data-table doc-lines">
              <thead><tr><th>#</th><th>{def.lines === 'product' ? '商品' : '费用项目'}</th>{def.lines === 'fee' && <><th>挂账节点</th><th>挂账对象</th></>}<th>数量</th><th>单价（元）</th><th>金额</th><th>备注</th><th /></tr></thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td>
                      {def.lines === 'product'
                        ? <SearchPick ariaLabel={`第${i + 1}行商品`} type="finance-products" value={l.productId} label={l.productName} onChange={(id, name) => setLine(i, { productId: id, productName: name })} />
                        : <SearchPick ariaLabel={`第${i + 1}行费用项目`} type="finance-fee-items" fieldKey="direction" fieldValue={def.feeDirection} value={l.feeItemId} label={l.feeItemName} onChange={(id, name) => pickFee(i, id, name)} />}
                    </td>
                    {def.lines === 'fee' && (
                      <>
                        <td>
                          <select aria-label={`第${i + 1}行挂账节点`} value={l.node} onChange={(e) => setLine(i, { node: e.target.value, relatedId: null, relatedName: '' })}>
                            <option value="">不选择</option>
                            {FEE_BOOKING_NODES.map((n) => <option key={n.node} value={n.node}>{n.node}</option>)}
                          </select>
                        </td>
                        <td>
                          {l.node && FEE_BOOKING_NODE_MAP.get(l.node)?.resource
                            ? <SearchPick ariaLabel={`第${i + 1}行挂账对象`} type={FEE_BOOKING_NODE_MAP.get(l.node)!.resource!} fieldKey={FEE_BOOKING_NODE_MAP.get(l.node)!.kind ? 'kind' : undefined} fieldValue={FEE_BOOKING_NODE_MAP.get(l.node)!.kind} value={l.relatedId} label={l.relatedName} placeholder={`搜索${l.node}`} onChange={(id, name) => setLine(i, { relatedId: id, relatedName: name })} />
                            : <input aria-label={`第${i + 1}行挂账对象`} value={l.relatedName} maxLength={100} placeholder={l.needObject ? '必填：写清挂在哪里' : l.node ? `${l.node}名称` : '先选挂账节点'} disabled={!l.node} onChange={(e) => setLine(i, { relatedName: e.target.value })} />}
                          {l.needObject && !l.relatedId && !l.relatedName.trim() && <span className="muted" style={{ color: '#c0392b' }}>必须挂对象</span>}
                        </td>
                      </>
                    )}
                    <td><input inputMode="decimal" aria-label={`第${i + 1}行数量`} value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} /></td>
                    <td><input inputMode="decimal" aria-label={`第${i + 1}行单价`} value={l.price} onChange={(e) => setLine(i, { price: e.target.value })} /></td>
                    <td className="num">{money(lineAmount({ qty: Number(l.qty) || 0, unitPriceCents: unitPriceOf(l.price) || 0 }))}</td>
                    <td><input aria-label={`第${i + 1}行备注`} value={l.memo} maxLength={200} onChange={(e) => setLine(i, { memo: e.target.value })} /></td>
                    <td><button type="button" className="link-button" disabled={lines.length <= 1} onClick={() => setLines((ls) => ls.filter((_, k) => k !== i))}>删除</button></td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr><th colSpan={def.lines === 'fee' ? 6 : 4}>{ui.totalLabel}</th><th className="num">{money(total)}</th><th colSpan={2} /></tr></tfoot>
            </table>
            <button type="button" className="secondary-button small" onClick={() => setLines((ls) => [...ls, emptyLine()])}>+ 加一行</button>
          </div>
        </section>
      )}

      <section className="slip-settle">
        <h3 className="section-title">{def.settle === 'in' && type !== 'purchase-return' ? '收款情况' : def.settle === 'out' && type !== 'sale-return' ? '付款情况' : def.settle ? '退款情况' : def.bank === 'in' ? '收款情况' : def.bank === 'out' ? '付款情况' : '转款情况'}</h3>
        {def.settle && (
          <div className="pay-modes" role="group" aria-label="结算方式">
            {ui.payModes.map((m) => <button key={m.mode} type="button" className={`mode-button${payMode === m.mode ? ' active' : ''}`} aria-pressed={payMode === m.mode} onClick={() => pickMode(m.mode)}>{m.label}</button>)}
          </div>
        )}
        <div className="form-grid">
          {!def.lines && def.bank !== 'transfer' && <label>{ui.amountLabel}（元） *<input inputMode="decimal" aria-label={ui.amountLabel} value={amount} onChange={(e) => setAmount(e.target.value)} /></label>}
          {def.settle && <label>{ui.amountLabel}（元）<input inputMode="decimal" aria-label={ui.amountLabel} value={paid} onChange={(e) => { setPaid(e.target.value); setPayMode('part'); }} placeholder={def.lines === 'fee' ? '不填 = 当场付清/收齐' : '0.00'} /></label>}
          {(def.bank === 'in' || def.bank === 'out' || def.settle) && def.bank !== 'transfer' && <label>{ui.accountLabel} *<SearchPick ariaLabel={ui.accountLabel} type="bank-accounts" value={bank.id} label={bank.name} onChange={(id, name) => setBank({ id, name })} /></label>}
          {type === 'online-sale' && <label>平台佣金率（%，仅估算，不入账）<input inputMode="decimal" aria-label="平台佣金率" value={feeRate} onChange={(e) => setFeeRate(e.target.value)} placeholder="如 0.6" /></label>}
          {def.offset && <label>冲抵{ACCOUNT_LABEL[def.offset]}（元）<input inputMode="decimal" aria-label="冲抵金额" value={offset} onChange={(e) => setOffset(e.target.value)} placeholder="不冲抵就留空" /></label>}
        </div>
        {type === 'online-sale' && Number(feeRate) > 0 && total > 0 && <p className="muted">预估平台费 <b>{money(Math.round(total * Number(feeRate) / 100))}</b>，预计净到账 <b>{money(total - Math.round(total * Number(feeRate) / 100))}</b></p>}
        {canSettle && (
          <div className="settle-by">
            <div className="pay-modes" role="group" aria-label="结算方式选择">
              {(['amount', 'doc', 'product'] as SettleBy[]).map((m) => <button key={m} type="button" className={`mode-button${settleBy === m ? ' active' : ''}`} aria-pressed={settleBy === m} onClick={() => { setSettleBy(m); setAlloc({}); }}>{SETTLE_BY_LABEL[m]}</button>)}
            </div>
            {settleBy === 'amount' && <p className="muted">按金额结算：直接冲减这个往来对象的{type === 'receipt' ? '应收' : '应付'}余额，不指定单据。</p>}
            {settleBy !== 'amount' && (
              <>
                {!party.id && <p className="muted">先选往来对象，才能列出他名下没结算完的单据。</p>}
                {party.id && open.length === 0 && <p className="muted">这个往来对象名下没有需要结算的单据。</p>}
                {open.length > 0 && (
                  <div className="table-scroll"><table className="data-table" aria-label="结算单据">
                    <thead><tr><th>单据</th><th>日期</th>{settleBy === 'product' && <th>商品</th>}<th className="num">单据金额</th><th className="num">未结算</th><th className="num">本次结算（元）</th></tr></thead>
                    <tbody>
                      {open.flatMap((it) => settleBy === 'doc'
                        ? [<tr key={it.id}><td className="mono">{it.docNo} <span className="muted">{it.typeLabel}</span></td><td>{it.docDate}</td><td className="num">{money(it.amountCents)}</td><td className="num">{money(it.outstandingCents)}</td>
                            <td><input inputMode="decimal" aria-label={`结算 ${it.docNo}`} value={alloc[`${it.id}`] ?? ''} onChange={(e) => setAlloc((a) => ({ ...a, [`${it.id}`]: e.target.value }))} /></td></tr>]
                        : it.products.map((p, i) => <tr key={`${it.id}:${p.productId}`}><td className="mono">{i === 0 ? <>{it.docNo} <span className="muted">{it.typeLabel}</span></> : ''}</td><td>{i === 0 ? it.docDate : ''}</td><td>{p.productName}</td><td className="num">{money(p.amountCents)}</td><td className="num">{money(p.outstandingCents)}</td>
                            <td><input inputMode="decimal" aria-label={`结算 ${it.docNo} ${p.productName}`} value={alloc[`${it.id}:${p.productId}`] ?? ''} onChange={(e) => setAlloc((a) => ({ ...a, [`${it.id}:${p.productId}`]: e.target.value }))} /></td></tr>))}
                    </tbody>
                  </table></div>
                )}
                <div className="between">
                  <span className={allocated === settleTotal && settleTotal > 0 ? 'ok-text' : 'bad-text'}>已分配 {money(allocated)} / 本次结算金额 {money(settleTotal)}（收付款金额加冲抵）</span>
                  <button type="button" className="secondary-button small" onClick={autoAlloc} disabled={!open.length || settleTotal <= 0}>按业务发生先后自动分配</button>
                </div>
              </>
            )}
          </div>
        )}
        {def.settle && def.lines && (
          <dl className="settle-sum">
            <div><dt>{ui.totalLabel}</dt><dd>{money(total)}</dd></div>
            <div><dt>{ui.amountLabel}</dt><dd>{money(paidC)}</dd></div>
            {def.offset && <div><dt>冲抵{ACCOUNT_LABEL[def.offset]}</dt><dd>{money(offsetC)}</dd></div>}
            <div className={rest < 0 ? 'bad' : undefined}><dt>{restLabel}</dt><dd>{money(rest)}</dd></div>
          </dl>
        )}
      </section>

      {def.store && <VoucherPanel files={vouchers} shopId={shopId} onChange={(f) => { setVouchers(f); setVouchersDirty(true); }} />}
      <label>{def.lines ? '备注' : `${moneyItem} / 备注`}<textarea rows={2} maxLength={500} aria-label="备注" value={memo} onChange={(e) => setMemo(e.target.value)} /></label>
      {notice && <div role="status" className="notice ok">{notice}</div>}
      {error && <div role="alert" className="notice error">{error}</div>}
    </>
  );

  const buttons = (
    <>
      {inline && !doc && <button type="button" className="secondary-button" disabled={busy} onClick={reset}>清空单据</button>}
      {!inline && <button type="button" className="secondary-button" onClick={onClose}>取消</button>}
      <button type="submit" className="secondary-button" disabled={busy}>{inline ? '保存草稿' : '存为草稿'}</button>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => save(null, 'issue')}>保存并开立</button>
      {can('finance.docs.post') && <button type="button" className="primary-button" disabled={busy} onClick={() => save(null, 'post')}>{ui.saveText.replace('保存', '保存并过账')}</button>}
    </>
  );

  if (inline) {
    return (
      <form className="card slip" aria-label={`${def.label}开单`} onSubmit={(e) => save(e)}>
        <div className="slip-title"><strong>{def.label} / 手工开单</strong></div>
        <div className="slip-body">{content}</div>
        <div className="slip-foot">{buttons}</div>
      </form>
    );
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal card slip" style={{ maxWidth: 980 }} role="dialog" aria-label={`${doc ? '编辑' : '新建'}${def.label}`} onSubmit={(e) => save(e)}>
        <div className="modal-head between"><strong>{doc ? `编辑 ${doc.docNo}` : `新建${def.label}`}</strong><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>×</button></div>
        <div className="modal-body">{content}</div>
        <div className="modal-foot">{buttons}</div>
      </form>
    </div>
  );
}
