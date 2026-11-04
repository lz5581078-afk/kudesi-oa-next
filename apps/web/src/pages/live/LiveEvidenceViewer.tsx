import { useEffect, useRef, useState } from 'react';
import { Minus, Plus, Maximize2, ExternalLink } from 'lucide-react';
import { Modal } from './liveUi';
import './liveEvidenceViewer.css';

/** Render the original image at native resolution; scrolling never changes its aspect ratio. */
export function LiveEvidenceViewer({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const [image, setImage] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<number | 'fit'>(1);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const measure = () => setFrame({ width: node.clientWidth, height: node.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { setFailed(false); }, [url]);
  const fit = image.width && frame.width && frame.height
    ? Math.min(1, frame.width / image.width, frame.height / image.height) : 1;
  const scale = zoom === 'fit' ? fit : zoom;
  const changeZoom = (delta: number) => setZoom(Math.max(.1, Math.min(4, Math.round((scale + delta) * 100) / 100)));
  return <Modal title="直播数据图片" onClose={onClose} size="wide" bodyClassName="live-evidence-viewer">
    <div className="live-evidence-tools">
      <span className="live-evidence-name" title={name}>{name}</span>
      <div className="live-evidence-controls" role="group" aria-label="图片缩放">
        <button type="button" className="secondary-button" aria-label="缩小图片" disabled={scale <= .1} onClick={() => changeZoom(-.25)}><Minus size={16} aria-hidden="true"/></button>
        <output aria-label="图片缩放比例">{Math.round(scale * 100)}%</output>
        <button type="button" className="secondary-button" aria-label="放大图片" disabled={scale >= 4} onClick={() => changeZoom(.25)}><Plus size={16} aria-hidden="true"/></button>
        <button type="button" className="secondary-button" aria-pressed={zoom === 1} onClick={() => setZoom(1)}>原始尺寸</button>
        <button type="button" className="secondary-button" aria-pressed={zoom === 'fit'} onClick={() => setZoom('fit')}><Maximize2 size={15} aria-hidden="true"/>适应窗口</button>
        <a className="secondary-button" href={url} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} aria-hidden="true"/>查看原图</a>
      </div>
    </div>
    <p className="live-evidence-help">默认按原始尺寸显示，滚动可查看图片其他区域。</p>
    {failed && <p role="alert" className="notice error">图片加载失败，请关闭后重新打开，或点击“查看原图”。</p>}
    <div className="live-evidence-viewport" ref={viewport} tabIndex={0} aria-label="原图预览，可滚动查看">
      <div className="live-evidence-canvas">
        <img src={url} alt={name} draggable={false}
          onLoad={event => { setFailed(false); setImage({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }); }}
          onError={() => setFailed(true)}
          style={{ width: image.width ? image.width * scale : 'auto', height: image.height ? image.height * scale : 'auto' }}/>
      </div>
    </div>
  </Modal>;
}
