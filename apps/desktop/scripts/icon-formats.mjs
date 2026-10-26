// Icon container formats written by scripts/icons.mjs (no dependencies):
// Windows .ico (BMP entries below 256 px, PNG at 256) and macOS .icns
// (PNG entries). Both take images already rendered at each size, so every
// size comes straight from the SVG instead of being scaled down.

/**
 * @typedef {{ size: number, png: Buffer, rgba?: Uint8Array }} IconImage
 * `rgba`: premultiplied RGBA pixels (as @resvg/resvg-js renders them),
 * needed for the BMP entries of an .ico.
 */

/** 32-bit BMP of an .ico entry: BITMAPINFOHEADER, bottom-up BGRA, empty AND mask. */
function icoBitmap(size, rgba) {
  const maskRow = Math.ceil(size / 32) * 4;
  const buf = Buffer.alloc(40 + size * size * 4 + maskRow * size);
  buf.writeUInt32LE(40, 0);
  buf.writeInt32LE(size, 4);
  buf.writeInt32LE(size * 2, 8); // colour + mask
  buf.writeUInt16LE(1, 12);
  buf.writeUInt16LE(32, 14);
  buf.writeUInt32LE(size * size * 4 + maskRow * size, 20);
  let o = 40;
  for (let y = size - 1; y >= 0; y--) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const a = rgba[i + 3];
      // BMP wants straight alpha.
      const un = c => (a === 0 ? 0 : Math.min(255, Math.round((c * 255) / a)));
      buf[o++] = un(rgba[i + 2]);
      buf[o++] = un(rgba[i + 1]);
      buf[o++] = un(rgba[i]);
      buf[o++] = a;
    }
  }
  return buf;
}

/** Windows .ico from square images (largest 256). */
export function encodeIco(/** @type {IconImage[]} */ images) {
  const datas = images.map(im => {
    if (im.size > 256) throw new Error(`.ico entries are at most 256 px, got ${im.size}`);
    if (im.size === 256) return im.png;
    if (!im.rgba) throw new Error(`.ico entry ${im.size} px needs rgba pixels`);
    return icoBitmap(im.size, im.rgba);
  });
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((im, k) => {
    const e = 6 + 16 * k;
    header[e] = im.size % 256; // 0 means 256
    header[e + 1] = im.size % 256;
    header.writeUInt16LE(1, e + 4); // planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(datas[k].length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += datas[k].length;
  });
  return Buffer.concat([header, ...datas]);
}

/**
 * ICNS type codes by pixel size: the PNG types iconutil writes (the 16 and
 * 32 pt sizes only as @2x; icp4-icp6 PNGs do not show everywhere).
 * @type {[string, number][]}
 */
export const ICNS_TYPES = [
  ['ic11', 32], ['ic12', 64], ['ic07', 128], ['ic13', 256], ['ic08', 256],
  ['ic14', 512], ['ic09', 512], ['ic10', 1024],
];

/** An ICNS chunk: 4-character type, big-endian length (with the header), data. */
function icnsChunk(type, ...parts) {
  const head = Buffer.alloc(8);
  head.write(type, 0, 'ascii');
  head.writeUInt32BE(8 + parts.reduce((n, p) => n + p.length, 0), 4);
  return Buffer.concat([head, ...parts]);
}

/** macOS .icns from PNGs; `pngOfSize(px)` gives the PNG of each size in ICNS_TYPES. */
export function encodeIcns(/** @type {(size: number) => Buffer} */ pngOfSize) {
  return icnsChunk('icns', ...ICNS_TYPES.map(([type, size]) => icnsChunk(type, pngOfSize(size))));
}
