/**
 * assets/icon.svg -> assets/icon.ico, at every size Windows asks for. Run it after changing the SVG
 * and commit the .ico; the build reads only the .ico.
 *
 *   bun run icon
 *
 * The SVG is drawn onto a transparent canvas in headless Edge or Chrome, so the rounded corners stay
 * transparent (a converter that flattens onto white loses them). Adapted from motionbuff-native-app.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 256 is Explorer's extra-large tile; 16 is the title bar. */
const SIZES = [256, 128, 64, 48, 32, 16] as const;

const ROOT = path.join(import.meta.dir, "..");
const SVG_PATH = path.join(ROOT, "assets", "icon.svg");
const ICO_PATH = path.join(ROOT, "assets", "icon.ico");

function findBrowser(): string {
  const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const pf = process.env.ProgramFiles ?? "C:\\Program Files";
  const candidates = [
    process.env.CHROME_PATH,
    path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ];
  const found =
    candidates.find((c): c is string => !!c && fs.existsSync(c)) ??
    Bun.which("google-chrome") ??
    Bun.which("chromium") ??
    Bun.which("microsoft-edge");
  if (!found) throw new Error("No Edge or Chrome found. Set CHROME_PATH to a Chromium-based browser.");
  return found;
}

/** Rasterise the SVG at one size, as raw RGBA, top-down. */
async function rasterise(send: Send, svgDataUrl: string, size: number): Promise<Uint8Array> {
  const { result } = (await send("Runtime.evaluate", {
    awaitPromise: true,
    returnByValue: true,
    expression: `
      (async () => {
        const img = new Image();
        img.src = ${JSON.stringify(svgDataUrl)};
        await img.decode();
        const c = document.createElement('canvas');
        c.width = c.height = ${size};
        const ctx = c.getContext('2d');
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

type Send = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

async function withBrowser<T>(fn: (send: Send) => Promise<T>): Promise<T> {
  const port = 9333;
  // Its own profile, so it cannot hand off to (or open a window in) a browser already running.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "mudd-icon-"));
  const proc = Bun.spawn(
    [findBrowser(), "--headless=new", "--disable-gpu", "--no-first-run", `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "about:blank"],
    { stdout: "ignore", stderr: "ignore" },
  );
  try {
    type Target = { type: string; webSocketDebuggerUrl: string };
    let list: Target[] | null = null;
    for (let i = 0; i < 60 && !list; i++) {
      try {
        list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Target[];
      } catch {
        await Bun.sleep(250);
      }
    }
    const page = list?.find((t) => t.type === "page") ?? list?.[0];
    if (!page) throw new Error("the headless browser started but exposed no page");

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const pending = new Map<number, (v: unknown) => void>();
    let id = 0;
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as { id?: number; result?: unknown };
      if (msg.id && pending.has(msg.id)) pending.get(msg.id)!(msg.result ?? {});
    };
    await new Promise<void>((r) => (ws.onopen = () => r()));
    const send: Send = (method, params = {}) =>
      new Promise((resolve) => {
        const n = ++id;
        pending.set(n, resolve);
        ws.send(JSON.stringify({ id: n, method, params }));
      });
    try {
      return await fn(send);
    } finally {
      ws.close();
    }
  } finally {
    proc.kill();
    await proc.exited;
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

const svg = fs.readFileSync(SVG_PATH, "utf8");
const svgDataUrl = `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;

const images = await withBrowser(async (send) => {
  const out = new Map<number, Uint8Array>();
  for (const size of SIZES) {
    const rgba = await rasterise(send, svgDataUrl, size);
    out.set(size, dibEntry(size, rgba));
    // The corner must be transparent, or the rounded tile was flattened onto something.
    console.log(`  ${String(size).padStart(3)}x${size}  corner alpha=${rgba[3]}`);
  }
  return out;
});

fs.writeFileSync(ICO_PATH, buildIco(images));
console.log(`\n-> ${ICO_PATH} (${(fs.statSync(ICO_PATH).size / 1024).toFixed(0)} kB, ${images.size} sizes)`);
