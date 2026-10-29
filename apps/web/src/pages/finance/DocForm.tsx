import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { unitYuanText, yuanToPreciseCents, ACCOUNT_LABEL, DOC_TYPE_MAP, FEE_BOOKING_NODE_MAP, PARTY_KIND_LABEL, PARTY_KIND_RESOURCE, SETTLEMENT_DOC_TYPES, docTotal, grossTotal, hasBankRef, lineAmount, todayInChina as today, validateDoc, type DocType, type PartyKind, type PayMode, type SettleBy } from '@kudesi/shared';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { resourceApi } from '../../resources/api';
import { SearchPick, centsToYuan, money, yuanToCents } from './common';
import { useUnsavedWarning } from './fin-ui';
import { financeApi, type DocDetailDto, type OpenItem } from './financeApi';
import { sessionApi, type VoucherFile } from './sessionApi';
import { VoucherPanel } from './VoucherPanel';
import { GoodsGrid } from './voucher/GoodsGrid';
import { MoneyGrid } from './voucher/MoneyGrid';
import { PartyBalanceBar } from './voucher/PartyBalanceBar';
import { SettleBySection } from './voucher/SettleBySection';
import { TransferPanel } from './voucher/TransferPanel';
import { VoucherToolbar } from './voucher/VoucherToolbar';
import { printSlip } from './voucher/printSlip';
import { emptyLine, emptyLines, emptyMoney, type AcctState, type LineState, type MoneyLine } from './voucher/types';
import { useLineHints, usePartyBalance } from './voucher/useVoucherHints';

const unitPriceOf = (v: string) => { if (!v.trim()) return null; try { return yuanToPreciseCents(v); } catch { return NaN; } };

interface Props {
  type: DocType;
  doc?: DocDetailDto;
  preset?: { storeId: number; storeName: string };
  /** 制单中心：整页开单；否则是编辑草稿的弹窗 */
  inline?: boolean;
  onClose?: () => void;
  onSaved: (d: DocDetailDto, how: 'draft' | 'issued' | 'posted') => void;
  /** 制单中心：调入草稿（把草稿装进开单页继续改） */
  onPickDraft?: (id: number) => void;
  /** 制单中心：单据调阅（滚到下面的单据列表） */
  onShowList?: () => void;
}

/** 退货类单据可以关联的原单：销售退货 → 已过账销售单；采购退货 → 已过账采购入库单（管家婆“调原销售单/调原采购单”） */
const ORIGIN: Partial<Record<DocType, { scope: DocType; kind: PartyKind; label: string }>> = {
  'sale-return': { scope: 'sale', kind: 'customer', label: '原销售单' },
  'purchase-return': { scope: 'purchase-in', kind: 'supplier', label: '原采购入库单' },
};

/**
 * 开单页（管家婆式）：上面是操作条（调入草稿/保存草稿/过账/打印…），然后是单据头（编号、日期、往来对象及余额、仓库/部门、经办人），
 * 中间是明细网格（回车逐格录入、库存与价格提示、赠品），右侧是“收款/付款情况”——选结算方式（全款/部分/欠款/预收预付冲抵）、收付款账户、实收实付金额，
 * 没结清的部分自动挂应收/应付。保存草稿时允许没填完，开立/过账时严格校验。
 */
