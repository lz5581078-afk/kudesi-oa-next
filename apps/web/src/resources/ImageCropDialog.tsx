import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError } from '../api/client';
import './imageCrop.css';

type Picture = {
  image: HTMLImageElement;
  url: string;
  width: number;
  height: number;
};
export function cropGeometry(
  width: number,
  height: number,
  view: number,
  zoom: number,
  rotation: number,
  x: number,
  y: number,
) {
  const rotated = rotation % 180 !== 0;
  const w = rotated ? height : width,
    h = rotated ? width : height;
  const scale = Math.max(view / w, view / h) * zoom;
  const boundX = Math.max(0, (w * scale - view) / 2),
    boundY = Math.max(0, (h * scale - view) / 2);
  return {
    scale,
    x: Math.max(-boundX, Math.min(boundX, x)) || 0,
    y: Math.max(-boundY, Math.min(boundY, y)) || 0,
  };
}
/** 所有图片从本机文件加载；只有确认后的裁剪结果会上传。 */
export function ImageCropDialog({
  file,
  label = '人员照片',
  onConfirm,
  onClose,
}: {
  file: File;
  label?: string;
  onConfirm: (cropped: File) => Promise<void>;
  onClose: () => void;
}) {
  const [picture, setPicture] = useState<Picture | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState(1),
    [rotation, setRotation] = useState(0),
    [pan, setPan] = useState({ x: 0, y: 0 }),
    [view, setView] = useState(280);
  const viewport = useRef<HTMLDivElement>(null),
    dialog = useRef<HTMLElement>(null),
    drag = useRef<{
      id: number;
      x: number;
      y: number;
      panX: number;
      panY: number;
    } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    let alive = true;
    const url = URL.createObjectURL(file),
      image = new Image();
    setPicture(null);
    setError('');
    setZoom(1);
    setRotation(0);
    setPan({ x: 0, y: 0 });
    image.onload = () => {
      if (alive) {
        if (!image.naturalWidth || !image.naturalHeight)
          setError('图片无法读取，请重新选择');
        else
          setPicture({
            image,
            url,
            width: image.naturalWidth,
            height: image.naturalHeight,
          });
      }
    };
    image.onerror = () => {
      if (alive) setError('这张图片无法裁剪，请选择 JPG、PNG 或 WebP 照片');
    };
    image.src = url;
    return () => {
      alive = false;
      mounted.current = false;
      image.onload = null;
      image.onerror = null;
      URL.revokeObjectURL(url);
    };
  }, [file]);
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const resize = () => setView(el.getBoundingClientRect().width || 280);
    resize();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', resize);
      return () => window.removeEventListener('resize', resize);
    }
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => {
      if (before?.isConnected) before.focus();
    };
  }, []);
  const geometry = picture
    ? cropGeometry(
        picture.width,
        picture.height,
        view,
        zoom,
        rotation,
        pan.x,
        pan.y,
      )
    : null;
  function move(x: number, y: number) {
    if (!picture) return;
    const g = cropGeometry(
      picture.width,
      picture.height,
      view,
      zoom,
      rotation,
      x,
      y,
    );
    setPan({ x: g.x, y: g.y });
  }
  async function confirm() {
    if (!picture || !geometry || busy) return;
    setBusy(true);
    setError('');
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = 512;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('当前浏览器无法裁剪图片，请换浏览器重试');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, 512, 512);
      const output = 512 / view;
      ctx.translate(256 + geometry.x * output, 256 + geometry.y * output);
      ctx.rotate((rotation * Math.PI) / 180);
      const scale = geometry.scale * output;
      ctx.drawImage(
        picture.image,
        (-picture.width * scale) / 2,
        (-picture.height * scale) / 2,
        picture.width * scale,
        picture.height * scale,
      );
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('裁剪失败，请重试'))),
          'image/jpeg',
          0.92,
        ),
      );
      const name =
        (file.name.replace(/\.[^.]+$/, '') || '人员照片') + '-裁剪.jpg';
      await onConfirm(new File([blob], name, { type: 'image/jpeg' }));
    } catch (e) {
      if (mounted.current)
        setError(
          e instanceof ApiError || e instanceof Error
            ? e.message
            : '照片上传失败，请重试',
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return createPortal(
    <div className="modal-backdrop image-crop-backdrop">
      <section
        ref={dialog}
        className="modal card small image-crop-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`裁剪${label}`}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) {
            e.stopPropagation();
            onClose();
          }
          if (e.key === 'Tab') {
            const items = [
              ...dialog.current!.querySelectorAll<HTMLElement>(
                'button:not(:disabled),input:not(:disabled),[tabindex="0"]',
              ),
            ];
            const first = items[0],
              last = items[items.length - 1];
            if (
              e.shiftKey &&
              (document.activeElement === first ||
                document.activeElement === dialog.current)
            ) {
              e.preventDefault();
              last?.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header className="modal-head">
          <strong>裁剪{label}</strong>
          <button
            type="button"
            className="icon-button"
            disabled={busy}
            aria-label="关闭裁剪"
            onClick={onClose}
          >
            ✕
          </button>
        </header>
        <div className="modal-body image-crop-body">
          <p>拖动照片调整位置，滑动缩放；确认后上传裁剪结果。</p>
          <div
            ref={viewport}
            className="image-crop-viewport"
            tabIndex={0}
            role="group"
            aria-label="照片裁剪区域，可拖动或用方向键移动"
            onKeyDown={(e) => {
              const delta: Record<string, [number, number]> = {
                ArrowLeft: [-10, 0],
                ArrowRight: [10, 0],
                ArrowUp: [0, -10],
                ArrowDown: [0, 10],
              };
              if (delta[e.key] && !busy && geometry) {
                e.preventDefault();
                move(
                  geometry.x + delta[e.key][0],
                  geometry.y + delta[e.key][1],
                );
              }
            }}
            onPointerDown={(e) => {
              if (busy || !picture || drag.current) return;
              drag.current = {
                id: e.pointerId,
                x: e.clientX,
                y: e.clientY,
                panX: geometry?.x ?? 0,
                panY: geometry?.y ?? 0,
              };
              e.currentTarget.setPointerCapture?.(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (
                busy ||
                !geometry ||
                !drag.current ||
                drag.current.id !== e.pointerId
              )
                return;
              const { x, y, panX, panY } = drag.current;
              move(panX + e.clientX - x, panY + e.clientY - y);
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
          >
            {picture && geometry ? (
              <img
                src={picture.url}
                alt="待裁剪照片"
                draggable={false}
                style={{
                  width: picture.width * geometry.scale,
                  height: picture.height * geometry.scale,
                  transform: `translate(-50%,-50%) translate(${geometry.x}px,${geometry.y}px) rotate(${rotation}deg)`,
                }}
              />
            ) : (
              <span role="status">
                {error ? '无法读取图片' : '正在读取照片…'}
              </span>
            )}
            <span className="image-crop-grid" aria-hidden="true" />
          </div>
          <label className="image-crop-zoom">
            缩放
            <input
              type="range"
              min="1"
              max="3"
              step="0.01"
              value={zoom}
              disabled={busy || !picture}
              onChange={(e) => {
                const z = Number(e.target.value);
                setZoom(z);
                if (picture) {
                  const g = cropGeometry(
                    picture.width,
                    picture.height,
                    view,
                    z,
                    rotation,
                    pan.x,
                    pan.y,
                  );
                  setPan({ x: g.x, y: g.y });
                }
              }}
            />
          </label>
          <div className="image-crop-tools">
            <button
              type="button"
              disabled={busy || !picture}
              onClick={() => {
                setRotation((v) => (v + 90) % 360);
                setZoom(1);
                setPan({ x: 0, y: 0 });
              }}
            >
              旋转90°
            </button>
            <button
              type="button"
              disabled={busy || !picture}
              onClick={() => {
                setRotation(0);
                setZoom(1);
                setPan({ x: 0, y: 0 });
              }}
            >
              重置
            </button>
          </div>
          {error && (
            <p role="alert" className="notice error">
              {error}
            </p>
          )}
        </div>
        <footer className="modal-foot">
          <button type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busy || !picture}
            onClick={() => void confirm()}
          >
            {busy ? '上传中…' : '确认裁剪并上传'}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
