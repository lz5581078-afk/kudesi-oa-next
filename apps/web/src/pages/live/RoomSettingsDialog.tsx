import { useEffect, useState } from 'react';
import { liveApi, type Person, type RoomTile } from './liveApi';
import { errText } from './liveFormat';
import { roomProductItems } from './roomProducts';
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
    [products, setProducts] = useState(() => { const items = roomProductItems(room.products); return items.length ? items : ['']; }),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    liveApi
      .people()
      .then(setPeople)
      .catch((e) => setError(errText(e)));
  }, []);
  async function save() {
    const value = products.map((s) => s.trim()).filter(Boolean).join('\n');
    setError('');
    if (value.length > 1000) return setError('房间产品合计不能超过 1000 个字符，请精简后保存');
    setBusy(true);
    try {
      await liveApi.roomSettings(room.id, { ownerId: owner ? Number(owner) : null, products: value });
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
          房间管理员
          <select aria-label="房间管理员" value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">未设置</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className="live-field wide live-room-products-editor" role="group" aria-label="房间产品">
          <span>房间产品</span>
          {products.map((product, i) => <div className="live-room-product-row" key={i}>
            <input
              aria-label={`房间产品 ${i + 1}`}
              maxLength={1000}
              placeholder="填写一个产品、系列或规格"
              value={product}
              onChange={(e) => setProducts((items) => items.map((item, index) => index === i ? e.target.value : item))}
            />
            <button type="button" className="link-button" aria-label={`删除房间产品 ${i + 1}`} disabled={busy} onClick={() => setProducts((items) => items.length === 1 ? [''] : items.filter((_, index) => index !== i))}>删除</button>
          </div>)}
          <button type="button" className="secondary-button small live-add-room-product" disabled={busy} onClick={() => setProducts((items) => [...items, ''])}>＋ 添加产品</button>
        </div>
      </div>
    </Modal>
  );
}
