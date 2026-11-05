/** Only ISO MP4 containers with a video-compatible major brand. */
export function isScriptMp4(data: Buffer) {
  if (data.length < 16 || data.toString('ascii', 4, 8) !== 'ftyp') return false;
  const size = data.readUInt32BE(0);
  return (
    size >= 16 &&
    size <= data.length &&
    /^(isom|iso[2-9]|mp4[12]|avc1|M4V )$/.test(data.toString('ascii', 8, 12))
  );
}
