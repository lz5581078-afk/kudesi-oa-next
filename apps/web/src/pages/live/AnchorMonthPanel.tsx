import { useEffect, useState } from 'react';
import {
  anchorMonthApi,
  type AnchorPeriod,
  type AnchorMonthData,
  type AnchorMonthSession,
  type AnchorMonthSummary,
} from './anchorMonthApi';
import { dt, hm, errText, minutesText, money } from './liveFormat';
import { SessionDetailDialog } from './SessionDetailDialog';
import './anchorMonth.css';
function ActualLiveTime({ session }: { session: AnchorMonthSession }) {
  const { startAt, endAt, status } = session;
  const date = startAt?.slice(0, 10) || session.date;
  const end = endAt ? hm(endAt, date) : status === 'live' ? '直播中' : '下播时间待补充';
  return (
    <td>
      {date}
      <small>
        {startAt ? hm(startAt) : '开播时间待补充'} 至 {end}
      </small>
    </td>
  );
}
export function AnchorMonthTotals({
  summary: s,
  canViewCommission,
  label = '本月',
}: {
  summary: AnchorMonthSummary;
  canViewCommission: boolean;
  label?: string;
}) {
  return (
    <>
      <dl className="anchor-month-totals">
        <div>
          <dt>{label}场次</dt>
          <dd>
            {s.sessionCount}
            <small> 场</small>
          </dd>
        </div>
        <div>
          <dt>{label}直播时长</dt>
          <dd>{minutesText(s.minutes)}</dd>
        </div>
        <div>
          <dt>{label}营业额</dt>
          <dd>{money(s.turnoverCents)}</dd>
        </div>
        <div>
          <dt>{label}工资</dt>
          <dd>{!canViewCommission ? '无查看权限' : s.wageCents == null ? '待更新' : money(s.wageCents)}</dd>
          {canViewCommission && s.pendingWageSessions > 0 && (
            <small>{s.pendingWageSessions} 场待核定</small>
          )}
        </div>
        <div>
          <dt>{label}提成</dt>
          <dd>{canViewCommission ? money(s.commissionCents ?? 0) : '无查看权限'}</dd>
        </div>
      </dl>
      {(s.missingTimeSessions > 0 || s.missingSalesSessions > 0 || s.missingCommissionSessions > 0) && (
        <p className="anchor-month-incomplete">
          以上为已统计部分：
          {[
            s.missingTimeSessions ? `${s.missingTimeSessions}场时长待补充/修复` : '',
            s.missingSalesSessions ? `${s.missingSalesSessions}场营业额待补充` : '',
            s.missingCommissionSessions ? `${s.missingCommissionSessions}场提成待补充` : '',
          ]
            .filter(Boolean)
            .join('；')}
          。
        </p>
      )}
    </>
  );
}
export function AnchorMonthPanel({
  userId,
  onOverlayChange,
}: {
  userId: number;
  onOverlayChange?: (open: boolean) => void;
}) {
  const periods: { value: AnchorPeriod; label: string }[] = [
    { value: 'month', label: '本月' },
    { value: '3d', label: '近 3 天' },
    { value: '7d', label: '近一周' },
    { value: '30d', label: '近 30 天' },
  ];
  const [period, setPeriod] = useState<AnchorPeriod>('month');
  const label = periods.find((item) => item.value === period)!.label;
  const [data, setData] = useState<AnchorMonthData | null>(null),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(0),
    [session, setSession] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    setData(null);
    setError('');
    if (Number.isSafeInteger(userId) && userId > 0)
      (period === 'month' ? anchorMonthApi.read(userId) : anchorMonthApi.read(userId, period))
        .then((x) => {
          if (alive) setData(x);
        })
        .catch((e) => {
          if (alive) setError(errText(e, '直播资料读取失败'));
        });
    return () => {
      alive = false;
    };
  }, [userId, retry, period]);
  useEffect(() => {
    onOverlayChange?.(session !== null);
    return () => onOverlayChange?.(false);
  }, [session, onOverlayChange]);
  useEffect(() => setSession(null), [userId]);
  const person = data?.items.find((p) => p.userId === userId);
  const open = (id: number) => {
    onOverlayChange?.(true);
    setSession(id);
  };
  return (
    <section className="anchor-month-panel" aria-label="主播直播业绩">
      <header>
        <div>
          <h3>
            {label}直播业绩{' '}
            {data && <small>{period === 'month' ? data.month : `${data.from} 至 ${data.through}`}</small>}
          </h3>
          <p>北京时间 · 按场次开播日统计 · 含今天 · 包含未审核场次</p>
        </div>
        <button type="button" className="secondary-button" onClick={() => setRetry((x) => x + 1)}>
          刷新业绩
        </button>
      </header>
      <div className="anchor-period-picker" role="group" aria-label="业绩统计周期">
        {periods.map((item) => (
          <button
            type="button"
            key={item.value}
            aria-pressed={period === item.value}
            onClick={() => {
              if (period === item.value) return;
              setData(null);
              setError('');
              setPeriod(item.value);
            }}
          >
            {item.label}业绩
          </button>
        ))}
      </div>
      {error ? (
        <p className="notice" role="status">
          {error}
        </p>
      ) : !person ? (
        <p className="muted" role="status">
          正在读取直播资料…
        </p>
      ) : (
        <>
          <AnchorMonthTotals
            summary={person.summary}
            canViewCommission={data!.canViewCommission}
            label={label}
          />
          <p className="muted">
            工资只计已核定的主播计时工资，不含提成。未审核提成为预估，已审核采用核定结果；缺失数据单独提示，不重复累计。
            {data?.asOf && ` 数据截至 ${dt(data.asOf)}`}
          </p>
          {!person.sessions?.length ? (
            <p className="anchor-month-empty">{label}暂无实际直播场次</p>
          ) : (
            <div className="anchor-month-table">
              <table>
                <thead>
                  <tr>
                    <th>日期 / 直播间</th>
                    <th>实际直播时间</th>
                    <th>时长</th>
                    <th>营业额</th>
                    <th>工资</th>
                    <th>提成</th>
                    <th>状态</th>
                    <th>
                      <span className="sr-only">操作</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {person.sessions.map((s) => (
                    <tr key={s.id}>
                      <td>
                        {s.date}
                        <small>{s.roomName}</small>
                      </td>
                      <ActualLiveTime session={s} />
                      <td>{s.minutes === null ? '待修复' : minutesText(s.minutes)}</td>
                      <td>{s.turnoverCents === null ? '待补充' : money(s.turnoverCents)}</td>
                      <td>{!data!.canViewCommission ? '无查看权限' : s.wageCents == null ? '待核定' : money(s.wageCents)}</td>
                      <td>
                        {!data!.canViewCommission
                          ? '无查看权限'
                          : s.commissionCents === null
                            ? '待补充'
                            : money(s.commissionCents)}
                      </td>
                      <td>{s.status === 'live' ? '直播中' : s.estimated ? '未审核 · 预估' : '已审核'}</td>
                      <td>
                        {data!.canOpenSession && (
                          <button type="button" className="link-button" onClick={() => open(s.id)}>
                            场次详情
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {session !== null && (
        <SessionDetailDialog
          id={session}
          onClose={() => {
            setSession(null);
            onOverlayChange?.(false);
          }}
          onChanged={() => setRetry((x) => x + 1)}
        />
      )}
    </section>
  );
}
