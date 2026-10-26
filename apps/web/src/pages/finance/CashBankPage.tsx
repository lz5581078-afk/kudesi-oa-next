import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../api/client';
import { DocDetail } from './DocDetail';
import { money } from './common';
import { financeApi, type BankBalance, type Ledger, type StoreFund } from './financeApi';
import { FRESH_HINT, FRESH_PILL, fmtUpdated, freshnessTone } from './freshness';

const KIND_LABEL: Record<string, string> = { company_public: '公司公户', company_card: '公司银行卡', cashier_account: '出纳账户', store_public: '店铺公户', store_personal_card: '店铺个人卡', legal_person_card: '法人卡', other: '其他' };
const STORE_KINDS = ['store_public', 'store_personal_card'];
const has = (text: string, kw: string) => !kw.trim() || kw.trim().split(/\s+/).every((w) => text.toLowerCase().includes(w.toLowerCase()));

/** 更新时间标签：越久没更新颜色越重，鼠标放上去说明档位 */
function Fresh({ at, now }: { at: string | null | undefined; now: number }) {
  const tone = freshnessTone(at, now);
  return <span className={`pill ${FRESH_PILL[tone]}`} title={FRESH_HINT[tone]}>{fmtUpdated(at)}</span>;
}

/**
 * 现金银行查询：按电商资金的路径看——重点账户（每个人自己标记）、店铺可提现资金（按平台分页签）、
 * 店铺收款账户、公司账户；余额旁边标着最后更新时间，越久没更新颜色越重。
 * 点账户名可以看明细账本：期初结存、每笔收入/支出、滚动余额、期末结存，每笔点单号能看到原始单据。
 * 余额 = 银行账户资料里登记的期初余额 + 已过账单据的流水。
 */
