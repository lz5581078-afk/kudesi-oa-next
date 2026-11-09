import { useState } from 'react';
import { ImageOff } from 'lucide-react';

type Photo = {url: string; name: string};

/** Crop in original-image coordinates; the resulting rectangle keeps the source aspect ratio. */
export function aliasCrop(width: number, height: number, position: string) {
  const [x, y] = position.split(/\s+/).map(value => Math.max(0, Math.min(100, parseFloat(value) || 0)) / 100);
  const cropWidth = width / 1.7, cropHeight = height / 1.7;
  return {x: (width - cropWidth) * x, y: (height - cropHeight) * (y ?? x), width: cropWidth, height: cropHeight};
}

export function ProductImage({photo, cropPosition}: {photo: Photo | null; cropPosition?: string}) {
  const [failed, setFailed] = useState<string>();
  const [loaded, setLoaded] = useState<{url: string; width: number; height: number}>();
  if (!photo || failed === photo.url) return <span className="company-product-placeholder"><ImageOff size={30} /> 暂无图片</span>;
  if (cropPosition && loaded?.url === photo.url) {
    const crop = aliasCrop(loaded.width, loaded.height, cropPosition);
    // The inner viewport clips the source. The outer viewport fits the entire crop,
    // including in portrait/square frames, without exposing the source in letterboxing.
    return <svg className="company-product-cropped-image" role="img" aria-label={photo.name}
      viewBox={`0 0 ${crop.width} ${crop.height}`} preserveAspectRatio="xMidYMid meet" onContextMenu={event => event.preventDefault()}>
      <svg width={crop.width} height={crop.height} overflow="hidden">
        <image href={photo.url} x={-crop.x} y={-crop.y} width={loaded.width} height={loaded.height}
          onError={() => setFailed(photo.url)} />
      </svg>
    </svg>;
  }
  return <img src={photo.url} alt={photo.name} draggable={false} loading="lazy"
    style={cropPosition ? {opacity: 0} : undefined} onContextMenu={event => event.preventDefault()}
    onLoad={event => {
      const {naturalWidth: width, naturalHeight: height} = event.currentTarget;
      if (width > 0 && height > 0) setLoaded({url: photo.url, width, height});
    }} onError={() => setFailed(photo.url)} />;
}
