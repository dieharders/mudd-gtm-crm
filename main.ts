/**
 * Main thread: start the server in a Worker, then open a native window pointed at it.
 * Adapted from motionbuff-native-app's main.ts.
 *
 *   bun run main.ts              the app, in its own window
 *   bun run main.ts --headless   the server only; open the printed URL in a browser
 */
import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";

/** The Win32 calls below, opened on first use (these libraries don't exist on macOS or Linux). */
let win32Libs: ReturnType<typeof openWin32> | null = null;
function openWin32() {
  return {
    kernel32: dlopen("kernel32.dll", {
      GetConsoleWindow: { args: [], returns: FFIType.ptr },
      GetConsoleProcessList: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
      FreeConsole: { args: [], returns: FFIType.i32 },
    }),
    user32: dlopen("user32.dll", {
      ShowWindow: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      SendMessageW: { args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.u64], returns: FFIType.u64 },
    }),
    shell32: dlopen("shell32.dll", {
      ExtractIconExW: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    }),
  };
}
const win32 = () => (win32Libs ??= openWin32());

/** Hide the console Windows gives a double-clicked exe (only when this process owns it alone). */
function hideOwnConsoleWindow(): void {
  if (process.platform !== "win32") return;
  try {
    const { kernel32, user32 } = win32();
    const hwnd = kernel32.symbols.GetConsoleWindow();
    if (!hwnd) return;
    const pids = new Uint32Array(2);
    if (kernel32.symbols.GetConsoleProcessList(ptr(pids), pids.length) !== 1) return;
    user32.symbols.ShowWindow(hwnd, 0);
    kernel32.symbols.FreeConsole();
  } catch {
    // Cosmetic only.
  }
}

/**
 * Give the window the exe's icon. Windows keeps the file icon (Explorer) and the window icon
 * (title bar, taskbar) separately, so embedding one at build time does nothing for the other.
 * Under `bun run` the exe is bun.exe, so this shows Bun's icon in development.
 */
function setWindowIcon(webview: { readonly unsafeWindowHandle: Pointer | null }): void {
  if (process.platform !== "win32") return;
  try {
    // Read here, inside the try: the getter is itself an FFI call.
    const hwnd = webview.unsafeWindowHandle;
    if (!hwnd) return;
    const { shell32, user32 } = win32();
    const exePath = Buffer.from(`${process.execPath}\0`, "utf16le");
    // ExtractIconExW returns the 16px entry as well, rather than a downscaled 32px one.
    const large = new BigUint64Array(1);
    const small = new BigUint64Array(1);
    const extracted = shell32.symbols.ExtractIconExW(ptr(exePath), 0, ptr(large), ptr(small), 1);
    if (extracted === 0 || extracted === 0xffff_ffff) return;
    const WM_SETICON = 0x0080;
    if (small[0]) user32.symbols.SendMessageW(hwnd, WM_SETICON, 0n, small[0]);
    if (large[0]) user32.symbols.SendMessageW(hwnd, WM_SETICON, 1n, large[0]);
  } catch {
    // Cosmetic only.
  }
}

/**
 * A Mudd.io.app opened from Finder gets launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin), which has
 * no Homebrew, npm globals or node, so every AI CLI looks uninstalled. Take PATH from the user's
 * login shell instead, as Terminal would, plus the usual install locations in case the shell's
 * profile doesn't add them. Skipped when PATH already looks like a terminal's.
 */
async function adoptLoginShellPath(): Promise<void> {
  if (process.platform !== "darwin" || process.env.PATH?.split(":").includes("/usr/local/bin")) return;
  const home = process.env.HOME ?? "";
  const usual = ["/opt/homebrew/bin", "/usr/local/bin", `${home}/.local/bin`, `${home}/.bun/bin`, `${home}/.volta/bin`, `${home}/.npm-global/bin`];
  const marker = "__MUDD_PATH__";
  let shellPath = "";
  try {
    // -i as well as -l: zsh users commonly set PATH in .zshrc, which only interactive shells read.
    const proc = Bun.spawn([process.env.SHELL || "/bin/zsh", "-ilc", `printf '\\n${marker}%s\\n' "$PATH"`], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const timeout = Bun.sleep(5_000).then(() => {
      proc.kill();
      return "";
    });
    const out = await Promise.race([new Response(proc.stdout).text(), timeout]);
    shellPath = out.split("\n").find((line) => line.startsWith(marker))?.slice(marker.length) ?? "";
  } catch {
    // The usual install locations below still apply.
  }
  const dirs = [...(shellPath || process.env.PATH || "").split(":"), ...usual];
  process.env.PATH = [...new Set(dirs)].filter(Boolean).join(":");
}

// Before the worker starts: it takes a copy of this environment and is what spawns the AI CLIs.
await adoptLoginShellPath();

// The specifier must stay a literal so the bundler includes the worker in the compiled exe.
const worker = new Worker("./src/worker.ts");

const port = await new Promise<number>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("Server failed to start within 10 seconds")), 10_000);
  worker.onmessage = (event) => {
    if (event.data?.type === "ready") {
      clearTimeout(timeout);
      resolve(event.data.port as number);
    }
  };
  worker.onerror = (event) => {
    clearTimeout(timeout);
    reject(new Error(`Worker error: ${event.message}`));
  };
});

// 127.0.0.1, not localhost: on Windows localhost often resolves to ::1 first.
const url = `http://127.0.0.1:${port}`;

function shutdownWorker(timeoutMs = 3_000): Promise<void> {
  return new Promise((resolve) => {
    const done = setTimeout(resolve, timeoutMs);
    worker.onmessage = (event) => {
      if (event.data?.type === "closed") {
        clearTimeout(done);
        resolve();
      }
    };
    worker.postMessage({ type: "shutdown" });
  });
}

const printHeadless = (reason?: string) => {
  console.log(`\n  Mudd.io is running at:\n\n  -> ${url}\n`);
  if (reason) console.log(`  (${reason})\n`);
  console.log("  Press Ctrl+C to stop.\n");
};

if (process.argv.includes("--headless")) {
  printHeadless();
} else {
  let opened = false;
  try {
    const { Webview } = await import("webview-bun");
    const webview = new Webview();
    webview.title = "Mudd.io";
    webview.size = { width: 1400, height: 900, hint: 0 };
    setWindowIcon(webview);
    webview.init(`window.__MUDD_SHELL__ = ${JSON.stringify(process.platform)};`);
    webview.navigate(url);
    console.log(`\n  Mudd.io window opened.  (server: ${url})\n`);
    hideOwnConsoleWindow();
    opened = true;
    webview.run(); // blocks until the window is closed
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (opened) console.error(`\n  The window closed unexpectedly: ${detail}\n`);
    else {
      console.error(`\n  Could not open the native window: ${detail}\n`);
      printHeadless("Native window unavailable - open the URL above in your browser");
    }
  }
  if (opened) {
    await shutdownWorker();
    worker.terminate();
    process.exit(0);
  }
}
