/**
 * Main thread: start the server in a Worker, then open a native window pointed at it.
 * Adapted from motionbuff-native-app's main.ts.
 *
 *   bun run main.ts              the app, in its own window
 *   bun run main.ts --headless   the server only; open the printed URL in a browser
 */
import { dlopen, FFIType, ptr } from "bun:ffi";

/** Hide the console Windows gives a double-clicked exe (only when this process owns it alone). */
function hideOwnConsoleWindow(): void {
  if (process.platform !== "win32") return;
  try {
    const kernel32 = dlopen("kernel32.dll", {
      GetConsoleWindow: { args: [], returns: FFIType.ptr },
      GetConsoleProcessList: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
      FreeConsole: { args: [], returns: FFIType.i32 },
    });
    const user32 = dlopen("user32.dll", { ShowWindow: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 } });
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