export function CashBankPage() {
  const [now] = useState(() => Date.now());
  const [rows, setRows] = useState<BankBalance[] | null>(null);
  const [funds, setFunds] = useState<StoreFund[]>([]);
  const [keys, setKeys] = useState<number[]>([]);
  const [error, setError] = useState('');
  const [keyword, setKeyword] = useState('');
  const [platform, setPlatform] = useState('all');
  const [open, setOpen] = useState({ funds: false, store: false, company: false });
  const [sel, setSel] = useState<BankBalance | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [docId, setDocId] = useState<number | null>(null);
  const [rel, setRel] = useState<{ title: string; accounts?: BankBalance[]; stores?: Array<{ id: number; name: string; fund?: StoreFund }> } | null>(null);
  const fail = (e: unknown) => setError(e instanceof ApiError ? e.message : '加载失败');
  useEffect(() => { financeApi.banks().then(setRows).catch(fail); }, []);
  useEffect(() => { financeApi.storeFunds().then(setFunds).catch(() => undefined); }, []);
  useEffect(() => { financeApi.keyAccounts().then(setKeys).catch(() => undefined); }, []);
  useEffect(() => {
    if (!sel) return;
    setLedger(null);
    financeApi.ledger(sel.id, { from: from || undefined, to: to || undefined }).then(setLedger).catch(fail);
  }, [sel, from, to]);

  const all = rows ?? [];
  const accounts = useMemo(() => all.filter((r) => has(`${r.title} ${r.bank ?? ''} ${r.ownerName ?? ''} ${r.licenseName ?? ''} ${(r.storeNames ?? []).join(' ')}`, keyword)), [all, keyword]);
  const stores = useMemo(() => funds.filter((f) => (platform === 'all' || f.platform === platform) && has(`${f.name} ${f.platformLabel ?? ''} ${f.storeNo ?? ''}`, keyword)), [funds, platform, keyword]);
  const platforms = useMemo(() => { const m = new Map<string, string>(); for (const f of funds) if (f.platform) m.set(f.platform, f.platformLabel ?? f.platform); return [...m.entries()]; }, [funds]);
  const storeAccounts = accounts.filter((r) => STORE_KINDS.includes(r.kind));
  const companyAccounts = accounts.filter((r) => !STORE_KINDS.includes(r.kind));
  const keyAccounts = accounts.filter((r) => keys.includes(r.id));
  const sumBal = (l: BankBalance[]) => l.reduce((s, r) => s + r.balanceCents, 0);
  const withdrawable = stores.reduce((s, f) => s + f.withdrawableCents, 0);

  const toggleKey = (id: number) => {
    const on = !keys.includes(id);
    setKeys(on ? [...keys, id] : keys.filter((k) => k !== id)); // 先改界面，失败再还原
    financeApi.setKeyAccount(id, on).then(setKeys).catch((e) => { fail(e); financeApi.keyAccounts().then(setKeys).catch(() => undefined); });
  };
  const KeyBtn = ({ r }: { r: BankBalance }) => <button type="button" className="link-button" onClick={() => toggleKey(r.id)}>{keys.includes(r.id) ? '取消重点' : '设为重点'}</button>;
  const Name = ({ r }: { r: BankBalance }) => <button type="button" className="link-button" onClick={() => setSel(r)}>{r.title}</button>;
  const Toggle = ({ k, count, label }: { k: keyof typeof open; count: number; label: string }) => <button type="button" className="secondary-button small" onClick={() => setOpen({ ...open, [k]: !open[k] })}>{open[k] ? `收起${label}` : `展开 ${count} 个${label}`}</button>;

  return (
    <div className={docId ? 'split' : undefined}>
      <div className="split-main">
        <div className="page-head between"><h1>现金银行查询</h1><input className="search-box" type="search" aria-label="搜索账户" placeholder="搜索银行、户名、主体或店铺" value={keyword} onChange={(e) => setKeyword(e.target.value)} /></div>
        {error && <div role="alert" className="notice error">{error}</div>}
        <div className="metric-row">
          <div className="metric"><span className="muted">重点账户</span><strong>{keyAccounts.length} 个</strong></div>
          <div className="metric"><span className="muted">店铺可提现余额</span><strong>{money(withdrawable)}</strong></div>
          <div className="metric"><span className="muted">店铺账户余额</span><strong>{money(sumBal(storeAccounts))}</strong></div>
          <div className="metric"><span className="muted">公司账户余额</span><strong>{money(sumBal(companyAccounts))}</strong></div>
        </div>
        <p className="muted">余额旁的时间是“最后更新”：24 小时内绿色，3 天内黄色，更久红色。期初取自“银行账户”资料里登记的余额，之后每张已过账的单据都会自动计入。</p>

        <h2 className="section-title">重点账户</h2>
        <AccountTable rows={keyAccounts} now={now} empty="还没有标记重点账户。在下面的账户列表里点“设为重点”，这里就会一直显示（只对你自己生效）。" cols={['type', 'name', 'bank', 'link', 'balance', 'fresh']} sel={sel} onSel={setSel} action={(r) => <KeyBtn r={r} />} name={(r) => <Name r={r} />} />

        <h2 className="section-title between"><span>店铺资金</span><Toggle k="funds" count={stores.length} label="店铺" /></h2>
        <div className="tabs" role="tablist" aria-label="平台">
          <button type="button" role="tab" className={platform === 'all' ? 'tab active' : 'tab'} onClick={() => setPlatform('all')}>全部店铺 {funds.length}</button>
          {platforms.map(([k, l]) => <button key={k} type="button" role="tab" className={platform === k ? 'tab active' : 'tab'} onClick={() => setPlatform(k)}>{l} {funds.filter((f) => f.platform === k).length}</button>)}
        </div>
        {open.funds ? (
          <div className="table-scroll"><table className="data-table">
            <thead><tr><th>店铺</th><th className="num">可提现余额</th><th className="num">保证金</th><th className="num">冻结资金</th><th className="num">推广费余额</th><th>最后更新</th><th>收款账户</th></tr></thead>
            <tbody>
              {stores.length === 0 && <tr><td colSpan={7} className="muted">没有符合条件的店铺。数据在“经营数据 → 店铺资金”里登记或导入。</td></tr>}
              {stores.map((f) => (
                <tr key={f.storeId}><td>{f.platformLabel} / {f.name}<div className="muted">{f.storeNo || '未填写店铺编号'}</div></td>
                  <td className="num">{money(f.withdrawableCents)}</td><td className="num">{money(f.depositCents)}</td><td className="num">{money(f.frozenCents)}</td><td className="num">{money(f.promotionCents)}</td>
                  <td><Fresh at={f.updatedAt} now={now} /></td>
                  <td><button type="button" className="link-button" onClick={() => setRel({ title: `${f.name} · 关联收款账户`, accounts: all.filter((a) => a.storeIds?.includes(f.storeId)) })}>查看账户</button></td></tr>
              ))}
            </tbody>
            <tfoot><tr><th>合计</th><th className="num">{money(withdrawable)}</th><th className="num">{money(stores.reduce((s, f) => s + f.depositCents, 0))}</th><th className="num">{money(stores.reduce((s, f) => s + f.frozenCents, 0))}</th><th className="num">{money(stores.reduce((s, f) => s + f.promotionCents, 0))}</th><th /><th /></tr></tfoot>
          </table></div>
        ) : <p className="muted">已折叠 {stores.length} 家店铺的资金，可提现余额合计 {money(withdrawable)}。选好平台后点右上角“展开”。</p>}

        <h2 className="section-title between"><span>店铺公户与店铺个人银行卡</span><Toggle k="store" count={storeAccounts.length} label="账户" /></h2>
        {open.store ? <AccountTable rows={storeAccounts} now={now} empty="没有店铺收款账户" cols={['type', 'name', 'bank', 'license', 'balance', 'fresh', 'status', 'stores']} sel={sel} onSel={setSel} action={(r) => <KeyBtn r={r} />} name={(r) => <Name r={r} />}
          onStores={(r) => setRel({ title: `${r.title} · 关联店铺`, stores: (r.storeIds ?? []).map((id, i) => ({ id, name: r.storeNames?.[i] ?? `店铺#${id}`, fund: funds.find((f) => f.storeId === id) })) })} />
          : <p className="muted">已折叠 {storeAccounts.length} 个店铺收款账户，当前余额合计 {money(sumBal(storeAccounts))}。</p>}

        <h2 className="section-title between"><span>公司账户</span><Toggle k="company" count={companyAccounts.length} label="账户" /></h2>
        {open.company ? <AccountTable rows={companyAccounts} now={now} empty="没有公司账户" cols={['type', 'name', 'bank', 'keeper', 'balance', 'fresh', 'status']} sel={sel} onSel={setSel} action={(r) => <KeyBtn r={r} />} name={(r) => <Name r={r} />} />
          : <p className="muted">已折叠 {companyAccounts.length} 个公司账户，当前余额合计 {money(sumBal(companyAccounts))}。</p>}

        {sel && (
          <section>
            <div className="between"><h2 className="section-title">{sel.title} · 明细账本</h2>
              <div className="toolbar"><input type="date" aria-label="开始日期" value={from} onChange={(e) => setFrom(e.target.value)} /><span className="muted">至</span><input type="date" aria-label="结束日期" value={to} onChange={(e) => setTo(e.target.value)} /></div>
            </div>
            {ledger && (
              <div className="metric-row">
                <div className="metric"><span className="muted">期初结存</span><strong>{money(ledger.openingCents)}</strong></div>
                <div className="metric"><span className="muted">本期收入</span><strong>{money(ledger.incomeCents)}</strong></div>
                <div className="metric"><span className="muted">本期支出</span><strong>{money(ledger.expenseCents)}</strong></div>
                <div className="metric"><span className="muted">期末结存</span><strong>{money(ledger.closingCents)}</strong></div>
              </div>
            )}
            <div className="table-scroll"><table className="data-table">
              <thead><tr><th>日期</th><th>单号</th><th>类型</th><th>往来对象</th><th>收入</th><th>支出</th><th>结存</th><th>经办人</th><th>备注</th></tr></thead>
              <tbody>
                {ledger?.rows.length === 0 && <tr><td colSpan={9} className="muted">这段时间没有流水</td></tr>}
                {ledger?.rows.map((l) => (
                  <tr key={l.id}><td>{l.entryDate}</td><td className="mono"><button type="button" className="link-button" onClick={() => setDocId(l.documentId)}>{l.docNo}</button></td><td>{l.typeLabel}</td><td>{l.partyName ?? ''}</td><td className="num">{l.amountCents > 0 ? money(l.amountCents) : ''}</td><td className="num">{l.amountCents < 0 ? money(-l.amountCents) : ''}</td><td className="num">{money(l.balanceCents)}</td><td>{l.handler ?? ''}</td><td>{l.memo}</td></tr>
                ))}
              </tbody>
            </table></div>
          </section>
        )}
      </div>
      {rel && (
        <div className="modal-backdrop" role="presentation"><div className="modal card" role="dialog" aria-label={rel.title}>
          <div className="modal-head between"><strong>{rel.title}</strong><button type="button" className="icon-button" aria-label="关闭" onClick={() => setRel(null)}>✕</button></div>
          <div className="modal-body">
            {rel.accounts && (
              <table className="data-table"><thead><tr><th>账户</th><th>开户行</th><th className="num">当前余额</th><th>最后更新</th></tr></thead><tbody>
                {rel.accounts.length === 0 && <tr><td colSpan={4} className="muted">这家店铺还没有关联收款账户。到“银行账户”资料里给账户选上关联店铺即可。</td></tr>}
                {rel.accounts.map((a) => <tr key={a.id}><td>{a.title} <span className="muted">{KIND_LABEL[a.kind] ?? a.kind}</span></td><td>{a.bank}</td><td className="num">{money(a.balanceCents)}</td><td><Fresh at={a.updatedAt} now={now} /></td></tr>)}
              </tbody></table>
            )}
            {rel.stores && (
              <table className="data-table"><thead><tr><th>店铺</th><th className="num">可提现余额</th><th>最后更新</th></tr></thead><tbody>
                {rel.stores.length === 0 && <tr><td colSpan={3} className="muted">这个账户还没有关联店铺。</td></tr>}
                {rel.stores.map((s) => <tr key={s.id}><td>{s.name}</td><td className="num">{money(s.fund?.withdrawableCents ?? 0)}</td><td><Fresh at={s.fund?.updatedAt} now={now} /></td></tr>)}
              </tbody></table>
            )}
          </div>
        </div></div>
      )}
      {docId && <DocDetail key={docId} id={docId} onClose={() => setDocId(null)} onChanged={() => undefined} />}
    </div>
  );
}

