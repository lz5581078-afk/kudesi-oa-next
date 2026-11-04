import { FormEvent, Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { unitOptionFromText, unitYuanText, yuanToPreciseCents, ACCOUNT_LABEL, DOC_TYPE_MAP, FEE_BOOKING_NODE_MAP, PARTY_KIND_LABEL, PARTY_KIND_RESOURCE, SETTLEMENT_DOC_TYPES, docTotal, grossTotal, hasBankRef, hasMoneyDiscount, lineAmount, payRole, todayInChina as today, validateDoc, type DocType, type PartyKind, type PayMode, type SettleBy } from '@kudesi/shared';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { resourceApi } from '../../resources/api';
import { ReferencePickContext, SearchPick, centsToYuan, money, yuanToCents } from './common';
import { useUnsavedWarning } from './fin-ui';
import { financeApi, type DocDetailDto, type OpenItem } from './financeApi';
import { sessionApi, type VoucherFile } from './sessionApi';
import { VoucherPanel } from './VoucherPanel';
import { GoodsGrid } from './voucher/GoodsGrid';
import { HandlerSelect, type StaffOption } from './voucher/HandlerSelect';
import { PayAccounts } from './voucher/PayAccounts';
import { TransferFee } from './voucher/TransferFee';
import { MoneyGrid } from './voucher/MoneyGrid';
import { PartyBalanceBar } from './voucher/PartyBalanceBar';
import { SettleBySection } from './voucher/SettleBySection';
import { TransferPanel } from './voucher/TransferPanel';
import { VoucherToolbar } from './voucher/VoucherToolbar';
import { printSlip } from './voucher/printSlip';
import { emptyLine, emptyLines, emptyMoney, type AcctState, type LineState, type MoneyLine } from './voucher/types';
import { useLineHints, usePartyBalance } from './voucher/useVoucherHints';
import './referenceVoucherShell.css';
import {ReferenceVoucherPayment,ReferenceVoucherNote,ReferenceVoucherHeading} from './ReferenceVoucherPayment';
import './referenceVoucherHead.css';
import './referenceVoucherLines.css';
import {ReferenceTransferFields,ReferenceTransferSummary} from './ReferenceTransferFields';

const sourcePartyPlaceholder:Partial<Record<DocType,string>>={sale:'客户名称','online-sale':'选择店铺','sale-return':'客户名称','advance-receipt':'客户名称',receipt:'客户名称',payment:'供应商、客户、人员等',prepayment:'供应商名称','purchase-in':'供应商名称','purchase-return':'供应商名称','other-income':'平台、供应商、人员或其他来源'};

const sourceLineTotalLabel:Partial<Record<DocType,string>>={sale:'商品合计金额：','online-sale':'商品合计金额：','sale-return':'退货合计金额：','advance-receipt':'预收合计金额：',receipt:'收款合计金额：',payment:'付款合计金额：',prepayment:'预付合计金额：','purchase-in':'采购合计金额：','purchase-return':'退货合计金额：','other-income':'收入合计金额：',expense:'费用合计金额：',transfer:'转款合计金额：'};

const sourceAmountFollowsTotal=(type:DocType,mode:PayMode|'')=>mode==='full'||mode==='part'&&(type==='receipt'||type==='advance-receipt');
const sourceAmountStartsAtZero=(type:DocType,mode:PayMode)=>mode==='debt'||mode==='credit'&&type!=='sale-return';

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
function DocumentHeadCard({ reference, children }: { reference: boolean; children: ReactNode }) { return reference ? <section className="reference-document-head-card">{children}</section> : <Fragment>{children}</Fragment>; }
function PartyField({reference,children}:{reference:boolean;children:ReactNode}){return reference?<div className="slip-party slip-party-field">{children}</div>:<label className="slip-party">{children}</label>;}

export function DocForm(props: Props) {
  const {user}=useAuth();
  return <DocumentForm key={props.type==='withdrawal'?undefined:JSON.stringify([props.type,props.doc?.id,user?.companyId,user?.id,user?.permissions])} {...props}/>;
}
function DocumentForm({ type, doc, preset, inline, onClose, onSaved, onPickDraft, onShowList }: Props) {
  const mounted=useRef(false),saving=useRef(false),savedDraft=useRef<DocDetailDto|null>(null);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const def = DOC_TYPE_MAP.get(type)!;
  const { can, user } = useAuth();
  const [staff,setStaff]=useState<StaffOption[]>([]);
  useEffect(()=>{let alive=true;Promise.resolve().then(()=>resourceApi.users()).then(rows=>{if(alive)setStaff(Array.isArray(rows)?rows:[]);}).catch(()=>undefined);return()=>{alive=false;};},[]);
  const ui = def.ui;
  const sourceInline=!!inline&&type!=='withdrawal';
  const originalFields=sourceInline&&!doc;
  const sourceTransfer=originalFields&&type==='transfer';
  const [resetVersion,setResetVersion]=useState(0);
  const hasPayment = !!def.settle || !!def.moneySettlement;
  const structuredLines = !!def.lines && !ui.moneyEntry;
  const kinds = def.partyKinds;
  const initial = useMemo(() => ({ date: doc?.docDate ?? today() }), [doc]);
  const [date, setDate] = useState(initial.date);
  const [docNo, setDocNo] = useState(doc?.docNo ?? '');
  const [partyKind, setPartyKind] = useState<PartyKind>((doc?.partyKind as PartyKind | null) ?? kinds[0] ?? 'customer');
  const [party, setParty] = useState<{ id: number | null; name: string }>({ id: doc?.partyId ?? null, name: doc?.linkedPartyName ?? doc?.partyName ?? '' });
  const [wh, setWh] = useState<{ id: number | null; name: string }>({ id: doc?.warehouseId ?? null, name: doc ? doc.warehouseName : def.warehouse ? '总仓' : '' });
  const [bank, setBank] = useState<{ id: number | null; name: string }>({ id: doc?.bankAccountId ?? null, name: doc?.bankName ?? '' });
  const [toBank, setToBank] = useState<{ id: number | null; name: string }>({ id: doc?.toBankAccountId ?? null, name: doc?.toBankName ?? '' });
  const [store, setStore] = useState<{ id: number | null; name: string }>({ id: doc?.storeId ?? preset?.storeId ?? null, name: doc?.storeName ?? preset?.storeName ?? '' });
  const [refNo, setRefNo] = useState(doc?.refNo ?? '');
  // 经手人：员工选择器，保存员工 id；老单据只有文字时作为“原文字”选项保留
  const [handlerId, setHandlerId] = useState<number | null>(doc ? doc.handlerId ?? null : type === 'withdrawal' ? user?.id ?? null : null);
  const [handlerName, setHandlerName] = useState(type === 'withdrawal' ? doc?.handlerId ? doc.handler ?? '' : user?.name ?? '' : doc?.handler ?? '');
  const [handlerLegacy, setHandlerLegacy] = useState(doc && !doc.handlerId ? doc.handler ?? '' : '');
  const [department, setDepartment] = useState(doc?.department ?? (sourceTransfer||def.warehouse ? '' : '财务部'));
  const [moneyLines, setMoneyLines] = useState<MoneyLine[]>(() => {
    if (structuredLines) return [];
    if (doc?.lines.length) return doc.lines.map((l) => ({ item: l.itemName || l.feeItemName || '', amount: centsToYuan(lineAmount(l)), memo: l.memo ?? '', original: { feeItemId: l.feeItemId, relatedNode: l.relatedNode, relatedId: l.relatedId, relatedName: l.relatedName } }));
    if (doc && doc.amountCents) return [{ item: '', amount: centsToYuan(doc.amountCents), memo: '' }];
    return [emptyMoney()];
  });
  const moneyCents = moneyLines.reduce((sum, l) => { const c = yuanToCents(l.amount); return sum + (c && !Number.isNaN(c) ? c : 0); }, 0);
  const amount = moneyCents ? centsToYuan(moneyCents) : '';
  const [offset, setOffset] = useState(doc?.offsetCents ? centsToYuan(doc.offsetCents) : '');
  const [paid, setPaid] = useState(doc && def.moneySettlement && !doc.settlementMode ? centsToYuan(doc.amountCents) : doc?.settlementMode ? centsToYuan(doc.paidCents) : doc?.paidCents ? centsToYuan(doc.paidCents) : '');
  const [discount, setDiscount] = useState(doc?.discountCents ? centsToYuan(doc.discountCents) : '');
  const [payMode, setPayMode] = useState<PayMode | ''>(doc ? doc.settlementMode ?? (def.moneySettlement ? 'full' : doc.paidCents || doc.offsetCents ? 'part' : 'credit') : ui.payModes[0]?.mode ?? '');
  const [memo, setMemo] = useState(doc?.memo ?? '');
  const [counterpartyName, setCounterpartyName] = useState(doc?.counterpartyName ?? doc?.partyName ?? '');
  const [summary, setSummary] = useState(doc?.summary ?? '');
  const freshLines = () => emptyLines(1).map(row => def.lines === 'product' ? { ...row, qty: '', unit: '件' } : row);
  const [lines, setLines] = useState<LineState[]>(
    structuredLines && doc?.lines.length
      ? doc.lines.map((l) => ({ unit: l.unit ?? '', productId: l.productId ?? null, productName: l.productName, feeItemId: l.feeItemId ?? null, feeItemName: l.feeItemName, qty: ui.feeAmountOnly ? '1' : String(l.qty), price: ui.feeAmountOnly ? centsToYuan(lineAmount(l)) : unitYuanText(l.unitPriceCents), memo: l.memo ?? '', gift: !!l.productId && l.unitPriceCents === 0, node: l.relatedNode ?? '', relatedId: l.relatedId ?? null, relatedName: l.relatedName ?? '', needObject: false }))
      : structuredLines ? freshLines() : [],
  );
  const toAccts = (role: 'out' | 'in'): AcctState[] => (doc?.accounts ?? []).filter((a) => a.role === role).map((a) => ({ id: a.bankAccountId, name: a.bankName, amount: centsToYuan(a.amountCents) }));
  const [outs, setOuts] = useState<AcctState[]>(() => (doc?.accounts?.length ? toAccts('out') : doc?.bankAccountId && doc.docType === 'transfer' ? [{ id: doc.bankAccountId, name: doc.bankName, amount: centsToYuan(doc.amountCents) }] : []));
  const [ins, setIns] = useState<AcctState[]>(() => (doc?.accounts?.length ? toAccts('in') : doc?.toBankAccountId ? [{ id: doc.toBankAccountId, name: doc.toBankName, amount: centsToYuan(doc.amountCents) }] : []));
  // 多账户收付款：一笔钱分几个账户收/付（转款单有自己的转出/转入账户）
  const payDir = def.bank === 'transfer' ? null : payRole(def);
  const [multiOn, setMultiOn] = useState(!!payDir && !!doc?.accounts?.length);
  const [multi, setMulti] = useState<AcctState[]>(() => (payDir && doc?.accounts?.length ? doc.accounts.map((a) => ({ id: a.bankAccountId, name: a.bankName, amount: centsToYuan(a.amountCents) })) : []));
  const multiCents = multi.reduce((s, a) => s + (yuanToCents(a.amount) || 0), 0);
  // 转款手续费与在途
  const [fee, setFee] = useState(doc?.feeCents ? centsToYuan(doc.feeCents) : '');
  const [feeBearer, setFeeBearer] = useState<'out' | 'in'>(doc?.feeBearer ?? 'out');
  const [inTransit, setInTransit] = useState(!!doc?.transitStatus);
  const canSettle = SETTLEMENT_DOC_TYPES.includes(type);
  const [settleBy, setSettleBy] = useState<SettleBy>((doc?.settleBy as SettleBy | null) ?? 'amount');
  const [alloc, setAlloc] = useState<Record<string, string>>(() => Object.fromEntries((doc?.settlements ?? []).map((x) => [x.productId ? `${x.sourceDocId}:${x.productId}` : `${x.sourceDocId}`, centsToYuan(x.amountCents)])));
  const [open, setOpen] = useState<OpenItem[]>([]);
  const [feeRate, setFeeRate] = useState('');

  // 退货关联原单：选了往来对象后列出他已过账的原单，可关联并带入明细、对照退货数量
  const origin = ORIGIN[type];
  const [origSales, setOrigSales] = useState<Array<{ id: number; docNo: string; docDate: string; amountCents: number }>>([]);
  const [origId, setOrigId] = useState('');
  const [origNote, setOrigNote] = useState('');
  const [origQty, setOrigQty] = useState<Array<{ productId: number; name: string; qty: number }>>([]);
  const originImport=useRef(0);
  useEffect(()=>{originImport.current++;},[origId]);
  useEffect(() => {
    originImport.current++;
    setOrigId(''); setOrigNote(''); setOrigSales([]); setOrigQty([]);
    if (originalFields || !origin || partyKind !== origin.kind || !party.id || !party.name) return;
    let alive = true;
    financeApi.docs({ scope: origin.scope, status: 'posted', keyword: party.name })
      .then((r) => alive && setOrigSales(r.rows.filter((x) => x.partyName === party.name).map((x) => ({ id: x.id, docNo: x.docNo, docDate: x.docDate, amountCents: x.amountCents }))))
      .catch(() => alive && setOrigNote(`没有权限查看${origin.label}，不能关联`));
    return () => { alive = false; originImport.current++; };
  }, [origin, partyKind, party.id, party.name,originalFields]);
  async function importOriginal() {
    if (!origId) return;
    const serial=++originImport.current,current=()=>mounted.current&&originImport.current===serial;
    try {
      const d = await financeApi.doc(Number(origId));
      if(!current())return;
      if(!origin||d.docType!==origin.scope||d.status!=='posted'||d.partyKind!==origin.kind||d.partyId!==party.id){setOrigNote('原单不属于当前往来对象或已不是已过账单据，请重新选择。');return;}
      const goods = d.lines.filter((l) => l.productId && l.qty > 0);
      if (!goods.length) { setOrigNote('该单据没有商品明细，无法带入'); return; }
      if (lines.some((l) => l.productId || l.price) && !window.confirm('当前已填写的退货商品会被原单的商品替换，数量默认为原单全部数量，可再修改。')) return;
      setOrigQty(goods.map((l) => ({ productId: l.productId as number, name: l.productName, qty: l.qty })));
      setLines(goods.map((l) => ({ ...emptyLine(), unit: l.unit ?? '', productId: l.productId ?? null, productName: l.productName, qty: String(l.qty), price: unitYuanText(l.unitPriceCents) })));
      setOrigNote(`已带入 ${goods.length} 种商品，数量默认为原单全部数量，请改成实际退回数量`);
    } catch { if(current())setOrigNote('原单明细加载失败，请稍后重试'); }
  }

  const [balances, setBalances] = useState<Map<number, number>>(new Map());
  const needBalance = def.bank !== 'none' || !!def.settle;
  useEffect(() => { if (needBalance&&!originalFields) financeApi.banks().then((r) => setBalances(new Map(r.map((b) => [b.id, b.balanceCents])))).catch(() => undefined); }, [needBalance,originalFields]);
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
    if (originalFields || !canSettle || settleBy === 'amount' || !party.id) { setOpen([]); return; }
    financeApi.openItems({ dir: type === 'receipt' ? 'in' : 'out', partyKind, partyId: party.id }).then(setOpen).catch(() => setOpen([]));
  }, [canSettle, settleBy, party.id, partyKind, type,originalFields]);

  const [balanceTick, setBalanceTick] = useState(0);
  const partyBalance = usePartyBalance(!originalFields&&def.party ? partyKind : null, originalFields?null:party.id, balanceTick);
  const hints = useLineHints(!originalFields&&def.lines === 'product' ? lines.map((l) => l.productId).filter((x): x is number => !!x) : [], wh.id, def.warehouse ? wh.name : undefined);

  const parse = (t: string) => { const v = yuanToCents(t); if (Number.isNaN(v)) throw new Error('金额格式不对（最多两位小数）'); return v; };
  const priceOf = (t: string) => { const v = unitPriceOf(t); return typeof v === 'number' && !Number.isNaN(v) ? v : 0; };
  const body = () => {
    const parsedLines = lines
      .filter((l) => !(inline && !doc && !l.productId && !l.feeItemId && !l.price)) // 开单页预留的空行不算
      .map((l) => ({ productId: l.productId, feeItemId: l.feeItemId, qty: ui.feeAmountOnly ? 1 : Number(l.qty), unitPriceCents: ui.feeAmountOnly ? parse(l.price) ?? 0 : l.gift ? 0 : (() => { const v = unitPriceOf(l.price); if (Number.isNaN(v)) throw new Error('单价格式不对（最多六位小数）'); return v ?? 0; })(), memo: l.memo || undefined, unit: l.unit.trim() || null, relatedNode: l.node || null, relatedId: l.relatedId, relatedName: l.relatedId ? null : l.relatedName.trim() || null }));
    const accounts = def.bank === 'transfer'
      ? [...outs.map((a) => ({ role: 'out' as const, bankAccountId: a.id, amountCents: parse(a.amount) ?? 0 })), ...ins.map((a) => ({ role: 'in' as const, bankAccountId: a.id, amountCents: parse(a.amount) ?? 0 }))]
      : multiOn && payDir ? multi.map((a) => ({ role: payDir, bankAccountId: a.id, amountCents: parse(a.amount) ?? 0 })) : null;
    const feeC = def.bank === 'transfer' ? parse(fee) ?? 0 : 0;
    const sourceOffset=originalFields&&payMode==='offset';
    return {
      ...(type === 'expense' ? { counterpartyName, summary } : {}), accounts, type, date, settlementMode: type !== 'withdrawal' ? payMode || null : null, docNo: docNo.trim() || null, partyId: party.id, partyKind: def.party ? partyKind : null, bankAccountId: multiOn && multi[0] ? multi[0].id : bank.id, toBankAccountId: toBank.id, warehouseId: wh.id, ...(def.warehouse ? { warehouseName: wh.name } : {}),
      feeCents: feeC, feeBearer: feeC ? feeBearer : null, inTransit: def.bank === 'transfer' ? inTransit : false,
      storeId: def.store ? store.id : null, refNo: hasBankRef(def) ? refNo : null, amountCents: null, offsetCents: sourceOffset?parse(paid)??0:originalFields?0:parse(offset)??0,
      discountCents: def.lines === 'product' || hasMoneyDiscount(type) ? parse(discount) ?? 0 : 0,
      paidCents: sourceOffset?0:hasPayment ? (originalFields?parse(paid)??0:multiOn && payDir ? multiCents : parse(paid) ?? (def.lines === 'fee' && payMode === 'full' ? null : def.moneySettlement && payMode === 'full' ? moneyCents : 0)) : 0, handlerId, handler: handlerId ? null : handlerLegacy.trim() || null, department: department.trim() || null,
      lines: structuredLines ? parsedLines : moneyLines.filter((l) => l.item.trim() || l.amount.trim() || l.memo.trim()).map((l) => ({ ...l.original, qty: 1, unitPriceCents: parse(l.amount) ?? 0, itemName: l.item.trim(), memo: l.memo.trim() || undefined })), memo: memo || undefined,
      settleBy: canSettle ? settleBy : null,
      settlements: canSettle && settleBy !== 'amount'
        ? Object.entries(alloc).filter(([, v]) => v.trim() !== '' && (parse(v) ?? 0) > 0).map(([k, v]) => { const [d, pr] = k.split(':'); return { sourceDocId: Number(d), productId: pr ? Number(pr) : null, amountCents: parse(v) ?? 0 }; })
        : null,
    };
  };
  let total = 0, gross = 0;
  try { const b = body(); total = sourceTransfer?moneyCents:def.bank === 'transfer' && moneyCents > 0 ? moneyCents : docTotal(def, b); gross = def.lines === 'product' ? grossTotal(b) : total; } catch { total = 0; }
  const discountC = (() => { try { return def.lines === 'product' ? parse(discount) ?? 0 : 0; } catch { return 0; } })();
  /** 收款单/付款单的优惠金额：冲减往来余额、计入财务费用，不是单据金额的一部分 */
  const moneyDiscC = (() => { try { return hasMoneyDiscount(type) ? parse(discount) ?? 0 : 0; } catch { return 0; } })();
  const paidC = (() => { try { return originalFields&&payMode==='offset'?0:hasPayment ? (multiOn && payDir ? multiCents : parse(paid) ?? 0) : 0; } catch { return 0; } })();
  const offsetC = (() => { try { return originalFields?payMode==='offset'?parse(paid)??0:0:parse(offset) ?? 0; } catch { return 0; } })();
  const rest = total - paidC - (def.moneySettlement ? 0 : offsetC);
  const settleTotal = (() => { try { return (def.moneySettlement ? paidC : parse(amount) ?? 0) + offsetC + moneyDiscC; } catch { return 0; } })();
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
  const dirty = !doc && !!(party.id || counterpartyName || summary || memo || paid.trim() && Number(paid) !== 0 || discount || offset.trim() && Number(offset) !== 0 || moneyLines.some((l) => l.item || l.amount) || docNo || lines.some((l) => l.productId || l.feeItemId || l.price) || outs.length || ins.length || multi.length || fee || inTransit);
  useUnsavedWarning(!!inline && dirty);
  const goodsLines = lines.filter((l) => l.productId);
  const qtyTotal = goodsLines.reduce((sum, l) => sum + (Number(l.qty) || 0), 0);
  const bankBal = bank.id && !multiOn ? balances.get(bank.id) : undefined;
  const bankDelta = def.bank === 'out' || (def.settle === 'out') ? -(hasPayment ? paidC : (Number(amount) ? Math.round(Number(amount) * 100) : 0)) : (hasPayment ? paidC : (Number(amount) ? Math.round(Number(amount) * 100) : 0));
  const bankAfter = bankBal !== undefined && bankDelta !== 0 ? bankBal + bankDelta : null;
  const origExcess = origQty.map((o) => { const back = lines.filter((l) => l.productId === o.productId).reduce((x, l) => x + (Number(l.qty) || 0), 0); return back - o.qty > 1e-9 ? `${o.name}：退 ${back} > 原单 ${o.qty}` : ''; }).filter(Boolean);
  // 原开单按各方式带出金额；已存单据首次加载保留原实付及冲抵。
  const paymentSync=useRef<string>();
  useEffect(() => {
    const signature=JSON.stringify([type,total,payMode,originalFields]);
    if(paymentSync.current===signature)return;
    const initial=paymentSync.current===undefined;paymentSync.current=signature;
    if(initial&&doc)return;
    if (originalFields?sourceAmountFollowsTotal(type,payMode):payMode==='full') setPaid(originalFields?(total?String(total/100):''):centsToYuan(total));
    else if (!originalFields&&payMode === 'offset') setOffset(centsToYuan(total));
  }, [total, payMode,originalFields,type,doc]);
  const restLabel = def.moneySettlement ? '尚未实际收付金额' : def.settle === 'in' ? (type === 'purchase-return' ? '还没退回' : '欠款（挂应收）') : type === 'sale-return' ? '暂未退款（冲客户欠款）' : type === 'purchase-in' ? '欠款（挂应付）' : type === 'expense' ? '欠款（挂应付）' : '未结清';

  const pickMode = (m: PayMode) => {
    setPayMode(m);
    if(originalFields){setOffset('');if(sourceAmountFollowsTotal(type,m))setPaid(total?String(total/100):'');else if(sourceAmountStartsAtZero(type,m))setPaid('0');return;}
    if (multiOn && payDir) {
      // 分账户时：全款 = 把差额补进最后一个账户；欠款/用预收预付结算没有收付款账户，改回单账户
      if (m === 'full') { if (multi.length) { const last = multi[multi.length - 1]; const cur = yuanToCents(last.amount) || 0; setMulti(multi.map((x) => (x === last ? { ...x, amount: centsToYuan(Math.max(0, cur + total - multiCents)) } : x))); } setOffset(''); return; }
      if (m === 'part') return;
      setMultiOn(false);
    }
    if (m === 'full') { setPaid(centsToYuan(total)); setOffset(''); }
    else if (m === 'credit' || m === 'debt') { setPaid(''); setOffset(''); }
    else if (m === 'offset') { setPaid(''); setOffset(centsToYuan(total)); }
  };

  const reset = () => {
    savedDraft.current=null; setNotice(''); setResetVersion(value=>value+1);
    if (type !== 'withdrawal') {
      setDate(today()); setPartyKind(kinds[0] ?? 'customer'); setHandlerId(null); setHandlerName(''); setHandlerLegacy(''); setDepartment(sourceTransfer||def.warehouse ? '' : '财务部');
    }
    setDocNo(''); setParty({ id: null, name: '' }); setWh({ id: null, name: def.warehouse ? '总仓' : '' }); setBank({ id: null, name: '' }); setToBank({ id: null, name: '' }); setRefNo('');
    setOuts([]); setIns([]); setMulti([]); setMultiOn(false); setFee(''); setFeeBearer('out'); setInTransit(false); setMoneyLines([emptyMoney()]); setOffset(''); setPaid(''); setDiscount(''); setPayMode(ui.payModes[0]?.mode ?? ''); setMemo(''); setCounterpartyName(''); setSummary(''); setLines(structuredLines ? freshLines() : []); setVouchers([]); setVouchersDirty(false); setError(''); setAlloc({});
  };

  const save = async (e: FormEvent | null, then?: 'issue' | 'post') => {
    e?.preventDefault();
    if(saving.current)return; saving.current=true;
    const current=()=>mounted.current;
    setError(''); setNotice('');
    setBusy(true);
    try {
      const b = body();
      if (then) {
        if(sourceTransfer&&!b.lines.length)throw new Error('请至少填写一条金额明细');
        const errs = validateDoc(b, then);
        if (errs.length) throw new Error(errs.join('；'));
        const warn = [bankAfter !== null && bankAfter < 0 ? `注意：${bank.name} 余额不足，${def.bank === 'in' ? '' : '付后'}余额约 ${money(bankAfter)}。` : '', origExcess.length ? `注意：退货数量超过原单（${origExcess.join('；')}）。` : '', partyBalance?.creditLimitCents != null && partyBalance.receivableCents + Math.max(rest, 0) > partyBalance.creditLimitCents && def.settle === 'in' && def.lines === 'product' ? `注意：挂账后应收超过赊销额度 ${money(partyBalance.creditLimitCents)}。` : ''].filter(Boolean);
        const text = `${(type === 'expense' ? counterpartyName : party.name) ? `${ui.partyLabel.replace('（选填）', '')}：${type === 'expense' ? counterpartyName : party.name}\n` : ''}${def.lines ? `明细 ${b.lines.length} 行，` : ''}${ui.totalLabel}：${money(total)}${discountC ? `（已优惠 ${money(discountC)}）` : ''}\n${warn.length ? `${warn.join('\n')}\n` : ''}${then === 'post' ? '过账后会动账和库存，只能红冲，请核对。' : '开立后可再过账。'}`;
        if (!(sourceInline&&then==='issue')&&!window.confirm(`${then === 'post' ? '确认过账？' : '确认开立？'}\n${text}`)) return;
      }
      const draftId=doc?.id??savedDraft.current?.id;
      let saved = draftId ? await financeApi.update(draftId, b) : await financeApi.create(b);
      if(!current())return;
      savedDraft.current=saved;
      if (def.store && (vouchersDirty || (vouchers.length > 0 && !doc))) await sessionApi.bindVouchers(saved.id, vouchers.map((v) => v.id));
      if(!current())return;
      if (then === 'issue') saved = await financeApi.issue(saved.id);
      if(!current())return;
      if (then === 'post') saved = await financeApi.post(saved.id);
      if(!current())return;
      if (inline && !doc) { reset(); setNotice(`已保存 ${saved.docNo}（${then === 'post' ? '已过账' : then === 'issue' ? '已开立' : '草稿'}），可以接着开下一张`); setBalanceTick((t) => t + 1); }
      onSaved(saved, then === 'post' ? 'posted' : then === 'issue' ? 'issued' : 'draft');
    } catch (err) {
      if(current())setError(err instanceof ApiError || err instanceof Error ? err.message : '保存失败');
    } finally { saving.current=false; if(current())setBusy(false); }
  };

  const addLine = () => setLines((ls) => [...ls, freshLines()[0]]);
  const setLine = (i: number, patch: Partial<LineState>) => setLines((ls) => ls.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  /** 费用约束随已选资料同步带入，避免晚返回把新行或用户选择的节点覆盖。 */
  const pickFee = (i: number, id: number | null, name: string, data?: Record<string, unknown>) => {
    const first = id ? String(data?.defaultObject ?? '').split(/[、,，]/).map(value => value.trim()).find(value => FEE_BOOKING_NODE_MAP.has(value) && value !== '不固定') : '';
    setLines(current => current.map((line, index) => index === i ? { ...line, feeItemId: id, feeItemName: String(data?.name||name), feeItemLabel: [name,data?.code].filter(Boolean).join(' · '), needObject: !!id && data?.requiredObject === 'yes', node: line.node || first || '' } : line));
  };
  /** 名称单位与选中商品一起带入；未设置则保留行内单位，最后回退为件。 */
  const pickProduct = (i: number, id: number | null, name: string, data?: Record<string, unknown>, labels?: Record<string,string>) => {
    const rawUnit = id ? String(data?.specUnit ?? '').trim() : '';
    const unit = id && labels?.specUnit || unitOptionFromText(rawUnit)?.label || rawUnit;
    setLines(current => current.map((line, index) => index === i ? { ...line, productId: id, productName: String(data?.name || name), productLabel: [name, data?.code].filter(Boolean).join(' · '), unit: unit || line.unit || '件' } : line));
  };
  const moneyItem = ui.moneyItemLabel ?? '项目';
  const parsedCount = structuredLines ? lines.filter((l) => l.productId || l.feeItemId || l.price).length : moneyLines.filter(l => l.item || l.amount).length;
  const settleTitle = type === 'receipt' ? '到账情况' : def.settle === 'in' && type !== 'purchase-return' ? '收款情况' : def.settle === 'out' && type !== 'sale-return' ? '付款情况' : def.settle ? '退款情况' : def.bank === 'in' ? '收款情况' : def.bank === 'out' ? '付款情况' : '转款情况';

  const doPrint = () => {
    const rowsOut = structuredLines
      ? lines.filter((l) => l.productId || l.feeItemId).map((l, i) => ui.feeAmountOnly ? [String(i + 1), l.feeItemName, l.node, l.relatedName, money(priceOf(l.price)), l.memo] : [String(i + 1), l.productName || l.feeItemName, l.unit, l.qty, money(l.gift ? 0 : priceOf(l.price)), money(lineAmount({ qty: Number(l.qty) || 0, unitPriceCents: l.gift ? 0 : priceOf(l.price) })), l.memo])
      : moneyLines.filter((l) => l.item || l.amount).map((l, i) => [String(i + 1), l.item, '', '1', l.amount, l.amount, l.memo]);
    const ok = printSlip({
      title: `${def.label}${doc ? ` ${doc.docNo}` : '（未保存）'}`,
      head: [['日期', date], ...(def.party ? [[ui.partyLabel.replace('（选填）', ''), (type === 'expense' ? counterpartyName : party.name)] as [string, string]] : []), ...(type === 'expense' ? [['单据摘要', summary || `${lines.find(l => l.feeItemId)?.feeItemName || '费用'}等${parsedCount}项费用`] as [string, string]] : []), ...(def.warehouse ? [['仓库', wh.name] as [string, string]] : []), ['经办人', handlerName || handlerLegacy], [def.bank === 'transfer' ? '转出 → 转入' : '结算账户', def.bank === 'transfer' ? `${outs.map((a) => a.name).join('、')} → ${ins.map((a) => a.name).join('、')}` : multiOn ? multi.map((a) => `${a.name} ${money(yuanToCents(a.amount) || 0)}`).join('；') : bank.name]],
      columns: ui.feeAmountOnly ? ['#', '费用类型', '挂账节点', '挂账对象', '金额', '备注'] : ['#', ui.moneyEntry ? moneyItem : def.lines === 'fee' ? '费用项目' : '商品/项目', '单位', '数量', '单价', '金额', '备注'],
      rows: rowsOut,
      totals: [...(discountC ? [['明细合计', money(gross)] as [string, string], ['优惠', money(discountC)] as [string, string]] : []), [ui.totalLabel, money(total)], ...(moneyDiscC ? [['优惠金额（计入财务费用）', money(moneyDiscC)] as [string, string]] : []), ...(def.bank === 'transfer' && parse(fee) ? [[`手续费（${feeBearer === 'out' ? '转出方' : '转入方'}承担）`, money(parse(fee) ?? 0)] as [string, string]] : []), ...(def.settle ? [[ui.amountLabel, money(paidC)] as [string, string]] : [])],
      memo: memo,
    });
    if (!ok) setError('浏览器拦截了打印窗口，请允许弹出窗口后重试');
  };

  // 快捷键（只在制单中心整页开单时生效）：Ctrl+G 保存草稿 · F8 过账 · Ctrl+F9 打印 · Ctrl+F8 回到明细
  const act = useRef({ save, doPrint });
  act.current = { save, doPrint };
  useEffect(() => {
    if (!inline||sourceInline) return undefined;
    const on = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'g') { e.preventDefault(); void act.current.save(null); }
      else if (e.key === 'F8' && !e.ctrlKey) { e.preventDefault(); if (can('finance.docs.post')) void act.current.save(null, 'post'); }
      else if (e.key === 'F9' && e.ctrlKey) { e.preventDefault(); act.current.doPrint(); }
      else if (e.key === 'F8' && e.ctrlKey) { e.preventDefault(); gridRef.current?.querySelector<HTMLElement>('input, select')?.focus(); }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [inline, can, sourceInline]);

  const buttons = sourceInline ? type==='expense'?<button type="submit" className="reference-expense-save" disabled={busy}>{busy?'保存中':ui.saveText}</button>:<><button type="button" className="secondary-button" disabled={busy} onClick={()=>void save(null)}>保存草稿</button><button type="submit" className="primary-button" disabled={busy}>{busy?'保存中':ui.saveText}</button></> : (
    <>
      {!inline && <button type="button" className="secondary-button" onClick={onClose}>取消</button>}
      <button type="submit" className="secondary-button" disabled={busy}>{inline ? '保存草稿' : '存为草稿'}</button>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => save(null, 'issue')}>保存并开立</button>
      {can('finance.docs.post') && <button type="button" className="primary-button" disabled={busy} onClick={() => save(null, 'post')}>{ui.saveText.replace('保存', '保存并过账')}</button>}
    </>
  );


  const content = (
    <div className="slip-cols">
      <div className="slip-main">
      <DocumentHeadCard reference={type !== 'withdrawal'}>
      {type === 'withdrawal' && <p className="muted slip-hint">过账结果：{def.posting}</p>}
      {originalFields?<ReferenceVoucherHeading step={1} title={ui.partyTitle||'单据信息'} hint={ui.partyHint}/>:<><h3 className="section-title"><span className="step">1</span>{ui.partyTitle || '单据信息'}</h3>{ui.partyHint && <p className="reference-document-hint">{ui.partyHint}</p>}</>}
      <section className={`slip-head${originalFields?' reference-voucher-basic':''}${originalFields&&type==='expense'?' reference-voucher-expense-basic':''}${sourceTransfer?' reference-voucher-transfer-basic':''}`}>
        {type !== 'expense' && <label>单据编号<input aria-label="单据编号" value={docNo} maxLength={32} onChange={(e) => setDocNo(e.target.value)} placeholder={originalFields?'留空由系统自动生成':doc ? '' : `不填则自动生成（${def.prefix}${date.replace(/-/g, '')}001）`} disabled={!!doc && doc.status !== 'draft'} /></label>}
        <label>单据日期<input type="date" aria-label="单据日期" value={date} onChange={(e) => setDate(e.target.value)} required /></label>
        {sourceTransfer&&<ReferenceTransferFields key={resetVersion} outs={outs} ins={ins} setOuts={setOuts} setIns={setIns}/>}
        {type === 'expense' && <label className="slip-party">相关单位<input aria-label="相关单位" maxLength={160} placeholder="供应商、司机、平台等" value={counterpartyName} onChange={e => setCounterpartyName(e.target.value)} /></label>}
        {def.party && type !== 'expense' && (
          <PartyField reference={originalFields}>{ui.partyLabel}{def.partyRequired&&!originalFields ? ' *' : ''}
            <div className="slip-party-row">
              {kinds.length > 1 && (
                <select aria-label="往来对象来源" value={partyKind} onChange={(e) => { if (e.target.value === 'employee') void financeApi.syncEmployees().catch(() => undefined); setPartyKind(e.target.value as PartyKind); setParty({ id: null, name: '' }); }}>
                  {kinds.map((k) => <option key={k} value={k}>{originalFields?'':'来自'}{originalFields&&k==='employee'?'人员':PARTY_KIND_LABEL[k]}档案</option>)}
                </select>
              )}
              <SearchPick ariaLabel={ui.partyLabel} type={PARTY_KIND_RESOURCE[partyKind]} value={party.id} label={party.name} placeholder={originalFields?sourcePartyPlaceholder[type]:`搜索${PARTY_KIND_LABEL[partyKind]}`} onChange={(id, name) => setParty({ id, name })} />
            </div>
          </PartyField>
        )}
        {!originalFields && def.party && party.id && <div className="slip-wide"><PartyBalanceBar balance={partyBalance} extraReceivable={def.settle === 'in' && def.lines === 'product' ? Math.max(rest, 0) : 0} /></div>}
        {!originalFields && origin && partyKind === origin.kind && (
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
          ? <label>{originalFields&&type==='sale'?'仓库':ui.warehouseLabel}{originalFields?'':' *'}<input aria-label="仓库" value={wh.name} maxLength={200} onChange={e => setWh({ id: null, name: e.target.value })} /></label>
          : type === 'expense'||sourceTransfer ? null : <label>归属部门<input aria-label="归属部门" value={department} maxLength={60} onChange={(e) => setDepartment(e.target.value)} /></label>}
        <HandlerSelect showUnassignedDepartment={!(originalFields&&type==='expense')} placeholder={sourceInline&&type==='expense'?'搜索经办人':'选择经办人'} options={staff} value={handlerId} valueName={handlerName} legacy={handlerLegacy} onChange={(id, name) => { setHandlerId(id); setHandlerName(name); if (type !== 'withdrawal') setHandlerLegacy(''); }} />
      </section>
      </DocumentHeadCard>

      {def.bank === 'transfer'&&!sourceTransfer && <TransferPanel outs={outs} ins={ins} setOuts={setOuts} setIns={setIns} balances={balances} />}
      {def.bank === 'transfer'&&!sourceTransfer && <TransferFee fee={fee} setFee={setFee} bearer={feeBearer} setBearer={setFeeBearer} inTransit={inTransit} setInTransit={setInTransit} outName={outs[0]?.name ?? ''} inName={ins[0]?.name ?? ''} />}

      {structuredLines && (
        <section>
          <>{originalFields?<ReferenceVoucherHeading step={2} title={ui.detailTitle} hint={ui.detailHint}/>:<><h3 className="section-title"><span className="step">2</span>{ui.detailTitle}</h3>{ui.detailHint && <p className="reference-document-hint">{ui.detailHint}</p>}</>}</>
          <GoodsGrid source={originalFields} totalLabel={sourceLineTotalLabel[type]} company={user?.companyId?{id:user.companyId,name:user.companyName||'当前公司'}:undefined} staff={staff} def={def} type={type} lines={lines} setLines={setLines} setLine={setLine} priceOf={priceOf} hints={hints} onPickProduct={pickProduct} onPickFee={pickFee} addRow={addLine} gridRef={gridRef} totalCents={total} />
          <div className={originalFields?"reference-voucher-add-row":"vc-grid-foot"}>
            <button type="button" className="secondary-button small" onClick={addLine}>{ui.feeAmountOnly ? '添加一行费用' : originalFields?'添加一行商品':'+ 加一行'}</button>
            {!originalFields&&!ui.feeAmountOnly && <span className="muted">{def.lines === 'product' ? `共 ${goodsLines.length} 种商品 · 数量合计 ${Number(qtyTotal.toFixed(4))}　` : ''}回车跳到下一格，最后一格回车加行；Shift+Delete 删当前行</span>}
            {!originalFields&&!ui.feeAmountOnly && <span className="vc-grid-total">{def.lines === 'product' && discountC > 0 ? `明细合计 ${money(gross)} − 优惠 ${money(discountC)} = ` : ''}{ui.totalLabel}　<b>{money(total)}</b></span>}
          </div>
          {!originalFields&&def.lines === 'product' && (
            <label className="vc-discount">整单优惠 / 抹零（元）
              <input inputMode="decimal" aria-label="优惠金额" value={discount} onChange={(e) => setDiscount(e.target.value)} placeholder="没有就留空；优惠后才是应收/应付金额" />
            </label>
          )}
        </section>
      )}

      {!structuredLines && (
        <section>
          <>{originalFields?<ReferenceVoucherHeading step={2} title={ui.detailTitle} hint={ui.detailHint}/>:<><h3 className="section-title"><span className="step">2</span>{ui.detailTitle}</h3>{ui.detailHint && <p className="reference-document-hint">{ui.detailHint}</p>}</>}</>
          <MoneyGrid source={originalFields} totalLabel={sourceLineTotalLabel[type]} totalCents={moneyCents} type={type} label={moneyItem} lines={moneyLines} setLines={setMoneyLines} gridRef={gridRef} />
          <div className={originalFields?"reference-voucher-add-row":"vc-grid-foot"}>
            <button type="button" className="secondary-button small" onClick={() => setMoneyLines((ls) => [...ls, emptyMoney()])}>{originalFields?'添加一行明细':'+ 加一行'}</button>
            {!originalFields&&<span className="muted">回车跳到下一格，最后一格回车加行；Shift+Delete 删当前行</span>}
            {!originalFields&&<span className="vc-grid-total">{ui.totalLabel}　<b>{money(moneyCents)}</b></span>}
          </div>
        </section>
      )}

      {type !== 'withdrawal' && !sourceInline && <details className="reference-document-extra"><summary>过账说明</summary><p className="muted slip-hint">过账结果：{def.posting}</p></details>}
      </div>
      <aside className="slip-side" aria-label="单据功能区">
      <div className={`slip-total-card${originalFields?' reference-voucher-total':''}`}><span className="muted">{ui.totalLabel}</span><b>{money(total)}</b>{!originalFields&&def.lines && <span className="muted">共 {parsedCount} 行{discountC > 0 ? ` · 已优惠 ${money(discountC)}` : ''}</span>}</div>
      {originalFields?sourceTransfer?<ReferenceTransferSummary title={settleTitle} outs={outs} ins={ins} totalCents={total}/>:<ReferenceVoucherPayment ui={ui} title={settleTitle} expense={type==='expense'} mode={payMode} onMode={pickMode} bank={bank} onBank={(id,name)=>setBank({id,name})} paid={paid} onPaid={setPaid}/>:<section className="slip-settle">
        <h3 className="section-title"><span className="step">3</span>{settleTitle}</h3>
        {hasPayment && (
          <div className="pay-modes" role="group" aria-label="结算方式">
            {ui.payModes.map((m) => <button key={m.mode} type="button" className={`mode-button${payMode === m.mode ? ' active' : ''}`} aria-pressed={payMode === m.mode} onClick={() => pickMode(m.mode)}>{m.label}</button>)}
          </div>
        )}
        {type === 'expense' && (rest > 0 || offsetC > 0 || party.id) && (
          <label className="slip-party">往来档案（挂账过账时选择）
            <div className="slip-party-row">
              {kinds.length > 1 && (
                <select aria-label="往来对象来源" value={partyKind} onChange={(e) => { if (e.target.value === 'employee') void financeApi.syncEmployees().catch(() => undefined); setPartyKind(e.target.value as PartyKind); setParty({ id: null, name: '' }); }}>
                  {kinds.map((k) => <option key={k} value={k}>来自{PARTY_KIND_LABEL[k]}档案</option>)}
                </select>
              )}
              <SearchPick ariaLabel="挂账往来档案" type={PARTY_KIND_RESOURCE[partyKind]} value={party.id} label={party.name} placeholder={`搜索${PARTY_KIND_LABEL[partyKind]}`} onChange={(id, name) => setParty({ id, name })} />
            </div>
          </label>
        )}
        <div className="form-grid">
          {!def.lines && !def.moneySettlement && def.bank !== 'transfer' && <p className="muted" aria-label="金额汇总">{ui.amountLabel}：<b>{money(moneyCents)}</b>（等于上面明细合计）</p>}
          {(def.bank === 'in' || def.bank === 'out' || def.settle) && def.bank !== 'transfer' && !multiOn && <label>{ui.accountLabel} *<SearchPick ariaLabel={ui.accountLabel} type="bank-accounts" value={bank.id} label={bank.name} onChange={(id, name) => setBank({ id, name })} /></label>}
          {hasPayment && <label>{ui.amountLabel}（元）<input inputMode="decimal" aria-label={ui.amountLabel} value={multiOn ? centsToYuan(multiCents) : paid} readOnly={multiOn} onChange={(e) => { setPaid(e.target.value); setPayMode('part'); }} placeholder={def.lines === 'fee' ? '不填 = 当场付清/收齐' : '0.00'} />{multiOn && <small className="muted">分账户时等于下面各账户金额之和</small>}</label>}
          {!multiOn && payDir && <button type="button" className="link-button pay-toggle" onClick={() => { setMulti(bank.id ? [{ id: bank.id, name: bank.name, amount: (hasPayment ? paidC : moneyCents) ? centsToYuan(hasPayment ? paidC : moneyCents) : '' }] : []); setMultiOn(true); }}>分多个账户{payDir === 'in' ? '收' : '付'}款</button>}
          {hasMoneyDiscount(type) && <label>优惠金额（元）<input inputMode="decimal" aria-label="优惠金额" value={discount} onChange={(e) => setDiscount(e.target.value)} placeholder="没有就留空" /><small className="muted vc-disc-hint">{type === 'receipt' ? '给对方让利：冲减他的应收，但没有收到钱，记入财务费用' : '对方给的折扣：冲减我们的应付，但没有付钱，冲减财务费用'}</small></label>}
          {type === 'online-sale' && <label>平台佣金率（%，仅估算，不入账）<input inputMode="decimal" aria-label="平台佣金率" value={feeRate} onChange={(e) => setFeeRate(e.target.value)} placeholder="如 0.6" /></label>}
          {!def.store && hasBankRef(def) && <label>银行流水号<input aria-label="银行流水号" value={refNo} maxLength={80} onChange={(e) => setRefNo(e.target.value)} placeholder="选填；银行回单上的流水号" /></label>}
          {def.offset && <label>冲抵{ACCOUNT_LABEL[def.offset]}（元）<input inputMode="decimal" aria-label="冲抵金额" value={offset} onChange={(e) => setOffset(e.target.value)} placeholder="不冲抵就留空" /></label>}
        </div>
        {multiOn && payDir && (
          <PayAccounts role={payDir} accounts={multi} setAccounts={setMulti} expected={hasPayment ? Math.max(total - offsetC, 0) : moneyCents} strict={!hasPayment || !!def.moneySettlement && payMode === 'full'} balances={balances}
            onSingle={() => { const first = multi[0]; if (first) setBank({ id: first.id, name: first.name }); if (hasPayment) { setPayMode('part'); setPaid(multiCents ? centsToYuan(multiCents) : ''); } setMultiOn(false); }} />
        )}
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
        {hasMoneyDiscount(type) && (
          <dl className="settle-sum" aria-label="本次冲减往来">
            <div><dt>{ui.amountLabel}</dt><dd>{money(parse(amount) ?? 0)}</dd></div>
            {offsetC > 0 && <div><dt>冲抵{def.offset ? ACCOUNT_LABEL[def.offset] : ''}</dt><dd>{money(offsetC)}</dd></div>}
            {moneyDiscC > 0 && <div><dt>优惠金额</dt><dd>{money(moneyDiscC)}</dd></div>}
            <div><dt>本次冲减{type === 'receipt' ? '应收' : '应付'}</dt><dd>{money(settleTotal)}</dd></div>
          </dl>
        )}
        {def.settle && def.lines && (
          <dl className="settle-sum">
            <div><dt>{ui.totalLabel}</dt><dd>{money(total)}</dd></div>
            <div><dt>{ui.amountLabel}</dt><dd>{money(paidC)}</dd></div>
            {def.offset && <div><dt>冲抵{ACCOUNT_LABEL[def.offset]}</dt><dd>{money(offsetC)}</dd></div>}
            <div className={rest < 0 ? 'bad' : undefined}><dt>{restLabel}</dt><dd>{money(rest)}</dd></div>
          </dl>
        )}
      </section>}

      {def.store && <VoucherPanel files={vouchers} shopId={shopId} onChange={(f) => { setVouchers(f); setVouchersDirty(true); }} />}
      {originalFields?<ReferenceVoucherNote expense={type==='expense'} summary={summary} onSummary={setSummary} memo={memo} onMemo={setMemo}/>:type === 'expense' ? <section className="expense-note-fields">
        <label>单据摘要<input aria-label="单据摘要" placeholder="不填则自动生成" maxLength={255} value={summary} onChange={e => setSummary(e.target.value)} /></label>
        <label>单据备注<textarea rows={2} maxLength={500} aria-label="备注" value={memo} onChange={e => setMemo(e.target.value)} /></label>
      </section> : <label>{def.lines ? '备注' : `${moneyItem} / 备注`}<textarea rows={2} maxLength={500} aria-label="备注" value={memo} onChange={e => setMemo(e.target.value)} /></label>}
      {sourceInline&&(type==='expense'?buttons:<div className="reference-document-actions">{buttons}</div>)}
      {(!sourceInline||notice||error)&&<div ref={noticeRef}>
        {notice && <div role="status" className="notice ok">{notice}</div>}
        {error && <div role="alert" className="notice error">{error}</div>}
      </div>}
      </aside>
    </div>
  );


  if (inline) {
    return (
      <ReferencePickContext.Provider value={type !== 'withdrawal'}><form className={`card slip vc-slip${type !== 'withdrawal' ? ' reference-document' : ''}${sourceInline?' reference-document-source':''}`} data-doc-type={type} aria-label={`${def.label}开单`} onSubmit={(e) => save(e,sourceInline?'issue':undefined)}>
        <div className="slip-title">{type === 'withdrawal' ? <strong>{def.label} / 手工开单</strong> : <h1>{def.label} / 手工开单</h1>}{doc && <span className="vc-editing">正在编辑草稿 {doc.docNo}</span>}{sourceInline&&<button type="button" className="secondary-button" disabled={busy} onClick={()=>{if(doc)onClose?.();else reset();}}>{type==='expense'?'清空':'清空单据'}</button>}</div>
        {!sourceInline&&<div className="slip-toolbar-row"><VoucherToolbar type={type} busy={busy} editing={!!doc}
          onClear={() => { if (doc) onClose?.(); else reset(); }} onPrint={doPrint} onList={() => onShowList?.()} onPickDraft={(id) => onPickDraft?.(id)} />
          <span className="vc-keys muted">Ctrl+G 保存草稿 · F8 过账 · Ctrl+F9 打印 · Ctrl+F8 回到明细</span></div>}
        <div className="slip-body">{content}</div>
        {!sourceInline&&<div className="slip-foot"><div className="slip-foot-total"><span className="muted">{ui.totalLabel}</span> <b>{money(total)}</b></div>{buttons}</div>}
      </form></ReferencePickContext.Provider>
    );
  }
  return (
    <ReferencePickContext.Provider value={type !== 'withdrawal'}><div className="modal-backdrop" role="presentation">
      <form className={`modal card slip${type !== 'withdrawal' ? ' reference-document' : ''}`} style={{ maxWidth: 980 }} role="dialog" aria-label={`${doc ? '编辑' : '新建'}${def.label}`} onSubmit={(e) => save(e)}>
        <div className="modal-head between"><strong>{doc ? `编辑 ${doc.docNo}` : `新建${def.label}`}</strong><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>×</button></div>
        <div className="modal-body">{content}</div>
        <div className="modal-foot">{buttons}</div>
      </form>
    </div></ReferencePickContext.Provider>
  );
}
