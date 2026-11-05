import { useEffect, useState } from 'react';
import { Download, Image, Images, Film, QrCode, Upload } from 'lucide-react';
import { clearLiveRoom } from '../../auth/liveRoomIntent';
import { api } from '../../api/client';
import { qrMatrix, qrSvgPath } from '../../lib/qr';
import { categories, type Asset, type Category, type ScriptVersion } from './scriptCues';

export function AssetDownload({ version, asset }: { version: number; asset: Asset }) {
  const [error, setError] = useState('');
  async function download() {
    try {
      setError('');
      const r = await api<{ url: string; filename: string }>(
        `/live/scripts/versions/${version}/assets/${asset.id}/url?download=1`,
      );
      const a = document.createElement('a');
      a.href = r.url;
      a.download = r.filename;
      a.click();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <button
        type="button"
        className="link-button sc-download"
        aria-label={'下载 ' + asset.name}
        onClick={download}
      >
        <Download size={15} />
        下载
      </button>
      {error && <small role="alert">{error}</small>}
    </>
  );
}

function AssetZone({
  category,
  version,
  assets,
  onAdded,
  mobile = false,
}: {
  category: Category;
  version: number;
  assets: Asset[];
  onAdded: (items: Asset[]) => void;
  mobile?: boolean;
}) {
  const [file, setFile] = useState<File | null>(null),
    [name, setName] = useState(''),
    [busy, setBusy] = useState(false),
    [qr, setQr] = useState(false),
    [drag, setDrag] = useState(false),
    [msg, setMsg] = useState('');
  const kind = categories[category],
    video = category === 'video',
    Icon = video ? Film : category === 'background' ? Images : Image;
  const path = '/live/scripts/versions/' + version;
  useEffect(() => {
    if (!qr) return;
    let live = true;
    const poll = async () => {
      try {
        const data = await api<ScriptVersion>(path);
        if (live) onAdded(data.assets);
      } catch (e) {
        if (live) setMsg((e as Error).message);
      }
    };
    const timer = window.setInterval(poll, 4000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [qr, path, onAdded]);
  function choose(f?: File) {
    if (!f) return;
    if (f.size > 10 * 1024 * 1024 || !f.size) {
      setMsg('请选择非空且不超过 10 MB 的文件');
      return;
    }
    setFile(f);
    setName(f.name.replace(/\.[^.]+$/, '').slice(0, 100));
    setMsg('');
  }
  async function upload() {
    if (!file || !name.trim() || busy) return;
    setBusy(true);
    setMsg('');
    try {
      const data = new FormData();
      data.append('name', name.trim());
      data.append('category', category);
      data.append('file', file);
      const a = await api<Asset>(path + '/assets', { form: data });
      onAdded([a]);
      setFile(null);
      setName('');
      setMsg('已上传「' + a.name + '」');
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const graphic = qr
    ? qrSvgPath(
        qrMatrix(location.origin + '/features/live?tab=scripts&upload=' + version + '&section=' + category),
      )
    : null;
  return (
    <section className="sc-zone" aria-label={kind + '素材区'}>
      <header>
        <Icon size={20} />
        <h4>{kind}</h4>
        <small>{assets.length} 个素材</small>
      </header>
      <fieldset disabled={busy}>
        <label
          className={'sc-drop' + (drag ? ' dragging' : '')}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            if (!busy) {
              if (e.dataTransfer.files.length === 1) choose(e.dataTransfer.files[0]);
              else setMsg('请一次选择一个素材，命名后上传');
            }
          }}
        >
          <Upload size={19} />
          <strong>{file ? file.name : '选择或拖入' + kind}</strong>
          <small>{video ? 'MP4' : 'PNG / JPG / GIF / WebP'} · 最大 10 MB</small>
          <input
            type="file"
            aria-label={'选择' + kind}
            accept={video ? 'video/mp4' : 'image/png,image/jpeg,image/gif,image/webp'}
            onChange={(e) => {
              choose(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </label>
        {file && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void upload();
            }}
          >
            <label>
              素材名称
              <input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <button className="primary-button" disabled={!name.trim() || busy}>
              {busy ? '上传中…' : '确认上传'}
            </button>
          </form>
        )}
      </fieldset>
      {!mobile && (
        <button
          type="button"
          className="link-button sc-download"
          aria-expanded={qr}
          onClick={() => setQr(!qr)}
        >
          <QrCode size={16} />
          {qr ? '收起二维码' : '手机扫码上传'}
        </button>
      )}
      {graphic && (
        <div className="sc-qr">
          <svg
            width="150"
            height="150"
            role="img"
            aria-label={kind + '上传二维码'}
            viewBox={`0 0 ${graphic.size} ${graphic.size}`}
          >
            <rect width="100%" height="100%" fill="white" />
            <path d={graphic.path} />
          </svg>
          <small>用有直播管理权限的账号扫码，直接上传到本区。</small>
        </div>
      )}
      {msg && <p role="status">{msg}</p>}
      <ul>
        {assets.map((a) => (
          <li key={a.id}>
            <span>{a.name}</span>
            <AssetDownload asset={a} version={version} />
          </li>
        ))}
      </ul>
    </section>
  );
}
export function ScriptAssetLibrary({
  version,
  assets,
  onAdded,
  only,
}: {
  version: number;
  assets: Asset[];
  onAdded: (items: Asset[]) => void;
  only?: Category;
}) {
  return (
    <div className="sc-zones">
      {(Object.keys(categories) as Category[])
        .filter((k) => !only || k === only)
        .map((k) => (
          <AssetZone
            key={k}
            category={k}
            version={version}
            assets={assets.filter((a) => a.category === k)}
            onAdded={onAdded}
            mobile={!!only}
          />
        ))}
    </div>
  );
}
export function ScriptMobileUpload({ version, category }: { version: number; category: Category }) {
  const [detail, setDetail] = useState<ScriptVersion | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setDetail(null);
    setError('');
    api<ScriptVersion>('/live/scripts/versions/' + version)
      .then((d) => {
        if (live) {
          setDetail(d);
          clearLiveRoom();
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [version]);
  return (
    <section className="sc-center card pad">
      <h2>{detail?.name} · 手机上传</h2>
      {error && <p role="alert">{error}</p>}
      {detail && (
        <ScriptAssetLibrary
          version={version}
          assets={detail.assets}
          only={category}
          onAdded={(items) => setDetail((d) => d && { ...d, assets: [...d.assets, ...items] })}
        />
      )}
    </section>
  );
}
