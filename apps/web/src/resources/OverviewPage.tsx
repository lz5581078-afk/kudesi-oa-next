import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../api/client';
import { resourceApi, type OverviewResult } from './api';

export function ResourceOverviewPage() {
  const [data, setData] = useState<OverviewResult | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    resourceApi.overview().then(setData).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败'));
  }, []);
  return (
    <div className="stack">
      <div className="page-head"><h1>资料总览</h1></div>
      {error && <div role="alert" className="notice error">{error}</div>}
      <div className="stats">
        {data?.items.map((i) => (
          <Link key={i.type} to={`/resource/${i.type}`} className="card stat link-card">
            <span className="muted">{i.label}</span>
            <strong>{i.total}</strong>
            {i.abnormal > 0 ? <span className="pill warn">异常 {i.abnormal}</span> : <span className="muted">无异常</span>}
          </Link>
        ))}
      </div>
      <section className="card">
        <div className="card-foot"><strong>需要关注</strong>（已过期、或即将到期）</div>
        <table className="data-table">
          <thead><tr><th>资料</th><th>名称</th><th>事项</th><th>剩余</th></tr></thead>
          <tbody>
            {data?.alerts.map((a) => (
              <tr key={`${a.type}-${a.id}-${a.label}`}>
                <td>{a.typeLabel}</td>
                <td><Link to={`/resource/${a.type}`}>{a.title}</Link></td>
                <td>{a.label}</td>
                <td>{a.days < 0 ? <span className="pill bad">已过 {-a.days} 天</span> : <span className="pill warn">{a.days} 天</span>}</td>
              </tr>
            ))}
            {data && data.alerts.length === 0 && <tr><td colSpan={4} className="muted center">暂无预警</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  );
}
