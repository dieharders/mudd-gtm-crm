/**
 * Re-encode assets/icon.ico as the .icns a macOS .app needs, at build time, so the .ico stays the
 * one icon file in the repo. Written against the formats directly: `iconutil` exists only on macOS
 * and an image library would be a native dependency. Adapted from motionbuff-native-app.
 */
import { deflateSync } from "node:zlib";

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** length + type + data + CRC over (type + data), big-endian. */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, Bun.hash.crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Minimal 8-bit RGBA PNG: one IDAT, no row filtering. */
function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha

  return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", ihdr), pngChunk("IDAT", new Uint8Array(deflateSync(raw))), pngChunk("IEND", new Uint8Array(0))]);
}

/** A 32bpp .ico entry (bottom-up BGRA) as a PNG. scripts/make-icon.ts writes only this kind. */
function dibToPng(size: number, dib: Uint8Array): Uint8Array {
  const view = new DataView(dib.buffer, dib.byteOffset, dib.byteLength);
  const headerSize = view.getUint32(0, true);
  if (view.getUint16(14, true) !== 32 || view.getUint32(16, true) !== 0) {
    throw new Error(`${size}x${size} entry is not uncompressed 32bpp; regenerate it with \`bun run icon\``);
  }
  const stride = size * 4;
  const rgba = new Uint8Array(stride * size);
  for (let y = 0; y < size; y++) {
    let src = headerSize + (size - 1 - y) * stride;
    let dst = y * stride;
    for (let x = 0; x < size; x++, src += 4, dst += 4) {
      rgba[dst] = dib[src + 2]!;
      rgba[dst + 1] = dib[src + 1]!;
      rgba[dst + 2] = dib[src]!;
      rgba[dst + 3] = dib[src + 3]!;
    }
  }
  return encodePng(size, size, rgba);
}

/** Every square image in a .ico, as PNG bytes keyed by edge length. */
export async function readIcoAsPngs(icoPath: string): Promise<Map<number, Uint8Array>> {
  const ico = new Uint8Array(await Bun.file(icoPath).arrayBuffer());
  const dir = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
  if (ico.length < 6 || dir.getUint16(0, true) !== 0 || dir.getUint16(2, true) !== 1) {
    throw new Error(`${icoPath} is not a Windows icon file`);
  }
  const images = new Map<number, Uint8Array>();
  for (let i = 0; i < dir.getUint16(4, true); i++) {
    const entry = 6 + i * 16;
    const width = ico[entry] || 256;
    const height = ico[entry + 1] || 256;
    if (width !== height) continue;
    const offset = dir.getUint32(entry + 12, true);
    const data = ico.subarray(offset, offset + dir.getUint32(entry + 8, true));
    const alreadyPng = PNG_SIGNATURE.every((byte, at) => data[at] === byte);
    images.set(width, alreadyPng ? data : dibToPng(width, data));
  }
  if (images.size === 0) throw new Error(`${icoPath} contains no square images`);
  return images;
}

/** The OSType codes iconutil uses; each @2x slot reuses the next size up. */
const ICNS_TYPES: Array<[size: number, type: string]> = [
  [16, "icp4"], // 16x16
  [32, "ic11"], // 16x16@2x
  [32, "icp5"], // 32x32
  [64, "ic12"], // 32x32@2x
  [128, "ic07"], // 128x128
  [256, "ic13"], // 128x128@2x
  [256, "ic08"], // 256x256
];

/** 'icns' + total length, then per image an OSType and a length that includes its 8-byte header. */
export function buildIcns(images: Map<number, Uint8Array>): Uint8Array {
  const entries: Uint8Array[] = [];
  for (const [size, type] of ICNS_TYPES) {
    const png = images.get(size);
    if (!png) continue;
    const entry = new Uint8Array(8 + png.length);
    for (let i = 0; i < 4; i++) entry[i] = type.charCodeAt(i);
    new DataView(entry.buffer).setUint32(4, entry.length);
    entry.set(png, 8);
    entries.push(entry);
  }
  if (entries.length === 0) throw new Error(`no icon size matched an ICNS slot (have ${[...images.keys()].join(", ")})`);
  const body = Buffer.concat(entries);
  const out = new Uint8Array(8 + body.length);
  out.set([0x69, 0x63, 0x6e, 0x73]); // 'icns'
  new DataView(out.buffer).setUint32(4, out.length);
  out.set(body, 8);
  return out;
}
