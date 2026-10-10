// Typecheck-only stand-in for webview-bun, whose shipped .ts source fails this project's
// strict settings. Used by tsconfig.typecheck.json; the runtime uses the real package.
export class Webview {
  constructor(debug?: boolean);
  title: string;
  size: { width: number; height: number; hint: number };
  readonly unsafeWindowHandle: import("bun:ffi").Pointer | null;
  init(js: string): void;
  navigate(url: string): void;
  bind(name: string, callback: (...args: any[]) => unknown): void;
  run(): void;
}
