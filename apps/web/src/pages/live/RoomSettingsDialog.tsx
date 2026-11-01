import { useEffect, useState } from 'react';
import { liveApi, type Person, type RoomTile } from './liveApi';
import { errText } from './liveFormat';
import { Modal } from './liveUi';
export function RoomSettingsDialog({
  room,
  onClose,
  onDone,
}: {
  room: RoomTile;
  onClose: () => void;
  onDone: () => void;
}) {
  const [people, setPeople] = useState<Person[]>([]),
    [owner, setOwner] = useState(String(room.ownerId ?? '')),
    [products, setProducts] = useState(room.products ?? ''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    liveApi
      .people()
      .then(setPeople)
      .catch((e) => setError(errText(e)));
  }, []);
  async function save() {
    setBusy(true);
    try {
      await liveApi.roomSettings(room.id, { ownerId: owner ? Number(owner) : null, products });
      onDone();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`${room.name} · 房间设置`}
      onClose={onClose}
      foot={
        <button className="primary-button" disabled={busy} onClick={() => void save()}>
          保存房间信息
        </button>
      }
    >
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      <div className="live-fields">
        <label className="live-field">
          房间负责人
          <select aria-label="房间负责人" value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">未设置</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="live-field wide">
          房间产品
          <textarea
            aria-label="房间产品"
            rows={4}
            maxLength={1000}
            placeholder="填写房间常播产品、系列或规格"
            value={products}
            onChange={(e) => setProducts(e.target.value)}
          />
        </label>
      </div>
    </Modal>
  );
}
