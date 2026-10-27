import { useEffect, useState } from 'react';
import { OPENING_PREPAYMENT_PERMISSION, ACCOUNT_LABEL, DOC_STATUS_LABEL, DOC_TYPE_MAP, PARTY_KIND_LABEL, type AccountKind } from '@kudesi/shared';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ReasonDialog } from '../../resources/RecordForm';
import { OpeningPrepaymentDialog } from './OpeningPrepaymentDialog';
import { DocForm } from './DocForm';
import { DOC_STATUS_TONE, money } from './common';
import { financeApi, type DocDetailDto } from './financeApi';
import { CopyButton, plainYuan } from './fin-ui';
import { sessionApi, type VoucherFile } from './sessionApi';
import { VoucherPanel } from './VoucherPanel';

const ACTION_LABEL: Record<string, string> = { create: '新建草稿', update: '修改草稿', issue: '开立', unissue: '退回草稿', post: '过账', reverse: '红冲', 'edit-header': '修改单据', 'opening-prepay': '登记已有预付款余额', audit: '财务审核', unaudit: '取消财务审核' };

/** 单据详情抽屉：头信息、明细、分录（借/贷）、操作记录，以及按状态和权限出现的操作按钮。 */
export function DocDetail({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const { can } = useAuth();
  const [doc, setDoc] = useState<DocDetailDto | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [dialog, setDialog] = useState<'reverse' | 'unissue' | 'header' | 'opening' | null>(null);
  const [copied, setCopied] = useState('');
  const [vouchers, setVouchers] = useState<VoucherFile[]>([]);

  useEffect(() => {
    let live = true;
    setDoc(null);
    setError('');
    financeApi.doc(id).then((d) => live && setDoc(d)).catch((e) => live && setError(e instanceof ApiError ? e.message : '加载失败'));
    return () => { live = false; };
  }, [id]);
  useEffect(() => { setVouchers([]); if (doc?.storeId) sessionApi.docVouchers(doc.id).then(setVouchers).catch(() => undefined); }, [doc?.id, doc?.storeId]);
  if (!doc) return <aside className="drawer card">{error ? <div role="alert" className="notice error">{error}</div> : <div className="empty-state muted">加载中…</div>}</aside>;

  const def = DOC_TYPE_MAP.get(doc.docType)!;
  const run = async (fn: () => Promise<DocDetailDto | { ok: true }>, closeAfter = false) => {
    setBusy(true);
    setError('');
    try {
      const r = await fn();
      onChanged();
      if (closeAfter) return onClose();
      if ('docNo' in r) setDoc(r);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };
  const isDraft = doc.status === 'draft', isIssued = doc.status === 'issued';
  const canReverse = doc.status === 'posted' && !doc.reversesId && !doc.auditedAt && can('finance.docs.reverse');
  const isPosted = doc.status === 'posted' && !doc.reversesId;

  return (
    <aside className="drawer card" aria-label={`${doc.typeLabel}详情`}>
      <div className="drawer-head between">
        <div><strong className="drawer-title">{doc.docNo}</strong> <CopyButton text={doc.docNo} label={`单号 ${doc.docNo}`} /> <span className={`pill ${DOC_STATUS_TONE[doc.status]}`}>{DOC_STATUS_LABEL[doc.status]}</span></div>
        <button type="button" className="icon-button" aria-label="关闭详情" onClick={onClose}>×</button>
      </div>
      <div className="drawer-body">
        {error && <div role="alert" className="notice error">{error}</div>}
        {copied && <div role="status" className="notice ok">已复制为草稿 {copied}，到草稿中心调出修改后再过账</div>}
        {doc.entries.some((e) => e.kind === 'opening') && <div className="notice">此单登记的是已有预付款余额，未扣银行或现金余额。</div>}
        {doc.auditedAt && <div className="notice">已财务审核，不能再红冲和修改</div>}
        <dl className="kv">
          <div className="kv-row"><dt>类型</dt><dd>{doc.typeLabel}</dd></div>
          <div className="kv-row"><dt>日期</dt><dd>{doc.docDate}</dd></div>
          {doc.partyName && <div className="kv-row"><dt>{def.ui.partyLabel.replace('（选填）', '')}</dt><dd>{doc.partyName} <CopyButton text={doc.partyName} label="往来对象" />{doc.partyKind && <span className="muted">（{PARTY_KIND_LABEL[doc.partyKind]}档案）</span>}</dd></div>}
          {doc.storeName && <div className="kv-row"><dt>店铺</dt><dd>{doc.storeName}</dd></div>}
          {doc.refNo && <div className="kv-row"><dt>{def.store ? '平台提现流水号' : '银行流水号'}</dt><dd className="mono">{doc.refNo} <CopyButton text={doc.refNo} label="流水号" /></dd></div>}
          {doc.warehouseName && <div className="kv-row"><dt>仓库</dt><dd>{doc.warehouseName}</dd></div>}
          {doc.bankName && <div className="kv-row"><dt>{def.bank === 'transfer' ? '转出账户' : '银行账户'}</dt><dd>{doc.bankName}</dd></div>}
          {doc.toBankName && <div className="kv-row"><dt>转入账户</dt><dd>{doc.toBankName}</dd></div>}
          <div className="kv-row"><dt>金额</dt><dd className={doc.amountCents < 0 ? 'neg' : ''}>{money(doc.amountCents)} <CopyButton text={plainYuan(doc.amountCents)} label="金额" /></dd></div>
          {doc.paidCents !== 0 && <div className="kv-row"><dt>{def.ui.amountLabel}</dt><dd>{money(doc.paidCents)}</dd></div>}
          {def.settle && def.lines && <div className="kv-row"><dt>挂{def.settle === 'in' && def.type !== 'purchase-return' || def.type === 'sale-return' ? '应收' : '应付'}余额</dt><dd>{money(doc.amountCents - doc.paidCents - doc.offsetCents)}</dd></div>}
          {doc.offsetCents !== 0 && <div className="kv-row"><dt>冲抵{def.offset ? ACCOUNT_LABEL[def.offset] : ''}</dt><dd>{money(doc.offsetCents)}</dd></div>}
          {doc.memo && <div className="kv-row"><dt>备注</dt><dd>{doc.memo}</dd></div>}
          {doc.handler && <div className="kv-row"><dt>经办人</dt><dd>{doc.handler}</dd></div>}
          {doc.department && <div className="kv-row"><dt>归属部门</dt><dd>{doc.department}</dd></div>}
          <div className="kv-row"><dt>制单人</dt><dd>{doc.createdByName}</dd></div>
          {doc.reversedById && <div className="kv-row"><dt>已被红冲</dt><dd>红冲单 #{doc.reversedById}</dd></div>}
          {doc.reversesId && <div className="kv-row"><dt>红冲的原单</dt><dd>#{doc.reversesId}</dd></div>}
        </dl>

        {(doc.settlements?.length ?? 0) > 0 && (
          <section>
            <h3 className="section-title">结算的单据（{doc.settleByLabel}）</h3>
            <table className="data-table"><thead><tr><th>单据</th>{doc.settleBy === 'product' && <th>商品</th>}<th className="num">结算金额</th></tr></thead>
              <tbody>{doc.settlements!.map((x) => <tr key={x.id}><td className="mono">{x.sourceDocNo} <span className="muted">{x.sourceTypeLabel}</span></td>{doc.settleBy === 'product' && <td>{x.productName}</td>}<td className="num">{money(x.amountCents)}</td></tr>)}</tbody></table>
          </section>
        )}
        {(doc.settledBy?.length ?? 0) > 0 && (
          <section>
            <h3 className="section-title">已被这些收付款单结算</h3>
            <table className="data-table"><thead><tr><th>收付款单</th><th>状态</th><th className="num">结算金额</th></tr></thead>
              <tbody>{doc.settledBy!.map((x) => <tr key={x.id}><td className="mono">{x.docNo}</td><td>{x.status === 'posted' ? '已过账' : '已开立'}</td><td className="num">{money(x.amountCents)}</td></tr>)}</tbody></table>
          </section>
        )}
        {doc.accounts.length > 0 && (
          <>
            <h3 className="section-title">转款账户</h3>
            <div className="table-scroll"><table className="data-table">
              <thead><tr><th>方向</th><th>账户</th><th>金额</th></tr></thead>
              <tbody>{doc.accounts.map((a) => <tr key={a.id}><td>{a.role === 'out' ? '转出' : '转入'}</td><td>{a.bankName}</td><td className="num">{money(a.amountCents)}</td></tr>)}</tbody>
            </table></div>
          </>
        )}
        {!!doc.openingVouchers?.length && <section><h3 className="section-title">期初预付凭证</h3><ul className="stack">{doc.openingVouchers.map((f) => <li key={f.id}><button type="button" className="link-button" onClick={() => financeApi.openingVoucherUrl(doc.id, f.id).then((r) => window.open(r.url, '_blank', 'noopener')).catch((e) => setError(e instanceof Error ? e.message : '凭证加载失败'))}>{f.name}</button></li>)}</ul></section>}
        {doc.docType === 'withdrawal' && <VoucherPanel files={vouchers} readOnly />}

        {doc.lines.length > 0 && (
          <>
            <h3 className="section-title">明细</h3>
            <div className="table-scroll"><table className="data-table">
              <thead><tr><th>#</th><th>{def.lines === 'fee' ? '费用项目' : def.lines ? '商品' : '项目'}</th>{def.lines === 'product' && <th>单位</th>}{def.lines ? <><th>数量</th><th>单价</th></> : null}<th>金额</th>{def.lines === 'fee' && <th>挂账</th>}{doc.lines.some((l) => l.unitCostCents != null) && <th>成本单价</th>}</tr></thead>
              <tbody>{doc.lines.map((l) => (
                <tr key={l.id}><td>{l.lineNo}</td><td>{l.productName || l.feeItemName || l.itemName}{l.memo && <span className="muted">（{l.memo}）</span>}</td>{def.lines === 'product' && <td>{l.unit ?? ''}</td>}{def.lines ? <><td className="num">{l.qty}</td><td className="num">{money(l.unitPriceCents)}</td></> : null}<td className="num">{money(Math.round(l.qty * l.unitPriceCents))}</td>{def.lines === 'fee' && <td>{l.relatedNode ? `${l.relatedNode}${l.relatedName ? `：${l.relatedName}` : l.relatedId ? ` #${l.relatedId}` : ''}` : ''}</td>}{doc.lines.some((x) => x.unitCostCents != null) && <td className="num">{money(l.unitCostCents)}</td>}</tr>
              ))}</tbody>
            </table></div>
          </>
        )}

        {doc.entries.length > 0 && (
          <>
            <h3 className="section-title">分录（过账结果）</h3>
            <div className="table-scroll"><table className="data-table">
              <thead><tr><th>科目</th><th>对象</th><th>借方</th><th>贷方</th><th>数量</th></tr></thead>
              <tbody>{doc.entries.map((e) => (
                <tr key={e.id}>
                  <td>{ACCOUNT_LABEL[e.kind as AccountKind] ?? e.kind}</td><td>{e.accountName || '—'}</td>
                  <td className="num">{e.amountCents !== null && e.amountCents > 0 ? money(e.amountCents) : ''}</td>
                  <td className="num">{e.amountCents !== null && e.amountCents < 0 ? money(-e.amountCents) : ''}</td>
                  <td className="num">{e.qty ?? ''}</td>
                </tr>
              ))}</tbody>
            </table></div>
          </>
        )}

        <h3 className="section-title">操作记录</h3>
        <ul className="stack">{doc.events.map((e) => <li key={e.id} className="log-item">{new Date(e.createdAt).toLocaleString('zh-CN')} · {e.actorName} · {ACTION_LABEL[e.action] ?? e.action}{e.note && `：${e.note}`}</li>)}</ul>
      </div>
      <div className="drawer-foot row-actions">
        {isDraft && can('finance.docs.create') && <button type="button" className="secondary-button" disabled={busy} onClick={() => setEditing(true)}>编辑</button>}
        {isDraft && can('finance.docs.issue') && <button type="button" className="secondary-button" disabled={busy} onClick={() => run(() => financeApi.issue(doc.id))}>开立</button>}
        {(isDraft || isIssued) && can('finance.docs.post') && <button type="button" className="primary-button" disabled={busy} onClick={() => run(() => financeApi.post(doc.id))}>过账</button>}
        {isIssued && doc.docType === 'prepayment' && doc.partyKind === 'supplier' && doc.sourceKey == null && !doc.reversesId && doc.amountCents > 0 && can(OPENING_PREPAYMENT_PERMISSION) && <button type="button" className="secondary-button" disabled={busy} onClick={() => setDialog('opening')}>登记已有预付款余额</button>}
        {isIssued && can('finance.docs.issue') && <button type="button" className="secondary-button" disabled={busy} onClick={() => setDialog('unissue')}>退回草稿</button>}
        {isDraft && can('finance.docs.delete') && <button type="button" className="ghost-button danger-text" disabled={busy} onClick={() => run(() => financeApi.remove(doc.id), true)}>删除草稿</button>}
        {isPosted && !doc.auditedAt && can('finance.docs.edit-header') && <button type="button" className="secondary-button" disabled={busy} onClick={() => setDialog('header')}>修改单据</button>}
        {isPosted && can('finance.docs.audit') && <button type="button" className="secondary-button" disabled={busy} onClick={() => run(() => financeApi.audit(doc.id, !doc.auditedAt))}>{doc.auditedAt ? '取消财务审核' : '财务审核'}</button>}
        <button type="button" className="secondary-button" onClick={() => window.print()}>打印</button>
        {!doc.reversesId && can('finance.docs.create') && <button type="button" className="secondary-button" disabled={busy} onClick={() => run(async () => { const c = await financeApi.copy(doc.id); setCopied(c.docNo); return doc; })}>复制为草稿</button>}
        {canReverse && <button type="button" className="ghost-button danger-text" disabled={busy} onClick={() => setDialog('reverse')}>红冲</button>}
      </div>
      {editing && <DocForm type={doc.docType} doc={doc} onClose={() => setEditing(false)} onSaved={(d) => { setDoc(d); setEditing(false); onChanged(); }} />}
      {dialog === 'reverse' && <ReasonDialog title={`红冲 ${doc.docNo}`} hint="会生成一张金额取反的红冲单，原单变为“已红冲”。库存、往来、银行都会随之冲回。" confirmLabel="确认红冲" danger onClose={() => setDialog(null)} onConfirm={async (reason) => { const r = await financeApi.reverse(doc.id, reason); setDialog(null); onChanged(); setDoc(await financeApi.doc(doc.id)); void r; }} />}
      {dialog === 'opening' && <OpeningPrepaymentDialog doc={doc} onClose={() => setDialog(null)} onSaved={(d) => { setDoc(d); setDialog(null); onChanged(); }} />}
      {dialog === 'header' && <HeaderDialog doc={doc} onClose={() => setDialog(null)} onSave={async (b) => { setDoc(await financeApi.editHeader(doc.id, b)); setDialog(null); onChanged(); }} />}
      {dialog === 'unissue' && <ReasonDialog title={`退回草稿 ${doc.docNo}`} confirmLabel="退回" onClose={() => setDialog(null)} onConfirm={async (reason) => { setDoc(await financeApi.unissue(doc.id, reason)); setDialog(null); onChanged(); }} />}
    </aside>
  );
}

/** 修改已过账单据：只能改日期、经办人、说明，不动账（和管家婆“修改单据”一致） */
function HeaderDialog({ doc, onClose, onSave }: { doc: DocDetailDto; onClose: () => void; onSave: (b: { date: string; handler: string; memo: string }) => Promise<void> }) {
  const [date, setDate] = useState(doc.docDate);
  const [handler, setHandler] = useState(doc.handler ?? '');
  const [memo, setMemo] = useState(doc.memo ?? '');
  const [err, setErr] = useState('');
  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal card small" role="dialog" aria-label="修改单据" onSubmit={async (e) => { e.preventDefault(); try { await onSave({ date, handler, memo }); } catch (x) { setErr(x instanceof ApiError ? x.message : '保存失败'); } }}>
        <div className="modal-head between"><strong>修改单据 {doc.docNo}</strong><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>×</button></div>
        <div className="modal-body">
          <p className="muted">已过账的单据只能改日期、经办人和说明；金额、往来对象要改请红冲后重开。</p>
          <label>单据日期<input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></label>
          <label>经办人<input value={handler} maxLength={60} onChange={(e) => setHandler(e.target.value)} /></label>
          <label>说明<textarea rows={2} maxLength={500} value={memo} onChange={(e) => setMemo(e.target.value)} /></label>
          {err && <div role="alert" className="notice error">{err}</div>}
        </div>
        <div className="modal-foot"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button">保存</button></div>
      </form>
    </div>
  );
}
