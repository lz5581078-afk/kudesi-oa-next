import { useState } from 'react';
import { liveApi, type Person } from './liveApi';
import { errText, yuanCents } from './liveFormat';
import { Modal } from './liveUi';
export function TrialPersonDialog({ onClose, onDone }: { onClose: () => void; onDone: (p: Person) => void }) {
  const [name, setName] = useState(''),
    [rate, setRate] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function save() {
    const cents = yuanCents(rate);
    if (!name.trim() || !cents || !Number.isSafeInteger(cents) || cents <= 0)
      return setError('请填写姓名和大于零的时薪');
    setBusy(true);
    try {
      onDone(await liveApi.trialPerson({ name: name.trim(), hourlyRateCents: cents }));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="新增试播主播"
      size="small"
      onClose={onClose}
      foot={
        <button className="primary-button" disabled={busy} onClick={() => void save()}>
          保存并选择
        </button>
      }
    >
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      <p className="muted">保留试播身份，工资和提成可累计核算。无需先录入兼职档案。</p>
      <div className="live-fields">
        <label className="live-field">
          试播姓名
          <input aria-label="试播姓名" maxLength={50} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="live-field">
          试播时薪（元）
          <input aria-label="试播时薪" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}
