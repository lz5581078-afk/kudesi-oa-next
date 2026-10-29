import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../../api/client';
import { DocDetail } from './DocDetail';
import { money } from './common';
import { DateChips, plainYuan } from './fin-ui';
import { financeApi, type BankBalance, type Ledger, type StoreFund } from './financeApi';
import { fmtUpdated } from './freshness';
import { AccountNo, Fresh, KIND_LABEL, STORE_KINDS, has } from './query/AccountParts';
import { ExportButton, Field, FilterBar, QueryPage, QueryPanel, QueryTable, SummaryCards, stamp, type Col } from './query/QueryKit';

type Rel = { title: string; accounts?: BankBalance[]; stores?: Array<{ id: number; name: string; fund?: StoreFund }> };
const sum = (l: BankBalance[]) => l.reduce((s, r) => s + r.balanceCents, 0);

/**
 * 现金银行查询（按旧版 10-24 的版式）：账户查询条 → 四张汇总卡 → 重点账户 → 店铺资金（按平台分页签，可折叠）
 * → 店铺公户与店铺个人银行卡（可折叠）→ 公司账户（可折叠）；点账户名下面出现明细账本（期初、收入、支出、期末，点单号看原单据）。
 * 余额 = 银行账户资料里登记的期初余额 + 已过账单据的流水；余额旁标着最后更新时间，越久没更新颜色越重。
 */
