import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../api/client';
import { recordLink } from './recordLink';
import { resourceApi, type DataIssuesResult, type ExpiringResult, type OverviewResult } from './api';

export function ResourceOverviewPage() {
  const [data, setData] = useState<OverviewResult | null>(null);
  const [exp, setExp] = useState<ExpiringResult | null>(null);
  const [issues, setIssues] = useState<DataIssuesResult | null>(null);
  const [days, setDays] = useState(30);
  const [error, setError] = useState('');
  useEffect(() => {
    resourceApi.overview().then(setData).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败'));
  }, []);
  useEffect(() => {
    resourceApi.dataIssues().then(setIssues).catch(() => setIssues(null));
  }, []);
  useEffect(() => {
    resourceApi.expiring(days).then(setExp).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败'));
  }, [days]);
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
        <div className="card-foot between">
          <span><strong>即将到期 / 已过期</strong>{exp ? `（已过期 ${exp.counts.expired}，${days} 天内到期 ${exp.counts.dueSoon}）` : ''}</span>
          <select aria-label="提前天数" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[7, 30, 60, 90, 180, 366].map((d) => <option key={d} value={d}>{d} 天内</option>)}
          </select>
        </div>
        <table className="data-table">
          <thead><tr><th>资料</th><th>名称</th><th>事项</th><th>日期</th><th>剩余</th></tr></thead>
          <tbody>
            {exp?.rows.map((a) => (
              <tr key={`${a.type}-${a.id}-${a.field}`}>
                <td>{a.typeLabel}</td>
                <td>{recordLink(a.type, a.id) ? <Link to={recordLink(a.type, a.id)!}>{a.name}</Link> : a.name}</td>
                <td>{a.fieldLabel}</td>
                <td>{a.dueDate}</td>
                <td>{a.daysLeft < 0 ? <span className="pill bad">已过 {-a.daysLeft} 天</span> : <span className="pill warn">{a.daysLeft} 天</span>}</td>
              </tr>
            ))}
            {exp && exp.rows.length === 0 && <tr><td colSpan={5} className="muted center">暂无到期事项</td></tr>}
          </tbody>
        </table>
      </section>
      {issues && (
        <section className="card" aria-label="数据问题">
          <div className="card-foot"><strong>数据问题</strong><span className="muted">（共 {issues.total} 处，只读检查，改好资料后自动消失）</span></div>
          {issues.groups.filter((g) => g.count > 0).length === 0 && <p className="muted pad">没有发现数据问题</p>}
          {issues.groups.filter((g) => g.count > 0).map((g) => (
            <details key={g.key} className="pad">
              <summary><strong>{g.label}</strong> <span className="pill warn">{g.count}</span></summary>
              <p className="muted">{g.description}</p>
              <ul>
                {g.rows.map((r, i) => (
                  <li key={`${r.id}-${i}`}>{recordLink(r.type, r.id) ? <Link to={recordLink(r.type, r.id)!}>{r.name}</Link> : r.name}{r.detail ? <span className="muted">　{r.detail}</span> : null}</li>
                ))}
              </ul>
              {g.count > g.rows.length && <p className="muted">只显示前 {g.rows.length} 条</p>}
            </details>
          ))}
        </section>
      )}
    </div>
  );
}
