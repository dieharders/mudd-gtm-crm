// Typecheck-only stand-in for webview-bun, whose shipped .ts source fails this project's
// strict settings. Used by tsconfig.typecheck.json; the runtime uses the real package.
export class Webview {
  constructor(debug?: boolean);
  title: string;
  size: { width: number; height: number; hint: number };
  init(js: string): void;
  navigate(url: string): void;
  run(): void;
}