type Col = 'type' | 'name' | 'bank' | 'license' | 'keeper' | 'link' | 'balance' | 'fresh' | 'status' | 'stores';
const HEAD: Record<Col, string> = { type: '账户类型', name: '账户', bank: '开户行', license: '所属主体', keeper: '保管人', link: '关联主体/店铺', balance: '当前余额', fresh: '余额最后更新', status: '状态', stores: '关联店铺' };

function AccountTable({ rows, cols, empty, now, sel, onSel, action, name, onStores }: {
  rows: BankBalance[]; cols: Col[]; empty: string; now: number; sel: BankBalance | null; onSel: (r: BankBalance) => void;
  action: (r: BankBalance) => JSX.Element; name: (r: BankBalance) => JSX.Element; onStores?: (r: BankBalance) => void;
}) {
  const cell = (r: BankBalance, c: Col) => {
    switch (c) {
      case 'type': return KIND_LABEL[r.kind] ?? r.kind;
      case 'name': return name(r);
      case 'bank': return r.bank || '-';
      case 'license': return r.licenseName || '-';
      case 'keeper': return r.keeperName || '-';
      case 'link': return (r.storeNames?.length ? r.storeNames.join('、') : r.licenseName) || '-';
      case 'balance': return <span className="strong">{money(r.balanceCents)}</span>;
      case 'fresh': return <Fresh at={r.updatedAt} now={now} />;
      case 'status': return <span className={`pill ${r.status === 'normal' ? 'ok' : 'warn'}`}>{r.status === 'normal' ? '正常' : r.status === 'abnormal' ? '异常' : '停用'}</span>;
      case 'stores': return <button type="button" className="link-button" onClick={() => onStores?.(r)}>查看店铺</button>;
    }
  };
  return (
    <div className="table-scroll"><table className="data-table">
      <thead><tr>{cols.map((c) => <th key={c} className={c === 'balance' ? 'num' : undefined}>{HEAD[c]}</th>)}<th>重点</th></tr></thead>
      <tbody>
        {rows.length === 0 && <tr><td colSpan={cols.length + 1} className="empty-state muted">{empty}</td></tr>}
        {rows.map((r) => (
          <tr key={r.id} className={sel?.id === r.id ? 'selected' : undefined}>
            {cols.map((c) => <td key={c} className={c === 'balance' ? 'num' : undefined}>{cell(r, c)}</td>)}
            <td>{action(r)}</td>
          </tr>
        ))}
      </tbody>
      {rows.length > 0 && <tfoot><tr><th>合计（{rows.length} 个）</th>{cols.slice(1).map((c) => <th key={c} className={c === 'balance' ? 'num' : undefined}>{c === 'balance' ? money(rows.reduce((s, r) => s + r.balanceCents, 0)) : ''}</th>)}<th /></tr></tfoot>}
    </table></div>
  );
}
