export function mapVideoPointerToCapture({
  clientX,
  clientY,
  elementRect,
  videoWidth,
  videoHeight
}) {
  const width = Number(elementRect?.width);
  const height = Number(elementRect?.height);
  const sourceWidth = Number(videoWidth);
  const sourceHeight = Number(videoHeight);
  if (![clientX, clientY, width, height, sourceWidth, sourceHeight].every(Number.isFinite) ||
      width <= 0 || height <= 0 || sourceWidth <= 0 || sourceHeight <= 0) return null;

  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const renderedWidth = sourceWidth * scale;
  const renderedHeight = sourceHeight * scale;
  const renderedLeft = Number(elementRect.left) + (width - renderedWidth) / 2;
  const renderedTop = Number(elementRect.top) + (height - renderedHeight) / 2;
  if (clientX < renderedLeft || clientY < renderedTop ||
      clientX >= renderedLeft + renderedWidth || clientY >= renderedTop + renderedHeight) return null;

  return {
    x: Math.round((clientX - renderedLeft) / scale),
    y: Math.round((clientY - renderedTop) / scale)
  };
}
