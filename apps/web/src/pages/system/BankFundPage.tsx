import { useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { money } from '../finance/common';

interface Summary {
  totalCents: number; companyCents: number; storeCents: number; abnormalCount: number;
  kinds: Array<{ kind: string; count: number; balanceCents: number }>;
  recent: Array<{ id: number; kind: string | null; title: string; status: string; bank: string | null; owner: string | null; balanceCents: number }>;
}

const KIND_LABEL: Record<string, string> = { company_public: '公司公户', company_card: '公司银行卡', cashier_account: '公司出纳账户', store_public: '店铺公户', store_personal_card: '店铺个人银行卡' };
const STATUS_LABEL: Record<string, string> = { normal: '正常', abnormal: '异常', inactive: '已停用' };

/** 资金概况：汇总公司公户、公司银行卡、出纳账户、店铺公户和店铺个人银行卡的登记余额（停用账户不计入余额）。 */
export function BankFundPage() {
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api<Summary>('/bank-fund').then(setData).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败')); }, []);
  return (
    <section className="page">
      <h1>资金概况</h1>
      {error && <div role="alert" className="notice error">{error}</div>}
      {data && (
        <>
          <div className="metric-row">
            <div className="metric"><span className="muted">账户总余额</span><strong>{money(data.totalCents)}</strong></div>
            <div className="metric"><span className="muted">公司账户余额</span><strong>{money(data.companyCents)}</strong></div>
            <div className="metric"><span className="muted">店铺账户余额</span><strong>{money(data.storeCents)}</strong></div>
            <div className="metric"><span className="muted">异常账户</span><strong>{data.abnormalCount}</strong></div>
          </div>
          <div className="card">
            <h2>账户分类</h2>
            <table className="data-table">
              <thead><tr><th>类型</th><th className="num">账户数</th><th className="num">余额</th></tr></thead>
              <tbody>{data.kinds.map((k) => <tr key={k.kind}><td>{KIND_LABEL[k.kind]}</td><td className="num">{k.count}</td><td className="num">{money(k.balanceCents)}</td></tr>)}</tbody>
            </table>
          </div>
          <div className="card">
            <h2>最近账户资料</h2>
            <table className="data-table">
              <thead><tr><th>类型</th><th>户名</th><th>开户行</th><th>所属人</th><th className="num">余额</th><th>状态</th></tr></thead>
              <tbody>
                {data.recent.map((a) => (
                  <tr key={a.id}><td>{KIND_LABEL[a.kind ?? ''] ?? '-'}</td><td>{a.title}</td><td>{a.bank ?? '-'}</td><td>{a.owner ?? '-'}</td><td className="num">{money(a.balanceCents)}</td><td>{STATUS_LABEL[a.status] ?? a.status}</td></tr>
                ))}
                {data.recent.length === 0 && <tr><td colSpan={6} className="muted">还没有银行账户资料。</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="muted">余额是资料里手工登记的“当前余额”；按过账流水算的余额在财务的「现金银行查询」里。</p>
        </>
      )}
    </section>
  );
}
