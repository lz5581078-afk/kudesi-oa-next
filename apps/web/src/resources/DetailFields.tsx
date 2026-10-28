import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { dueBadgeFor, type ResourceDef } from '@kudesi/shared';
import { ApiError } from '../api/client';
import { resourceApi, type ResourceDto } from './api';
import { recordLink } from './recordLink';
import { useResourceCan } from './useResourceCan';
import { CopyButton, copyText, isCopyable, urlOf } from './CopyValue';
import { FileList } from './FilesField';
import { displayValue } from './format';

export type FieldItem = ResourceDef['fields'][number];

export function SecretCell({ def, record, fieldKey }: { def: ResourceDef; record: ResourceDto; fieldKey: string }) {
  const can = useResourceCan(def.key);
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [left, setLeft] = useState(0);
  const shown = record.secretConfigured[fieldKey] ? '••••••' : '';
  useEffect(() => {
    if (value === null) return;
    setLeft(30); // 明文只显示 30 秒（旧系统同款），倒计时给人看
    const t = setInterval(() => setLeft((n) => {
      if (n <= 1) { setValue(null); setCopied(false); return 0; }
      return n - 1;
    }), 1000);
    return () => clearInterval(t);
  }, [value]);
  // 换了一条记录，上一条的明文立刻收起
  useEffect(() => { setValue(null); setCopied(false); setError(''); }, [record.id]);
  if (!record.secretConfigured[fieldKey]) return <span className="muted">未设置</span>;
  return (
    <span className="secret-cell">
      <span className="mono">{value ?? shown}</span>{' '}
      {value !== null && <small className="muted">{left} 秒后隐藏 </small>}
      {can('secret') &&
        (value === null ? (
          <button
            type="button"
            className="link-button"
            onClick={async () => {
              try {
                setValue((await resourceApi.reveal(def.key, record.id, fieldKey)).value);
              } catch (e) {
                setError(e instanceof ApiError ? (e.message || '没有查看这项敏感信息的权限，请联系管理员开通。') : '读取失败，请稍后重试。');
              }
            }}
          >
            查看（会留记录）
          </button>
        ) : (
          <>
            <button type="button" className="link-button" onClick={() => { void copyText(value).then((ok) => (ok ? setCopied(true) : setError('浏览器不允许复制，请手动选中后复制。'))); }}>{copied ? '已复制' : '复制'}</button>{' '}
            <button type="button" className="link-button" onClick={() => { setValue(null); setCopied(false); }}>隐藏</button>
          </>
        ))}
      {error && <small className="bad-text"> {error}</small>}
    </span>
  );
}

/** 供应商等有开户名/开户行/账号的资料：一键复制整组银行信息，付款对账时直接粘贴。 */
export function BankCopyAll({ def, record }: { def: ResourceDef; record: ResourceDto }) {
  const d = record.data;
  if (!def.fields.some((f) => f.key === 'bankAccountNo') || !d.bankAccountNo) return null;
  const text = [`户名：${String(d.bankAccountName ?? record.title)}`, `开户行：${String(d.bank ?? '')}`, `账号：${String(d.bankAccountNo)}`].join('\n');
  return <div className="pill-row"><span className="muted">银行信息</span><CopyButton value={text} label="全部银行信息" /></div>;
}

/** 详情里一个字段的值：编号/账号/手机号类带“复制”，引用的资料可点进去，到期日期带提醒角标。 */
/** 详情里几乎每个值都能一键复制：编号、账号一类常驻显示，其他的鼠标移上去才出现。开关量、属性清单没有复制的意义。 */
function copyWorthy(f: FieldItem): boolean {
  return !['bool', 'attrs', 'files', 'secret', 'json'].includes(f.type);
}

export function InfoValue({ def, f, record, canView, today }: { def: ResourceDef; f: ResourceDef['fields'][number]; record: ResourceDto; canView: (t: string) => boolean; today: string }) {
  const text = displayValue(f, record);
  if (!text) return <span className="muted">—</span>;
  const url = urlOf(f, text);
  if ((f.type === 'ref' || f.type === 'refs') && f.ref && f.ref !== 'user' && canView(f.ref)) {
    const raw = record.data[f.key];
    const ids = (Array.isArray(raw) ? raw : [raw]).filter((x): x is number => typeof x === 'number');
    const labels = text.split('、');
    if (ids.length === labels.length) {
      return <>{ids.map((id, i) => {
        const to = recordLink(f.ref!, id);
        return <span key={id}>{i > 0 && '、'}{to ? <Link to={to}>{labels[i]}</Link> : labels[i]}</span>;
      })}</>;
    }
  }
  const due = dueBadgeFor(def.key, f.key, record.data, record.status, today);
  return (
    <>
      {url ? <a href={url} target="_blank" rel="noopener noreferrer">{text}</a> : f.type === 'textarea' ? <span className="pre-wrap">{text}</span> : text}
      {copyWorthy(f) && <CopyButton value={text} label={f.label} className={isCopyable(def, f) ? undefined : 'soft'} />}
      {due && <> <span className={`pill ${due.level === 'expired' ? 'bad' : 'warn'}`}>{due.text}</span></>}
    </>
  );
}