export function CashBankPage() {
  const [now, setNow] = useState(() => Date.now());
  const [at, setAt] = useState<Date | null>(null);
  const [rows, setRows] = useState<BankBalance[] | null>(null);
  const [funds, setFunds] = useState<StoreFund[]>([]);
  const [keys, setKeys] = useState<number[]>([]);
  const [error, setError] = useState('');
  const [keyword, setKeyword] = useState('');
  const [kind, setKind] = useState('');
  const [platform, setPlatform] = useState('all');
  const [open, setOpen] = useState({ funds: false, store: false, company: false });
  const [sel, setSel] = useState<BankBalance | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [docId, setDocId] = useState<number | null>(null);
  const [rel, setRel] = useState<Rel | null>(null);
  const ledgerRef = useRef<HTMLDivElement>(null);
  const fail = (e: unknown) => setError(e instanceof ApiError ? e.message : '加载失败');

  const load = () => {
    setError(''); setRows(null);
    Promise.all([financeApi.banks(), financeApi.storeFunds().catch(() => [] as StoreFund[])]).then(([b, f]) => { setRows(b); setFunds(f); setNow(Date.now()); setAt(new Date()); }).catch((e) => { setRows([]); fail(e); });
  };
  useEffect(load, []);
  useEffect(() => { financeApi.keyAccounts().then(setKeys).catch(() => undefined); }, []);
  useEffect(() => {
    if (!sel) return;
    setLedger(null);
    financeApi.ledger(sel.id, { from: from || undefined, to: to || undefined }).then(setLedger).catch(fail);
  }, [sel, from, to]);
  useEffect(() => { if (sel) ledgerRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }); }, [sel]);

  const all = rows ?? [];
  const accounts = useMemo(() => all.filter((r) => (!kind || r.kind === kind) && has(`${r.title} ${r.bank ?? ''} ${r.ownerName ?? ''} ${r.licenseName ?? ''} ${(r.storeNames ?? []).join(' ')}`, keyword)), [all, keyword, kind]);
  const stores = useMemo(() => funds.filter((f) => (platform === 'all' || f.platform === platform) && has(`${f.name} ${f.platformLabel ?? ''} ${f.storeNo ?? ''}`, keyword)), [funds, platform, keyword]);
  const platforms = useMemo(() => { const m = new Map<string, string>(); for (const f of funds) if (f.platform) m.set(f.platform, f.platformLabel ?? f.platform); return [...m.entries()]; }, [funds]);
  const storeAccounts = accounts.filter((r) => STORE_KINDS.includes(r.kind));
  const companyAccounts = accounts.filter((r) => !STORE_KINDS.includes(r.kind));
  const keyAccounts = accounts.filter((r) => keys.includes(r.id));
  const withdrawable = stores.reduce((s, f) => s + f.withdrawableCents, 0);

  const toggleKey = (id: number) => {
    const on = !keys.includes(id);
    setKeys(on ? [...keys, id] : keys.filter((k) => k !== id)); // 先改界面，失败再还原
    financeApi.setKeyAccount(id, on).then(setKeys).catch((e) => { fail(e); financeApi.keyAccounts().then(setKeys).catch(() => undefined); });
  };

  // ---- 列定义（三张账户表共用一套，按用途挑选）----
  const A = {
    type: { key: 'type', head: '账户类型', cell: (r) => KIND_LABEL[r.kind] ?? r.kind, csv: (r) => KIND_LABEL[r.kind] ?? r.kind } as Col<BankBalance>,
    name: { key: 'name', head: '账户', primary: true, cell: (r) => <button type="button" className="link-button" onClick={() => setSel(r)}>{r.title}</button>, csv: (r) => r.title } as Col<BankBalance>,
    no: { key: 'no', head: '账号', cell: (r) => <AccountNo id={r.id} /> } as Col<BankBalance>,
    bank: { key: 'bank', head: '开户行', cell: (r) => r.bank || '-', csv: (r) => r.bank } as Col<BankBalance>,
    license: { key: 'license', head: '所属主体', cell: (r) => r.licenseName || '-', csv: (r) => r.licenseName } as Col<BankBalance>,
    keeper: { key: 'keeper', head: '保管人', cell: (r) => r.keeperName || '-', csv: (r) => r.keeperName } as Col<BankBalance>,
    link: { key: 'link', head: '关联主体/店铺', cell: (r) => (r.storeNames?.length ? r.storeNames.join('、') : r.licenseName) || '-', csv: (r) => (r.storeNames?.length ? r.storeNames.join('、') : r.licenseName) } as Col<BankBalance>,
    balance: { key: 'balance', head: '当前余额', num: true, cell: (r) => <span className="strong">{money(r.balanceCents)}</span>, sum: (l) => money(sum(l)), csv: (r) => plainYuan(r.balanceCents) } as Col<BankBalance>,
    fresh: { key: 'fresh', head: '余额最后更新', cell: (r) => <Fresh at={r.updatedAt} now={now} />, csv: (r) => fmtUpdated(r.updatedAt) } as Col<BankBalance>,
    status: { key: 'status', head: '状态', cell: (r) => <span className={`pill ${r.status === 'normal' ? 'ok' : 'warn'}`}>{r.status === 'normal' ? '正常' : r.status === 'abnormal' ? '异常' : '停用'}</span>, csv: (r) => r.status } as Col<BankBalance>,
    stores: { key: 'stores', head: '关联店铺', action: true, cell: (r) => <button type="button" className="link-button" onClick={() => setRel({ title: `${r.title} · 关联店铺`, stores: (r.storeIds ?? []).map((id, i) => ({ id, name: r.storeNames?.[i] ?? `店铺#${id}`, fund: funds.find((f) => f.storeId === id) })) })}>查看店铺</button> } as Col<BankBalance>,
    key: { key: 'key', head: '重点', action: true, cell: (r) => <button type="button" className="link-button" onClick={() => toggleKey(r.id)}>{keys.includes(r.id) ? '取消重点' : '设为重点'}</button> } as Col<BankBalance>,
  };
  const keyCols = [A.type, A.name, A.no, A.bank, A.link, A.balance, A.fresh, A.key];
  const storeCols = [A.type, A.name, A.no, A.bank, A.license, A.balance, A.fresh, A.status, A.stores, A.key];
  const companyCols = [A.type, A.name, A.no, A.bank, A.keeper, A.balance, A.fresh, A.status, A.key];
  const exportCols = [A.type, A.name, A.bank, A.license, A.keeper, A.link, A.balance, A.fresh, A.status];

  const fundCols: Array<Col<StoreFund>> = [
    { key: 'store', head: '店铺', primary: true, cell: (f) => <>{f.platformLabel} / {f.name}<div className="muted">{f.storeNo || '未填写店铺编号'}</div></>, csv: (f) => `${f.platformLabel} / ${f.name}` },
    { key: 'w', head: '可提现余额', num: true, cell: (f) => money(f.withdrawableCents), sum: (l) => money(l.reduce((s, f) => s + f.withdrawableCents, 0)), csv: (f) => plainYuan(f.withdrawableCents) },
    { key: 'd', head: '保证金', num: true, cell: (f) => money(f.depositCents), sum: (l) => money(l.reduce((s, f) => s + f.depositCents, 0)), csv: (f) => plainYuan(f.depositCents) },
    { key: 'f', head: '冻结资金', num: true, cell: (f) => money(f.frozenCents), sum: (l) => money(l.reduce((s, f) => s + f.frozenCents, 0)), csv: (f) => plainYuan(f.frozenCents) },
    { key: 'p', head: '推广费余额', num: true, cell: (f) => money(f.promotionCents), sum: (l) => money(l.reduce((s, f) => s + f.promotionCents, 0)), csv: (f) => plainYuan(f.promotionCents) },
    { key: 'u', head: '最后更新', cell: (f) => <Fresh at={f.updatedAt} now={now} />, csv: (f) => fmtUpdated(f.updatedAt) },
    { key: 'acc', head: '收款账户', action: true, cell: (f) => <button type="button" className="link-button" onClick={() => setRel({ title: `${f.name} · 关联收款账户`, accounts: all.filter((a) => a.storeIds?.includes(f.storeId)) })}>查看账户</button> },
  ];

  const Toggle = ({ k, count, label }: { k: keyof typeof open; count: number; label: string }) => <button type="button" className="secondary-button small" onClick={() => setOpen({ ...open, [k]: !open[k] })}>{open[k] ? `收起${label}` : `展开 ${count} 个${label}`}</button>;
  const accountTable = (list: BankBalance[], cols: Array<Col<BankBalance>>, empty: ReactNode, caption: string) => (
    <QueryTable cols={cols} rows={rows === null ? null : list} rowKey={(r) => r.id} empty={empty} caption={caption} selectedKey={sel?.id ?? null} loading="正在读取账户余额…" footLabel={(l) => `合计（${l.length} 个）`} />
  );

  return (
    <div className={docId ? 'split' : undefined}>
      <div className="split-main">
        <QueryPage title="现金银行查询" subtitle="按电商资金路径查看重点账户、店铺可提现资金、店铺收款账户和公司层面账户余额。"
          actions={<>{at && <span className="muted qk-stamp">数据时间 {stamp(at)}</span>}<button type="button" className="secondary-button small" onClick={load}>刷新</button><ExportButton name="现金银行账户余额.csv" cols={exportCols} rows={accounts} label="导出账户余额" /></>}>
          <FilterBar title="账户查询" live onReset={() => { setKeyword(''); setKind(''); setPlatform('all'); }}>
            <Field label="关键词" wide><input type="search" aria-label="搜索账户" placeholder="搜索银行、户名、主体或店铺" value={keyword} onChange={(e) => setKeyword(e.target.value)} /></Field>
            <Field label="账户类型"><select aria-label="账户类型" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">全部类型</option>{Object.entries(KIND_LABEL).filter(([k]) => all.some((r) => r.kind === k)).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          </FilterBar>
          {error && <div role="alert" className="notice error">{error}</div>}
          <SummaryCards items={[
            { label: '重点账户', value: `${keyAccounts.length} 个` },
            { label: '店铺可提现余额', value: money(withdrawable), tone: 'ok' },
            { label: '店铺账户余额', value: money(sum(storeAccounts)) },
            { label: '公司账户余额', value: money(sum(companyAccounts)), tone: 'accent' },
          ]} />
          <p className="muted qk-note">余额旁的时间是“最后更新”：24 小时内绿色，3 天内黄色，更久红色。期初取自“银行账户”资料里登记的余额，之后每张已过账的单据都会自动计入。</p>

          <QueryPanel title="重点账户" hint="每个人自己标记，只对你自己生效">
            {accountTable(keyAccounts, keyCols, '还没有标记重点账户。在下面的账户列表里点“设为重点”，这里就会一直显示（只对你自己生效）。', '重点账户')}
          </QueryPanel>

          <QueryPanel title="店铺资金" actions={<Toggle k="funds" count={stores.length} label="店铺" />} collapsed={!open.funds}
            always={
              <div className="tabs" role="tablist" aria-label="平台">
                <button type="button" role="tab" aria-selected={platform === 'all'} className={platform === 'all' ? 'tab active' : 'tab'} onClick={() => setPlatform('all')}>全部店铺 {funds.length}</button>
                {platforms.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={platform === k} className={platform === k ? 'tab active' : 'tab'} onClick={() => setPlatform(k)}>{l} {funds.filter((f) => f.platform === k).length}</button>)}
              </div>
            }
            collapsedHint={`已折叠 ${stores.length} 家店铺的资金，可提现余额合计 ${money(withdrawable)}。选好平台后点右上角“展开”。`}>
            <QueryTable cols={fundCols} rows={stores} rowKey={(f) => f.storeId} caption="店铺资金" empty="没有符合条件的店铺。数据在“经营数据 → 店铺资金”里登记或导入。" />
          </QueryPanel>

          <QueryPanel title="店铺公户与店铺个人银行卡" actions={<Toggle k="store" count={storeAccounts.length} label="账户" />} collapsed={!open.store}
            collapsedHint={`已折叠 ${storeAccounts.length} 个店铺收款账户，当前余额合计 ${money(sum(storeAccounts))}。`}>
            {accountTable(storeAccounts, storeCols, '没有店铺收款账户', '店铺收款账户')}
          </QueryPanel>

          <QueryPanel title="公司账户" actions={<Toggle k="company" count={companyAccounts.length} label="账户" />} collapsed={!open.company}
            collapsedHint={`已折叠 ${companyAccounts.length} 个公司账户，当前余额合计 ${money(sum(companyAccounts))}。`}>
            {accountTable(companyAccounts, companyCols, '没有公司账户', '公司账户')}
          </QueryPanel>

          {sel && (
            <div ref={ledgerRef}>
              <QueryPanel title={`${sel.title} · 明细账本`} actions={<>
                <DateChips from={from} to={to} onChange={(a, b) => { setFrom(a); setTo(b); }} />
                <input type="date" aria-label="开始日期" value={from} onChange={(e) => setFrom(e.target.value)} /><span className="muted">至</span><input type="date" aria-label="结束日期" value={to} onChange={(e) => setTo(e.target.value)} />
                <button type="button" className="secondary-button small" onClick={() => setSel(null)}>关闭账本</button></>}>
                {ledger && <SummaryCards items={[{ label: '期初结存', value: money(ledger.openingCents) }, { label: '本期收入', value: money(ledger.incomeCents), tone: 'ok' }, { label: '本期支出', value: money(ledger.expenseCents), tone: 'warn' }, { label: '期末结存', value: money(ledger.closingCents), tone: 'accent' }]} />}
                <QueryTable<Ledger['rows'][number]> rows={ledger?.rows ?? null} rowKey={(l) => l.id} caption="明细账本" foot={false} empty="这段时间没有流水" loading="正在读取流水…"
                  cols={[
                    { key: 'd', head: '日期', cell: (l) => l.entryDate },
                    { key: 'no', head: '单号', primary: true, cell: (l) => <span className="mono"><button type="button" className="link-button" onClick={() => setDocId(l.documentId)}>{l.docNo}</button></span> },
                    { key: 't', head: '类型', cell: (l) => l.typeLabel },
                    { key: 'p', head: '往来对象', cell: (l) => l.partyName ?? '' },
                    { key: 'in', head: '收入', num: true, cell: (l) => (l.amountCents > 0 ? money(l.amountCents) : '') },
                    { key: 'out', head: '支出', num: true, cell: (l) => (l.amountCents < 0 ? money(-l.amountCents) : '') },
                    { key: 'b', head: '结存', num: true, cell: (l) => money(l.balanceCents) },
                    { key: 'h', head: '经办人', cell: (l) => l.handler ?? '' },
                    { key: 'm', head: '备注', cell: (l) => l.memo ?? '' },
                  ]} />
                {ledger && <div className="qk-foot-actions"><ExportButton name={`${sel.title}-明细账本.csv`} rows={ledger.rows} label="导出账本" cols={[
                  { key: 'd', head: '日期', cell: () => null, csv: (l) => l.entryDate }, { key: 'no', head: '单号', cell: () => null, csv: (l) => l.docNo }, { key: 't', head: '类型', cell: () => null, csv: (l) => l.typeLabel },
                  { key: 'p', head: '往来对象', cell: () => null, csv: (l) => l.partyName }, { key: 'in', head: '收入', cell: () => null, csv: (l) => (l.amountCents > 0 ? plainYuan(l.amountCents) : '') },
                  { key: 'out', head: '支出', cell: () => null, csv: (l) => (l.amountCents < 0 ? plainYuan(-l.amountCents) : '') }, { key: 'b', head: '结存', cell: () => null, csv: (l) => plainYuan(l.balanceCents) },
                  { key: 'h', head: '经办人', cell: () => null, csv: (l) => l.handler }, { key: 'm', head: '备注', cell: () => null, csv: (l) => l.memo },
                ]} /></div>}
              </QueryPanel>
            </div>
          )}
        </QueryPage>
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
