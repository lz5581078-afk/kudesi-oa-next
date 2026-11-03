import { RunDetail } from '../flow/RunDetail';
import { useCallback, useEffect, useState, useRef } from 'react';
import { useAuth } from '../../auth/AuthContext';
import {
  dailyWorkApi,
  type DailyWorkList,
  type DailyWorkRow,
  type DailyPerson,
} from './dailyWorkApi';
import { liveApi } from './liveApi';
import { errText, money, todayText } from './liveFormat';
import { Modal } from './liveUi';
import { qrMatrix, qrSvgPath } from '../../lib/qr';
import './dailyWork.css';

function DailyQr() {
  const { user } = useAuth();
  const [token, setToken] = useState<string | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    liveApi
      .checkinQr()
      .then((c) => {
        if (current) setToken(c.token);
      })
      .catch((e) => {
        if (current) setError(errText(e));
      });
    return () => {
      current = false;
    };
  }, []);
  const link =
    token && user
      ? `${location.origin}/features/live-desk?daily=1&company=${user.companyId}&token=${token}`
      : null;
  const svg = link ? qrSvgPath(qrMatrix(link)) : null;
  return (
    <div className="daily-qr">
      {error && <p role="alert">{error}</p>}
      {svg ? (
        <>
          <svg
            width="220"
            height="220"
            role="img"
            aria-label="直播办公室日常工作二维码"
            viewBox={`0 0 ${svg.size} ${svg.size}`}
          >
            <rect width="100%" height="100%" fill="white" />
            <path d={svg.path} fill="#111827" />
          </svg>
          <a href={link!}>打开日常工作</a>
        </>
      ) : (
        <p>尚无二维码，请先在“上下播二维码”生成。</p>
      )}
      <p className="muted">
        使用本人飞书扫码，仅能开始本人排班中的日常工作。长期有效；重新生成通用二维码后，办公室旧码也会失效。
      </p>
      <button
        type="button"
        disabled={!svg}
        onClick={() => {
          const w = window.open('', '_blank');
          if (!w || !svg) return;
          const h = w.document.createElement('h1');
          h.textContent = '直播办公室 · 日常工作';
          w.document.body.append(h);
          const graphic = document.querySelector(
            'svg[aria-label="直播办公室日常工作二维码"]',
          );
          if (graphic) w.document.body.append(graphic.cloneNode(true));
          const p = w.document.createElement('p');
          p.textContent =
            '请用本人飞书扫码。仅在排班时间内可开始日常工作，完成后扫码结束。';
          w.document.body.append(p);
          w.print();
        }}
      >
        打印二维码
      </button>
    </div>
  );
}

