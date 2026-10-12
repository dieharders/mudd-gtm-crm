/**
 * assets/icon.png -> assets/icon.ico, at every size Windows asks for. Run it after changing the PNG
 * and commit the .ico; the build reads only the .ico.
 *
 *   bun run icon
 *
 * The PNG is drawn onto a transparent canvas in headless Edge or Chrome, so the rounded corners stay
 * transparent (a converter that flattens onto white loses them).
 */
import fs from "node:fs";
import path from "node:path";
import { withBrowser, type Send } from "./browser";

/** 256 is Explorer's extra-large tile; 16 is the title bar. */
const SIZES = [256, 128, 64, 48, 32, 16] as const;

const ROOT = path.join(import.meta.dir, "..");
const PNG_PATH = path.join(ROOT, "assets", "icon.png");
const ICO_PATH = path.join(ROOT, "assets", "icon.ico");


/** Rasterise the image at one size, as raw RGBA, top-down. */
async function rasterise(send: Send, imageDataUrl: string, size: number): Promise<Uint8Array> {
  const { result } = (await send("Runtime.evaluate", {
    awaitPromise: true,
    returnByValue: true,
    expression: `
      (async () => {
        const img = new Image();
        img.src = ${JSON.stringify(imageDataUrl)};
        await img.decode();
        const c = document.createElement('canvas');
        c.width = c.height = ${size};
        const ctx = c.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, ${size}, ${size});
        const d = ctx.getImageData(0, 0, ${size}, ${size}).data;
        let s = '';
        for (let i = 0; i < d.length; i++) s += String.fromCharCode(d[i]);
        return btoa(s);
      })()
    `,
  })) as { result?: { value?: unknown } };
  if (typeof result?.value !== "string") throw new Error(`rasterising at ${size}px returned no data: ${JSON.stringify(result)}`);
  return Uint8Array.from(atob(result.value), (ch) => ch.charCodeAt(0));
}

/**
 * One .ico image entry: BITMAPINFOHEADER + bottom-up BGRA + an all-zero AND mask. biHeight is
 * double the real height because it describes the colour image and the mask stacked together.
 */
function dibEntry(size: number, rgba: Uint8Array): Uint8Array {
  const header = new Uint8Array(40);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, 40, true); // biSize
  hv.setInt32(4, size, true); // biWidth
  hv.setInt32(8, size * 2, true); // biHeight
  hv.setUint16(12, 1, true); // biPlanes
  hv.setUint16(14, 32, true); // biBitCount
  hv.setUint32(20, size * size * 4, true); // biSizeImage

  const xor = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const src = y * size * 4;
    const dst = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x++) {
      const s = src + x * 4;
      const d = dst + x * 4;
      xor[d] = rgba[s + 2]!;
      xor[d + 1] = rgba[s + 1]!;
      xor[d + 2] = rgba[s]!;
      xor[d + 3] = rgba[s + 3]!;
    }
  }
  const mask = new Uint8Array(Math.ceil(size / 32) * 4 * size);

  const out = new Uint8Array(header.length + xor.length + mask.length);
  out.set(header, 0);
  out.set(xor, header.length);
  out.set(mask, header.length + xor.length);
  return out;
}

/** ICONDIR + one ICONDIRENTRY per image + the image data. */
function buildIco(images: Map<number, Uint8Array>): Uint8Array {
  const entries = [...images.entries()].sort((a, b) => b[0] - a[0]);
  const headerBytes = 6 + entries.length * 16;
  const out = new Uint8Array(headerBytes + entries.reduce((n, [, data]) => n + data.length, 0));
  const dv = new DataView(out.buffer);
  dv.setUint16(2, 1, true); // type 1 = icon
  dv.setUint16(4, entries.length, true);

  let offset = headerBytes;
  entries.forEach(([size, data], i) => {
    const at = 6 + i * 16;
    out[at] = size === 256 ? 0 : size; // 256 is stored as 0
    out[at + 1] = size === 256 ? 0 : size;
    dv.setUint16(at + 4, 1, true); // planes
    dv.setUint16(at + 6, 32, true); // bit count
    dv.setUint32(at + 8, data.length, true);
    dv.setUint32(at + 12, offset, true);
    out.set(data, offset);
    offset += data.length;
  });
  return out;
}


const imageDataUrl = `data:image/png;base64,${fs.readFileSync(PNG_PATH).toString("base64")}`;

const images = await withBrowser(async (send) => {
  const out = new Map<number, Uint8Array>();
  for (const size of SIZES) {
    const rgba = await rasterise(send, imageDataUrl, size);
    out.set(size, dibEntry(size, rgba));
    // The corner must be transparent, or the rounded tile was flattened onto something.
    console.log(`  ${String(size).padStart(3)}x${size}  corner alpha=${rgba[3]}`);
  }
  return out;
}, { name: "icon" });

fs.writeFileSync(ICO_PATH, buildIco(images));
console.log(`\n-> ${ICO_PATH} (${(fs.statSync(ICO_PATH).size / 1024).toFixed(0)} kB, ${images.size} sizes)`);
