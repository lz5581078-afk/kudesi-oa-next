import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { RESOURCE_VIEWS } from '@kudesi/shared';
import { api, ApiError } from '../../api/client';
import { money } from '../finance/common';

interface Summary {
  totalCents: number; companyCents: number; storeCents: number; abnormalCount: number;
  kinds: Array<{ kind: string; count: number; abnormalCount: number; inactiveCount: number; balanceCents: number }>;
  recent: Array<{ id: number; kind: string | null; title: string; status: string; bank: string | null; owner: string | null; accountNo: string | null; balanceCents: number }>;
}

const KIND_LABEL: Record<string, string> = { company_public: '公司公户', company_card: '公司银行卡', cashier_account: '公司出纳账户', store_public: '店铺公户', store_personal_card: '店铺个人银行卡' };
const STATUS_LABEL: Record<string, string> = { normal: '正常', abnormal: '异常', inactive: '已停用' };
const viewPath = (kind: string | null) => `/resource/${RESOURCE_VIEWS.find((v) => v.tab === kind)?.id ?? 'bank-accounts'}`;

/** 资金概况：汇总各类银行账户的余额（期初余额 + 财务现金银行已过账流水；停用、已归档的账户不计入）。 */
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
              <thead><tr><th>类型</th><th className="num">账户数</th><th className="num">异常</th><th className="num">已停用</th><th className="num">余额</th></tr></thead>
              <tbody>{data.kinds.map((k) => (
                <tr key={k.kind}>
                  <td><Link to={viewPath(k.kind)}>{KIND_LABEL[k.kind]}</Link></td>
                  <td className="num">{k.count}</td><td className="num">{k.abnormalCount}</td><td className="num">{k.inactiveCount}</td><td className="num">{money(k.balanceCents)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <div className="card">
            <h2>最近登记</h2>
            <table className="data-table">
              <thead><tr><th>户名</th><th>类型</th><th>开户行</th><th>账号</th><th>所属人</th><th className="num">余额</th><th>状态</th></tr></thead>
              <tbody>
                {data.recent.map((a) => (
                  <tr key={a.id}>
                    <td><Link to={`${viewPath(a.kind)}?open=${a.id}`}>{a.title}</Link></td>
                    <td>{KIND_LABEL[a.kind ?? ''] ?? '-'}</td><td>{a.bank ?? '-'}</td><td className="mono">{a.accountNo ?? '-'}</td><td>{a.owner ?? '-'}</td>
                    <td className="num">{money(a.balanceCents)}</td><td>{STATUS_LABEL[a.status] ?? a.status}</td>
                  </tr>
                ))}
                {data.recent.length === 0 && <tr><td colSpan={7} className="muted">还没有银行账户资料。</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="muted">余额 = 资料里登记的期初余额 + 财务现金银行已过账的收支流水，与「现金银行查询」一致。</p>
        </>
      )}
    </section>
  );
}