function DailySchedule({
  date,
  onClose,
  onDone,
}: {
  date: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [options, setOptions] = useState<DailyPerson[] | null>(null),
    [role, setRole] = useState<'anchor' | 'control'>('anchor'),
    [person, setPerson] = useState(''),
    [start, setStart] = useState(`${date}T09:00`),
    [end, setEnd] = useState(`${date}T10:00`),
    [content, setContent] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    dailyWorkApi
      .options()
      .then((x) => {
        if (active) setOptions(x);
      })
      .catch((e) => {
        if (active) setError(errText(e));
      });
    return () => {
      active = false;
    };
  }, []);
  async function save() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await dailyWorkApi.schedule({
        userId: Number(person),
        role,
        startAt: start.replace('T', ' ') + ':00',
        endAt: end.replace('T', ' ') + ':00',
        content,
      });
      onDone();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="新增日常工作排班"
      onClose={onClose}
      foot={
        <>
          <button disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            className="primary-button"
            disabled={busy || !options || !person || !content.trim()}
            onClick={() => void save()}
          >
            {busy ? '保存中…' : '保存排班'}
          </button>
        </>
      }
    >
      <div className="daily-form">
        <label>
          岗位身份
          <select
            value={role}
            onChange={(e) => {
              setRole(e.target.value as 'anchor' | 'control');
              setPerson('');
            }}
          >
            <option value="anchor">主播</option>
            <option value="control">中控</option>
          </select>
        </label>
        <label>
          人员
          <select value={person} onChange={(e) => setPerson(e.target.value)}>
            <option value="">请选择</option>
            {options
              ?.filter((p) => p.roles.includes(role))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}（{money(p.hourlyRateCents)}/小时）
                </option>
              ))}
          </select>
        </label>
        <label>
          开始时间（北京时间）
          <input
            type="datetime-local"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        <label>
          结束时间（北京时间）
          <input
            type="datetime-local"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </label>
        <label>
          安排的工作内容
          <textarea
            maxLength={500}
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
        </label>
        <p className="muted">
          这里只列出已维护时薪的在职主播和中控。仅在排定时间内可以开始，按实际打卡计时。超过计划结束时间1小时仍未结束，将通知总经理。
        </p>
        {error && (
          <p role="alert" className="notice error">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

export function DailyWorkPanel({
  personal = false,
  date: fixedDate,
  token,
  company,
}: {
  personal?: boolean;
  date?: string;
  token?: string;
  company?: string;
}) {
  const { can } = useAuth();
  const [runId, setRunId] = useState<number | null>(null);
  const [date, setDate] = useState(fixedDate ?? todayText()),
    [data, setData] = useState<DailyWorkList | null>(null),
    [error, setError] = useState(''),
    [adding, setAdding] = useState(false),
    [qr, setQr] = useState(false),
    [action, setAction] = useState<{
      row: DailyWorkRow;
      kind: 'start' | 'finish' | 'report' | 'cancel';
    } | null>(null),
    [text, setText] = useState(''),
    [busy, setBusy] = useState(false),
    [actError, setActError] = useState('');
  const sequence = useRef(0);
  const load = useCallback(() => {
    const current = ++sequence.current;
    const call = personal
      ? dailyWorkApi.mine(date, token, company)
      : dailyWorkApi.list(date);
    call
      .then((x) => {
        if (current === sequence.current) {
          setData(x);
          setError('');
        }
      })
      .catch((e) => {
        if (current === sequence.current) {
          setData(null);
          setError(errText(e));
        }
      });
  }, [date, personal, token, company]);
  useEffect(() => {
    load();
    return () => {
      sequence.current++;
    };
  }, [load]);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') load();
    };
    const timer = setInterval(refresh, 30000);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [load]);
  async function submit(row: DailyWorkRow) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await dailyWorkApi.submit(row.id);
      load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!action || busy) return;
    setBusy(true);
    setActError('');
    try {
      const { kind, row } = action;
      if (kind === 'start') await dailyWorkApi.start(row.id);
      else if (kind === 'finish') await dailyWorkApi.finish(row.id, text);
      else if (kind === 'report') await dailyWorkApi.report(row.id, text);
      else await dailyWorkApi.cancel(row.id, text);
      setAction(null);
      load();
    } catch (e) {
      setActError(errText(e));
    } finally {
      setBusy(false);
    }
  }
  function open(
    row: DailyWorkRow,
    kind: 'start' | 'finish' | 'report' | 'cancel',
  ) {
    setAction({ row, kind });
    setText(kind === 'report' ? (row.report ?? '') : '');
    setActError('');
  }
  const working = data?.rows.find((r) => r.status === 'working'),
    startable = data?.rows.find((r) => r.canStart);
  return (
    <section
      className="card daily-work-panel"
      aria-label={personal ? '我的日常工作' : '直播办公室日常工作'}
    >
      <header className="daily-head">
        <div>
          <h2>{personal ? '我的日常工作' : '直播办公室'}</h2>
          <p className="muted">
            仅限已排班人员 · 按实际打卡计时 · 审核后计入工资
          </p>
        </div>
        <div className="daily-actions">
          <label>
            日期
            <input
              type="date"
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                setData(null);
              }}
            />
          </label>
          <button onClick={() => load()}>刷新</button>
          {!personal && can('live.manage') && (
            <>
              <button onClick={() => setAdding(true)}>新增日常工作排班</button>
              <button onClick={() => setQr(true)}>办公室二维码</button>
            </>
          )}
        </div>
      </header>
      {personal && data?.monthTotal && (
        <p>
          {data.monthTotal.month} 日常工资（已审核）：
          <strong>{money(data.monthTotal.amountCents)}</strong> ·{' '}
          {data.monthTotal.minutes}分钟
        </p>
      )}
      {personal && (
        <button
          className="primary-button daily-clock-button"
          disabled={!data || (!working && !startable) || busy}
          onClick={() =>
            working
              ? open(working, 'finish')
              : startable && open(startable, 'start')
          }
        >
          {working ? '结束日常工作' : '开始日常工作'}
        </button>
      )}
      {personal && !working && !startable && data && (
        <p className="muted">
          当前没有可以开始的日常工作排班。请在排定的开始至结束时间内操作。
        </p>
      )}
      {!personal && (
        <p className="muted">
          审核使用“日常工作工时审核”流程，请先在流程设计器配置审核人并发布。
        </p>
      )}
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {!data && !error && <p role="status">正在读取日常工作…</p>}
      <ul className="daily-work-list">
        {data?.rows.map((r) => (
          <li key={r.id}>
            <div className="daily-work-heading">
              <strong>
                {r.name} · {r.role === 'anchor' ? '主播' : '中控'}
              </strong>
              <span className={r.overdue ? 'pill bad' : 'pill'}>
                {r.overdue ? '超时未结束' : r.statusLabel}
              </span>
            </div>
            <p>{r.content}</p>
            <dl className="daily-times">
              <div>
                <dt>计划时间</dt>
                <dd>
                  {r.plannedStart}—{r.plannedEnd}
                </dd>
              </div>
              <div>
                <dt>实际时间</dt>
                <dd>
                  {r.startAt ?? '未开始'}
                  {r.startAt ? `—${r.endAt ?? '计时中'}` : ''}
                </dd>
              </div>
              {r.status === 'working' ? (
                <div>
                  <dt>已工作</dt>
                  <dd>{r.elapsedMinutes ?? 0}分钟</dd>
                </div>
              ) : (
                r.actualMinutes !== null && (
                  <div>
                    <dt>实际工时</dt>
                    <dd>{r.actualMinutes}分钟</dd>
                  </div>
                )
              )}
              {r.hourlyRateCents !== null && (
                <div>
                  <dt>{r.startAt ? '当次时薪' : '当前档案时薪'}</dt>
                  <dd>{money(r.hourlyRateCents)}/小时</dd>
                </div>
              )}
              {r.amountCents !== null && (
                <div>
                  <dt>{r.status === 'approved' ? '已审核工资' : '预计工资'}</dt>
                  <dd>
                    {money(r.amountCents)} · {r.minutes}分钟
                  </dd>
                </div>
              )}
            </dl>
            {r.report && <p>完成内容：{r.report}</p>}
            {r.reviewNote && <p>核定说明：{r.reviewNote}</p>}
            {r.returnReason && <p className="notice warn">{r.returnReason}</p>}
            <div className="daily-actions">
              {personal && ['pending', 'returned'].includes(r.status) && (
                <button disabled={busy} onClick={() => open(r, 'report')}>
                  修改完成内容
                </button>
              )}
              {(personal || data?.canManage) &&
                ['pending', 'returned'].includes(r.status) && (
                  <button disabled={busy} onClick={() => void submit(r)}>
                    {r.status === 'returned' ? '重新提交审核' : '提交工时审核'}
                  </button>
                )}
              {r.flowRunId && (
                <button onClick={() => setRunId(r.flowRunId)}>查看审核</button>
              )}
              {!personal && data?.canManage && r.status === 'scheduled' && (
                <button disabled={busy} onClick={() => open(r, 'cancel')}>
                  取消排班
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {data?.rows.length === 0 && (
        <p className="muted">当天没有日常工作排班。</p>
      )}
      {runId && (
        <RunDetail
          id={runId}
          onClose={() => setRunId(null)}
          onChanged={() => load()}
        />
      )}
      {adding && (
        <DailySchedule
          date={date}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            load();
          }}
        />
      )}
      {qr && (
        <Modal title="直播办公室二维码" onClose={() => setQr(false)}>
          <DailyQr />
        </Modal>
      )}
      {action && (
        <Modal
          title={
            {
              start: '开始日常工作',
              finish: '结束日常工作',
              report: '修改完成内容',
              cancel: '取消日常工作排班',
            }[action.kind]
          }
          onClose={() => {
            if (!busy) setAction(null);
          }}
          foot={
            <>
              <button disabled={busy} onClick={() => setAction(null)}>
                取消
              </button>
              <button
                className="primary-button"
                disabled={busy || (action.kind !== 'start' && !text.trim())}
                onClick={() => void confirm()}
              >
                {busy ? '处理中…' : '确认'}
              </button>
            </>
          }
        >
          <p>
            <strong>{action.row.content}</strong>
          </p>
          <p>
            排班：{action.row.plannedStart} 至 {action.row.plannedEnd}
          </p>
          {action.kind === 'start' ? (
            <p>
              确认后按当前实际时间开始计时。当前档案时薪{' '}
              {money(action.row.hourlyRateCents ?? 0)}
              /小时，以开始时保存的档案单价为准。
            </p>
          ) : (
            <>
              <p>
                {action.kind === 'cancel'
                  ? '请填写取消原因'
                  : action.kind === 'report'
                    ? '请修正完成的工作内容，原始打卡时间保留。'
                    : `实际开始：${action.row.startAt}。请核对工作内容，结束时间按本次确认时记录。`}
              </p>
              <textarea
                aria-label={
                  action.kind === 'cancel' ? '取消原因' : '完成的工作内容'
                }
                value={text}
                maxLength={action.kind === 'cancel' ? 500 : 1000}
                onChange={(e) => setText(e.target.value)}
              />
            </>
          )}
          {actError && (
            <p role="alert" className="notice error">
              {actError}
            </p>
          )}
        </Modal>
      )}
    </section>
  );
}

export function DailyOfficeCard({ date }: { date: string }) {
  const [data, setData] = useState<DailyWorkList | null>(null),
    [open, setOpen] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const load = () =>
      dailyWorkApi
        .list(date)
        .then((x) => {
          if (active) {
            setData(x);
            setError('');
          }
        })
        .catch((e) => {
          if (active) setError(errText(e));
        });
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 30000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [date]);
  const working = data?.rows.filter((r) => r.status === 'working') ?? [],
    pending =
      data?.rows.filter((r) =>
        ['pending', 'submitted', 'returned'].includes(r.status),
      ).length ?? 0;
  return (
    <article className="live-room daily-office" aria-label="直播办公室">
      <h3>
        <button className="link-button" onClick={() => setOpen(true)}>
          直播办公室
        </button>
        <span className="pill">工作中 {working.length}人</span>
      </h3>
      <p className="muted">主播 / 中控 · 排班日常工作</p>
      {working.slice(0, 4).map((r) => (
        <div className="daily-office-person" key={r.id}>
          <strong>{r.name}</strong>
          <span>{r.content}</span>
          <small>
            {r.startAt?.slice(11, 16)}开始 · 已工作{r.elapsedMinutes ?? 0}分钟
            {r.overdue ? ' · 已超时1小时' : ''}
          </small>
        </div>
      ))}
      {data && !working.length && <p className="muted">当前无人进行日常工作</p>}
      <p>
        今日排班{' '}
        {data?.rows.filter((r) => r.date === date && r.status !== 'cancelled')
          .length ?? 0}
        段 · 待处理 {pending}条
      </p>
      {error && <small role="alert">{error}</small>}
      <button className="secondary-button" onClick={() => setOpen(true)}>
        查看 / 排班日常工作
      </button>
      {open && (
        <Modal title="直播办公室" size="wide" onClose={() => setOpen(false)}>
          <DailyWorkPanel date={date} />
        </Modal>
      )}
    </article>
  );
}