export function DocForm({ type, doc, preset, inline, onClose, onSaved, onPickDraft, onShowList }: Props) {
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
  const [moneyLines, setMoneyLines] = useState<MoneyLine[]>(() => {
    if (def.lines) return [];
    if (doc?.lines.length) return doc.lines.map((l) => ({ item: l.itemName ?? '', amount: centsToYuan(Math.round(l.unitPriceCents * l.qty)), memo: l.memo ?? '' }));
    if (doc && doc.amountCents) return [{ item: '', amount: centsToYuan(doc.amountCents), memo: '' }];
    return [emptyMoney()];
  });
  const moneyCents = moneyLines.reduce((sum, l) => { const c = yuanToCents(l.amount); return sum + (c && !Number.isNaN(c) ? c : 0); }, 0);
  const amount = moneyCents ? centsToYuan(moneyCents) : '';
  const [offset, setOffset] = useState(doc?.offsetCents ? centsToYuan(doc.offsetCents) : '');
  const [paid, setPaid] = useState(doc?.paidCents ? centsToYuan(doc.paidCents) : '');
  const [discount, setDiscount] = useState(doc?.discountCents ? centsToYuan(doc.discountCents) : '');
  const [payMode, setPayMode] = useState<PayMode | ''>(doc ? (doc.paidCents || doc.offsetCents ? 'part' : 'credit') : '');
  const [memo, setMemo] = useState(doc?.memo ?? '');
  const [lines, setLines] = useState<LineState[]>(
    doc?.lines.length
      ? doc.lines.map((l) => ({ unit: l.unit ?? '', productId: l.productId ?? null, productName: l.productName, feeItemId: l.feeItemId ?? null, feeItemName: l.feeItemName, qty: String(l.qty), price: unitYuanText(l.unitPriceCents), memo: l.memo ?? '', gift: !!l.productId && l.unitPriceCents === 0, node: l.relatedNode ?? '', relatedId: l.relatedId ?? null, relatedName: l.relatedName ?? '', needObject: false }))
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

  // 退货关联原单：选了往来对象后列出他已过账的原单，可关联并带入明细、对照退货数量
  const origin = ORIGIN[type];
  const [origSales, setOrigSales] = useState<Array<{ id: number; docNo: string; docDate: string; amountCents: number }>>([]);
  const [origId, setOrigId] = useState('');
  const [origNote, setOrigNote] = useState('');
  const [origQty, setOrigQty] = useState<Array<{ productId: number; name: string; qty: number }>>([]);
  useEffect(() => {
    setOrigId(''); setOrigNote(''); setOrigSales([]); setOrigQty([]);
    if (!origin || partyKind !== origin.kind || !party.id || !party.name) return;
    let alive = true;
    financeApi.docs({ scope: origin.scope, status: 'posted', keyword: party.name })
      .then((r) => alive && setOrigSales(r.rows.filter((x) => x.partyName === party.name).map((x) => ({ id: x.id, docNo: x.docNo, docDate: x.docDate, amountCents: x.amountCents }))))
      .catch(() => alive && setOrigNote(`没有权限查看${origin.label}，不能关联`));
    return () => { alive = false; };
  }, [origin, partyKind, party.id, party.name]);
  async function importOriginal() {
    if (!origId) return;
    try {
      const d = await financeApi.doc(Number(origId));
      const goods = d.lines.filter((l) => l.productId && l.qty > 0);
      if (!goods.length) { setOrigNote('该单据没有商品明细，无法带入'); return; }
      if (lines.some((l) => l.productId || l.price) && !window.confirm('当前已填写的退货商品会被原单的商品替换，数量默认为原单全部数量，可再修改。')) return;
      setOrigQty(goods.map((l) => ({ productId: l.productId as number, name: l.productName, qty: l.qty })));
      setLines(goods.map((l) => ({ ...emptyLine(), unit: l.unit ?? '', productId: l.productId ?? null, productName: l.productName, qty: String(l.qty), price: unitYuanText(l.unitPriceCents) })));
      setOrigNote(`已带入 ${goods.length} 种商品，数量默认为原单全部数量，请改成实际退回数量`);
    } catch { setOrigNote('原单明细加载失败，请稍后重试'); }
  }

  const [balances, setBalances] = useState<Map<number, number>>(new Map());
  const needBalance = def.bank !== 'none' || !!def.settle;
  useEffect(() => { if (needBalance) financeApi.banks().then((r) => setBalances(new Map(r.map((b) => [b.id, b.balanceCents])))).catch(() => undefined); }, [needBalance]);
  const noticeRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => { if (notice || error) noticeRef.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }); }, [notice, error]);
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

  const [balanceTick, setBalanceTick] = useState(0);
  const partyBalance = usePartyBalance(def.party ? partyKind : null, party.id, balanceTick);
  const hints = useLineHints(def.lines === 'product' ? lines.map((l) => l.productId).filter((x): x is number => !!x) : [], wh.id);

  const parse = (t: string) => { const v = yuanToCents(t); if (Number.isNaN(v)) throw new Error('金额格式不对（最多两位小数）'); return v; };
  const priceOf = (t: string) => { const v = unitPriceOf(t); return typeof v === 'number' && !Number.isNaN(v) ? v : 0; };
  const body = () => {
    const parsedLines = lines
      .filter((l) => !(inline && !doc && !l.productId && !l.feeItemId && !l.price)) // 开单页预留的空行不算
      .map((l) => ({ productId: l.productId, feeItemId: l.feeItemId, qty: Number(l.qty), unitPriceCents: l.gift ? 0 : (() => { const v = unitPriceOf(l.price); if (Number.isNaN(v)) throw new Error('单价格式不对（最多六位小数）'); return v ?? 0; })(), memo: l.memo || undefined, unit: l.unit.trim() || null, relatedNode: l.node || null, relatedId: l.relatedId, relatedName: l.relatedId ? null : l.relatedName.trim() || null }));
    const accounts = def.bank === 'transfer'
      ? [...outs.map((a) => ({ role: 'out' as const, bankAccountId: a.id, amountCents: parse(a.amount) ?? 0 })), ...ins.map((a) => ({ role: 'in' as const, bankAccountId: a.id, amountCents: parse(a.amount) ?? 0 }))]
      : null;
    return {
      accounts, type, date, docNo: docNo.trim() || null, partyId: party.id, partyKind: def.party ? partyKind : null, bankAccountId: bank.id, toBankAccountId: toBank.id, warehouseId: wh.id,
      storeId: def.store ? store.id : null, refNo: hasBankRef(def) ? refNo : null, amountCents: null, offsetCents: parse(offset) ?? 0,
      discountCents: def.lines === 'product' ? parse(discount) ?? 0 : 0,
      paidCents: def.settle ? (parse(paid) ?? (def.lines === 'fee' ? null : 0)) : 0, handler: handler.trim() || null, department: department.trim() || null,
      lines: def.lines ? parsedLines : moneyLines.filter((l) => l.item.trim() || l.amount.trim() || l.memo.trim()).map((l) => ({ qty: 1, unitPriceCents: parse(l.amount) ?? 0, itemName: l.item.trim(), memo: l.memo.trim() || undefined })), memo: memo || undefined,
      settleBy: canSettle ? settleBy : null,
      settlements: canSettle && settleBy !== 'amount'
        ? Object.entries(alloc).filter(([, v]) => v.trim() !== '' && (parse(v) ?? 0) > 0).map(([k, v]) => { const [d, pr] = k.split(':'); return { sourceDocId: Number(d), productId: pr ? Number(pr) : null, amountCents: parse(v) ?? 0 }; })
        : null,
    };
  };
  let total = 0, gross = 0;
  try { const b = body(); total = def.bank === 'transfer' && moneyCents > 0 ? moneyCents : docTotal(def, b); gross = def.lines === 'product' ? grossTotal(b) : total; } catch { total = 0; }
  const discountC = (() => { try { return def.lines === 'product' ? parse(discount) ?? 0 : 0; } catch { return 0; } })();
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
  const dirty = !doc && !!(party.id || memo || paid || discount || moneyLines.some((l) => l.item || l.amount) || docNo || lines.some((l) => l.productId || l.feeItemId || l.price) || outs.length || ins.length);
  useUnsavedWarning(!!inline && dirty);
  const goodsLines = lines.filter((l) => l.productId);
  const qtyTotal = goodsLines.reduce((sum, l) => sum + (Number(l.qty) || 0), 0);
  const bankBal = bank.id ? balances.get(bank.id) : undefined;
  const bankDelta = def.bank === 'out' || (def.settle === 'out') ? -(def.lines ? paidC : (Number(amount) ? Math.round(Number(amount) * 100) : 0)) : (def.lines ? paidC : (Number(amount) ? Math.round(Number(amount) * 100) : 0));
  const bankAfter = bankBal !== undefined && bankDelta !== 0 ? bankBal + bankDelta : null;
  const origExcess = origQty.map((o) => { const back = lines.filter((l) => l.productId === o.productId).reduce((x, l) => x + (Number(l.qty) || 0), 0); return back - o.qty > 1e-9 ? `${o.name}：退 ${back} > 原单 ${o.qty}` : ''; }).filter(Boolean);
  // 选了“全款/用预收预付结算”后，改明细金额时收付款金额跟着变
  useEffect(() => {
    if (payMode === 'full') setPaid(centsToYuan(total));
    else if (payMode === 'offset') setOffset(centsToYuan(total));
  }, [total, payMode]);
  const restLabel = def.settle === 'in' ? (type === 'purchase-return' ? '还没退回' : '欠款（挂应收）') : type === 'sale-return' ? '暂未退款（冲客户欠款）' : type === 'purchase-in' ? '欠款（挂应付）' : type === 'expense' ? '欠款（挂应付）' : '未结清';

  const pickMode = (m: PayMode) => {
    setPayMode(m);
    if (m === 'full') { setPaid(centsToYuan(total)); setOffset(''); }
    else if (m === 'credit') { setPaid(''); setOffset(''); }
    else if (m === 'offset') { setPaid(''); setOffset(centsToYuan(total)); }
  };

  const reset = () => {
    setDocNo(''); setParty({ id: null, name: '' }); setWh({ id: null, name: '' }); setBank({ id: null, name: '' }); setToBank({ id: null, name: '' }); setRefNo('');
    setOuts([]); setIns([]); setMoneyLines([emptyMoney()]); setOffset(''); setPaid(''); setDiscount(''); setPayMode(''); setMemo(''); setLines(def.lines ? emptyLines(3) : []); setVouchers([]); setVouchersDirty(false); setError(''); setAlloc({});
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
        const warn = [bankAfter !== null && bankAfter < 0 ? `注意：${bank.name} 余额不足，${def.bank === 'in' ? '' : '付后'}余额约 ${money(bankAfter)}。` : '', origExcess.length ? `注意：退货数量超过原单（${origExcess.join('；')}）。` : '', partyBalance?.creditLimitCents != null && partyBalance.receivableCents + Math.max(rest, 0) > partyBalance.creditLimitCents && def.settle === 'in' && def.lines === 'product' ? `注意：挂账后应收超过赊销额度 ${money(partyBalance.creditLimitCents)}。` : ''].filter(Boolean);
        const text = `${party.name ? `${ui.partyLabel.replace('（选填）', '')}：${party.name}\n` : ''}${def.lines ? `明细 ${b.lines.length} 行，` : ''}${ui.totalLabel}：${money(total)}${discountC ? `（已优惠 ${money(discountC)}）` : ''}\n${warn.length ? `${warn.join('\n')}\n` : ''}${then === 'post' ? '过账后会动账和库存，只能红冲，请核对。' : '开立后可再过账。'}`;
        if (!window.confirm(`${then === 'post' ? '确认过账？' : '确认开立？'}\n${text}`)) { setBusy(false); return; }
      }
      let saved = doc ? await financeApi.update(doc.id, b) : await financeApi.create(b);
      if (def.store && (vouchersDirty || (vouchers.length > 0 && !doc))) await sessionApi.bindVouchers(saved.id, vouchers.map((v) => v.id));
      if (then === 'issue') saved = await financeApi.issue(saved.id);
      if (then === 'post') saved = await financeApi.post(saved.id);
      if (inline && !doc) { reset(); setNotice(`已保存 ${saved.docNo}（${then === 'post' ? '已过账' : then === 'issue' ? '已开立' : '草稿'}），可以接着开下一张`); setBalanceTick((t) => t + 1); }
      setBusy(false);
      onSaved(saved, then === 'post' ? 'posted' : then === 'issue' ? 'issued' : 'draft');
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : '保存失败');
      setBusy(false);
    }
  };

  const addLine = () => setLines((ls) => [...ls, emptyLine()]);
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
  /** 选了商品：单位按商品档案的规格单位带出（可再改） */
  const pickUnit = async (i: number, id: number) => {
    try {
      const r = await resourceApi.get('finance-products', id);
      const u = String(r?.data?.specUnit ?? '').trim();
      if (u) setLines((ls) => ls.map((l, k) => (k === i && l.productId === id && !l.unit ? { ...l, unit: u } : l)));
    } catch { /* 取不到单位不影响开单 */ }
  };
  const pickProduct = (i: number, id: number | null, name: string) => { setLine(i, { productId: id, productName: name, ...(id ? {} : { unit: '' }) }); if (id) void pickUnit(i, id); };
  const moneyItem = ui.moneyItemLabel ?? '项目';
  const parsedCount = lines.filter((l) => l.productId || l.feeItemId || l.price).length;
  const settleTitle = def.settle === 'in' && type !== 'purchase-return' ? '收款情况' : def.settle === 'out' && type !== 'sale-return' ? '付款情况' : def.settle ? '退款情况' : def.bank === 'in' ? '收款情况' : def.bank === 'out' ? '付款情况' : '转款情况';

  const doPrint = () => {
    const rowsOut = def.lines
      ? lines.filter((l) => l.productId || l.feeItemId).map((l, i) => [String(i + 1), l.productName || l.feeItemName, l.unit, l.qty, money(l.gift ? 0 : priceOf(l.price)), money(lineAmount({ qty: Number(l.qty) || 0, unitPriceCents: l.gift ? 0 : priceOf(l.price) })), l.memo])
      : moneyLines.filter((l) => l.item || l.amount).map((l, i) => [String(i + 1), l.item, '', '1', l.amount, l.amount, l.memo]);
    const ok = printSlip({
      title: `${def.label}${doc ? ` ${doc.docNo}` : '（未保存）'}`,
      head: [['日期', date], ...(def.party ? [[ui.partyLabel.replace('（选填）', ''), party.name] as [string, string]] : []), ...(def.warehouse ? [['仓库', wh.name] as [string, string]] : []), ['经办人', handler], ['结算账户', bank.name]],
      columns: ['#', def.lines === 'fee' ? '费用项目' : '商品/项目', '单位', '数量', '单价', '金额', '备注'],
      rows: rowsOut,
      totals: [...(discountC ? [['明细合计', money(gross)] as [string, string], ['优惠', money(discountC)] as [string, string]] : []), [ui.totalLabel, money(total)], ...(def.settle ? [[ui.amountLabel, money(paidC)] as [string, string]] : [])],
      memo: memo,
    });
    if (!ok) setError('浏览器拦截了打印窗口，请允许弹出窗口后重试');
  };

  // 快捷键（只在制单中心整页开单时生效）：Ctrl+G 保存草稿 · F8 过账 · Ctrl+F9 打印 · Ctrl+F8 回到明细
  const act = useRef({ save, doPrint });
  act.current = { save, doPrint };
  useEffect(() => {
    if (!inline) return undefined;
    const on = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'g') { e.preventDefault(); void act.current.save(null); }
      else if (e.key === 'F8' && !e.ctrlKey) { e.preventDefault(); if (can('finance.docs.post')) void act.current.save(null, 'post'); }
      else if (e.key === 'F9' && e.ctrlKey) { e.preventDefault(); act.current.doPrint(); }
      else if (e.key === 'F8' && e.ctrlKey) { e.preventDefault(); gridRef.current?.querySelector<HTMLElement>('input, select')?.focus(); }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [inline, can]);

  const content = (
    <div className="slip-cols">
      <div className="slip-main">
      <p className="muted slip-hint">过账结果：{def.posting}</p>
      <h3 className="section-title"><span className="step">1</span>单据信息</h3>
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
        {def.party && party.id && <div className="slip-wide"><PartyBalanceBar balance={partyBalance} extraReceivable={def.settle === 'in' && def.lines === 'product' ? Math.max(rest, 0) : 0} /></div>}
        {origin && partyKind === origin.kind && (
          <div className="slip-orig">
            <label>关联{origin.label}（选填，用于对照退货数量）
              <select aria-label={`关联${origin.label}`} value={origId} disabled={!party.id} onChange={(e) => setOrigId(e.target.value)}>
                <option value="">{party.id ? (origSales.length ? '不关联原单' : `该${PARTY_KIND_LABEL[origin.kind]}暂无已过账的${origin.label}`) : `请先选择${PARTY_KIND_LABEL[origin.kind]}`}</option>
                {origSales.map((o) => <option key={o.id} value={o.id}>{o.docNo} · {o.docDate} · {money(o.amountCents)}</option>)}
              </select>
            </label>
            <button type="button" className="secondary-button" disabled={!origId} onClick={() => void importOriginal()}>带入原单明细</button>
            {origNote && <span className="muted">{origNote}</span>}
            {origExcess.length > 0 && <p role="alert" className="notice warn">退货数量超过{origin.label}：{origExcess.join('；')}</p>}
          </div>
        )}
        {def.store && <label>店铺 *<SearchPick ariaLabel="店铺" type="stores" value={store.id} label={store.name} onChange={(id, name) => setStore({ id, name })} /></label>}
        {def.store && <label>平台提现流水号 *<input aria-label="平台提现流水号" value={refNo} maxLength={80} onChange={(e) => setRefNo(e.target.value)} placeholder="平台后台提现记录里的流水号，不能重复" /></label>}
        {def.warehouse
          ? <label>{ui.warehouseLabel} *<SearchPick ariaLabel="仓库" type="finance-warehouses" value={wh.id} label={wh.name} onChange={(id, name) => setWh({ id, name })} /></label>
          : <label>归属部门<input aria-label="归属部门" value={department} maxLength={60} onChange={(e) => setDepartment(e.target.value)} /></label>}
        <label>经办人<input aria-label="经办人" value={handler} maxLength={60} onChange={(e) => setHandler(e.target.value)} /></label>
      </section>

      {def.bank === 'transfer' && <TransferPanel outs={outs} ins={ins} setOuts={setOuts} setIns={setIns} balances={balances} />}

      {def.lines && (
        <section>
          <h3 className="section-title"><span className="step">2</span>{ui.detailTitle}</h3>
          <GoodsGrid def={def} type={type} lines={lines} setLines={setLines} setLine={setLine} priceOf={priceOf} hints={hints} onPickProduct={pickProduct} onPickFee={pickFee} addRow={addLine} gridRef={gridRef} />
          <div className="vc-grid-foot">
            <button type="button" className="secondary-button small" onClick={addLine}>+ 加一行</button>
            <span className="muted">{def.lines === 'product' ? `共 ${goodsLines.length} 种商品 · 数量合计 ${Number(qtyTotal.toFixed(4))}　` : ''}回车跳到下一格，最后一格回车加行；Shift+Delete 删当前行</span>
            <span className="vc-grid-total">{def.lines === 'product' && discountC > 0 ? `明细合计 ${money(gross)} − 优惠 ${money(discountC)} = ` : ''}{ui.totalLabel}　<b>{money(total)}</b></span>
          </div>
          {def.lines === 'product' && (
            <label className="vc-discount">整单优惠 / 抹零（元）
              <input inputMode="decimal" aria-label="优惠金额" value={discount} onChange={(e) => setDiscount(e.target.value)} placeholder="没有就留空；优惠后才是应收/应付金额" />
            </label>
          )}
        </section>
      )}

      {!def.lines && (
        <section>
          <h3 className="section-title"><span className="step">2</span>{ui.detailTitle}</h3>
          <MoneyGrid type={type} label={moneyItem} lines={moneyLines} setLines={setMoneyLines} gridRef={gridRef} />
          <div className="vc-grid-foot">
            <button type="button" className="secondary-button small" onClick={() => setMoneyLines((ls) => [...ls, emptyMoney()])}>+ 加一行</button>
            <span className="muted">回车跳到下一格，最后一格回车加行；Shift+Delete 删当前行</span>
            <span className="vc-grid-total">{ui.totalLabel}　<b>{money(moneyCents)}</b></span>
          </div>
        </section>
      )}

      </div>
      <aside className="slip-side" aria-label="单据功能区">
      <div className="slip-total-card"><span className="muted">{ui.totalLabel}</span><b>{money(total)}</b>{def.lines && <span className="muted">共 {parsedCount} 行{discountC > 0 ? ` · 已优惠 ${money(discountC)}` : ''}</span>}</div>
      <section className="slip-settle">
        <h3 className="section-title"><span className="step">3</span>{settleTitle}</h3>
        {def.settle && (
          <div className="pay-modes" role="group" aria-label="结算方式">
            {ui.payModes.map((m) => <button key={m.mode} type="button" className={`mode-button${payMode === m.mode ? ' active' : ''}`} aria-pressed={payMode === m.mode} onClick={() => pickMode(m.mode)}>{m.label}</button>)}
          </div>
        )}
        <div className="form-grid">
          {!def.lines && def.bank !== 'transfer' && <p className="muted" aria-label="金额汇总">{ui.amountLabel}：<b>{money(moneyCents)}</b>（等于上面明细合计）</p>}
          {def.settle && <label>{ui.amountLabel}（元）<input inputMode="decimal" aria-label={ui.amountLabel} value={paid} onChange={(e) => { setPaid(e.target.value); setPayMode('part'); }} placeholder={def.lines === 'fee' ? '不填 = 当场付清/收齐' : '0.00'} /></label>}
          {(def.bank === 'in' || def.bank === 'out' || def.settle) && def.bank !== 'transfer' && <label>{ui.accountLabel} *<SearchPick ariaLabel={ui.accountLabel} type="bank-accounts" value={bank.id} label={bank.name} onChange={(id, name) => setBank({ id, name })} /></label>}
          {type === 'online-sale' && <label>平台佣金率（%，仅估算，不入账）<input inputMode="decimal" aria-label="平台佣金率" value={feeRate} onChange={(e) => setFeeRate(e.target.value)} placeholder="如 0.6" /></label>}
          {!def.store && hasBankRef(def) && <label>银行流水号<input aria-label="银行流水号" value={refNo} maxLength={80} onChange={(e) => setRefNo(e.target.value)} placeholder="选填；银行回单上的流水号" /></label>}
          {def.offset && <label>冲抵{ACCOUNT_LABEL[def.offset]}（元）<input inputMode="decimal" aria-label="冲抵金额" value={offset} onChange={(e) => setOffset(e.target.value)} placeholder="不冲抵就留空" /></label>}
        </div>
        {def.offset && partyBalance && (() => { const have = def.offset === 'advance_receipt' ? partyBalance.advanceReceiptCents : partyBalance.prepaymentCents; return <p className="muted vc-offset-hint">{party.name} 现有{ACCOUNT_LABEL[def.offset]} <b>{money(have)}</b>{offsetC > have ? <span className="vc-bad">（冲抵 {money(offsetC)} 超过余额，过账会被拒）</span> : ''}</p>; })()}
        {type === 'online-sale' && Number(feeRate) > 0 && total > 0 && <p className="muted">预估平台费 <b>{money(Math.round(total * Number(feeRate) / 100))}</b>，预计净到账 <b>{money(total - Math.round(total * Number(feeRate) / 100))}</b></p>}
        {canSettle && (
          <SettleBySection type={type} settleBy={settleBy} setSettleBy={setSettleBy} hasParty={!!party.id} open={open} alloc={alloc} setAlloc={setAlloc} clearAlloc={() => setAlloc({})} allocated={allocated} settleTotal={settleTotal} autoAlloc={autoAlloc} />
        )}
        {bankBal !== undefined && bank.id && (
          <p className="muted" aria-label="账户余额预览">账户当前余额 <b className={bankBal < 0 ? 'neg' : ''}>{money(bankBal)}</b>{bankAfter !== null && <> → 本单{def.bank === 'in' || def.settle === 'in' ? '到账' : '支出'}后约 <b className={bankAfter < 0 ? 'neg' : ''}>{money(bankAfter)}</b>{bankAfter < 0 ? '（预计为负，请确认账户或金额）' : ''}</>}　<small>仅供参考，以过账后实际余额为准</small></p>
        )}
        {def.settle && def.lines && total > 0 && paidC > 0 && paidC !== total && (
          <p className={`notice ${paidC > total ? 'warn' : ''}`} role="status">{paidC > total ? `${ui.amountLabel}比本单金额多 ${money(paidC - total)}，请确认` : `本单还差 ${money(total - paidC - offsetC)} 未结清（将挂${def.settle === 'in' ? '应收' : '应付'}）`}</p>
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
      <div ref={noticeRef}>
        {notice && <div role="status" className="notice ok">{notice}</div>}
        {error && <div role="alert" className="notice error">{error}</div>}
      </div>
      </aside>
    </div>
  );

  const buttons = (
    <>
      {!inline && <button type="button" className="secondary-button" onClick={onClose}>取消</button>}
      <button type="submit" className="secondary-button" disabled={busy}>{inline ? '保存草稿' : '存为草稿'}</button>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => save(null, 'issue')}>保存并开立</button>
      {can('finance.docs.post') && <button type="button" className="primary-button" disabled={busy} onClick={() => save(null, 'post')}>{ui.saveText.replace('保存', '保存并过账')}</button>}
    </>
  );

  if (inline) {
    return (
      <form className="card slip vc-slip" aria-label={`${def.label}开单`} onSubmit={(e) => save(e)}>
        <div className="slip-title"><strong>{def.label} / 手工开单</strong>{doc && <span className="vc-editing">正在编辑草稿 {doc.docNo}</span>}</div>
        <div className="slip-toolbar-row"><VoucherToolbar type={type} busy={busy} editing={!!doc}
          onClear={() => { if (doc) onClose?.(); else reset(); }} onPrint={doPrint} onList={() => onShowList?.()} onPickDraft={(id) => onPickDraft?.(id)} />
          <span className="vc-keys muted">Ctrl+G 保存草稿 · F8 过账 · Ctrl+F9 打印 · Ctrl+F8 回到明细</span></div>
        <div className="slip-body">{content}</div>
        <div className="slip-foot"><div className="slip-foot-total"><span className="muted">{ui.totalLabel}</span> <b>{money(total)}</b></div>{buttons}</div>
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
