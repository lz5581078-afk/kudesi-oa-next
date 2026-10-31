import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import type { SessionClient, ShopRow } from './sessionApi';

/** One row, one save: account and password are submitted together. Polling never replaces a dirty draft. */
export function ShopCredentials({ client, shop, maintenance, canManage, onChanged, onError }: { client: SessionClient; shop: ShopRow; maintenance: boolean; canManage: boolean; onChanged: () => void; onError: (s: string) => void }) {
  const draft = useRef({ account: shop.loginAccount, password: '', dirty: false, version: 0 });
  const [fields, setFields] = useState(draft.current);
  const [phase, setPhase] = useState('');
  const [revealed, setRevealed] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const saving = useRef(false), queued = useRef(false), alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const saveRef = useRef<() => Promise<void>>(async () => undefined);
  const accountLabel = maintenance ? '主账号' : '提现运营账号', passwordLabel = maintenance ? '主账号密码' : '提现运营密码';
  useEffect(() => { alive.current = true; return () => { alive.current = false; clearTimeout(timer.current); }; }, []);
  useEffect(() => { if (!draft.current.dirty) { draft.current = { ...draft.current, account: shop.loginAccount }; setFields(draft.current); } }, [shop.loginAccount]);
  const change = (field: 'account' | 'password', value: string) => {
    draft.current = { ...draft.current, [field]: value, dirty: true, version: draft.current.version + 1 };
    setFields(draft.current); setPhase('');
  };
  const save = async () => {
    clearTimeout(timer.current);
    if (!canManage || !draft.current.dirty) return;
    if (saving.current) { queued.current = true; return; }
    saving.current = true; const snapshot = { ...draft.current }; setPhase('saving'); onError('');
    try {
      await client.updateShop(shop.id, { loginAccount: snapshot.account.trim(), ...(snapshot.password ? { loginPassword: snapshot.password } : {}) });
      if (!alive.current) return;
      if (draft.current.version === snapshot.version) {
        draft.current = { ...snapshot, account: snapshot.account.trim(), password: '', dirty: false };
        setFields(draft.current); setVisible(false); setRevealed(null); setPhase('saved');
      } else setPhase('');
      onChanged();
    } catch (e) { if (alive.current) { setPhase('error'); onError(e instanceof Error ? e.message : '保存账号密码失败'); } }
    finally { saving.current = false; if (queued.current && alive.current) { queued.current = false; void saveRef.current(); } }
  };
  saveRef.current = save;
  const blur = () => { clearTimeout(timer.current); timer.current = setTimeout(() => void saveRef.current(), 800); };
  const keyDown = (e: React.KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); void save(); } };
  const showPassword = async () => {
    if (visible) { setVisible(false); setRevealed(null); return; }
    if (fields.password) { setVisible(true); return; }
    if (!shop.hasPassword) return;
    try { const result = await client.reveal(shop.id); if (alive.current) { setRevealed(result.password); setVisible(true); } }
    catch (e) { onError(e instanceof Error ? e.message : '查看密码失败'); }
  };
  const ready = !!shop.loginAccount && shop.hasPassword;
  return <>
    <td className="session-account"><input aria-label={`${shop.storeName}${accountLabel}`} autoComplete="off" disabled={!canManage} maxLength={100} value={fields.account} placeholder={maintenance ? '手动填写主账号' : '手动填写运营账号'} onChange={e => change('account', e.target.value)} onBlur={blur} onKeyDown={keyDown} /></td>
    <td className="session-password"><div className="session-password-editor">
      <input aria-label={`${shop.storeName}${passwordLabel}`} autoComplete="new-password" disabled={!canManage} maxLength={200} type={visible ? 'text' : 'password'} value={fields.password || (visible ? revealed ?? '' : '')} placeholder={shop.hasPassword ? '已设置，留空不修改' : maintenance ? '手动填写主账号密码' : '手动填写运营密码'} onChange={e => change('password', e.target.value)} onBlur={blur} onKeyDown={keyDown} />
      <button type="button" className="session-eye" aria-label={visible ? '隐藏密码' : '显示已保存密码'} disabled={!canManage || (!shop.hasPassword && !fields.password)} onClick={() => void showPassword()}>{visible ? <EyeOff size={13} /> : <Eye size={13} />}</button>
      {canManage && <button type="button" className="session-save" disabled={phase === 'saving'} onClick={() => void save()}>{phase === 'saving' ? '保存中' : phase === 'saved' ? '已保存' : phase === 'error' ? '重试' : '保存'}</button>}
    </div></td>
    <td className="session-auto"><button type="button" className={`session-toggle ${shop.autoLogin ? 'on' : ''}`} aria-label={`${shop.storeName}自动登录`} aria-pressed={shop.autoLogin} disabled={!canManage || !ready || phase === 'saving' || fields.dirty} title={ready ? '点击切换自动登录' : `请先保存${accountLabel}和密码`} onClick={async () => {
      setPhase('saving'); try { await client.updateShop(shop.id, { autoLogin: !shop.autoLogin }); onChanged(); setPhase(''); } catch (e) { setPhase('error'); onError(e instanceof Error ? e.message : '修改失败'); }
    }}><i />{ready ? shop.autoLogin ? '已开启' : '未开启' : '待配置'}</button></td>
  </>;
}
