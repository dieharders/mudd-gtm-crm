/**
 * The native Open dialog, the Downloads folder, and opening a link in the user's browser.
 *
 * The webview cannot show a file dialog that returns a PATH (a browser file input only hands
 * over bytes), and the path is the whole point: it is what lets "Save file" write back to the
 * workbook the user imported. Windows shows the stock WinForms dialog from a PowerShell child,
 * macOS AppleScript's `choose file`, Linux zenity or kdialog. Where none exists the client falls
 * back to a file input, and Save file then writes to Downloads.
 *
 * No text from the user or a file ever goes into these scripts: they are fixed strings.
 */
import fs from "node:fs";
import path from "node:path";

export type DialogResult = { path: string } | { cancelled: true } | { unsupported: true };

function onPath(bin: string): boolean {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, bin))) return true;
  }
  return false;
}

let linuxTool: "zenity" | "kdialog" | null | undefined;
function linuxDialog(): "zenity" | "kdialog" | null {
  if (linuxTool === undefined) linuxTool = onPath("zenity") ? "zenity" : onPath("kdialog") ? "kdialog" : null;
  return linuxTool;
}

export const dialogsSupported = () =>
  process.platform === "win32" || process.platform === "darwin" || (process.platform === "linux" && linuxDialog() !== null);

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  // windowsHide: a double-clicked Mudd.exe has let go of its console, so PowerShell (a console
  // program) would otherwise open a console window of its own behind the dialog.
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore", windowsHide: true });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out: out.trim(), err: err.trim() };
}

async function runPowerShell(script: string): Promise<string> {
  const r = await run(["powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script]);
  if (r.code !== 0) throw new Error(r.err || `PowerShell exited with ${r.code}`);
  return r.out;
}

// The dialog is parented to a hidden TOPMOST form. Without an owner it opens behind the app's
// own window, where it looks exactly like a hang.
const WINDOWS_OPEN = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(1,1)
$owner.Opacity = 0
$owner.Show()
$owner.Activate()
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = 'Import a spreadsheet into Mudd'
$d.Filter = 'Spreadsheets (*.xlsx;*.csv;*.tsv;*.txt)|*.xlsx;*.csv;*.tsv;*.txt|All files (*.*)|*.*'
$d.Multiselect = $false
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }
$owner.Close()
`;

// Asked of the frontmost app (Mudd's own window), so the dialog opens in front of it.
const MAC_OPEN = `
set kinds to {"org.openxmlformats.spreadsheetml.sheet", "public.comma-separated-values-text", "public.tab-separated-values-text", "public.plain-text"}
try
  tell application (path to frontmost application as text)
    activate
    set f to choose file with prompt "Import a spreadsheet into Mudd" of type kinds
  end tell
on error number errNum
  if errNum is -128 then error number -128
  set f to choose file with prompt "Import a spreadsheet into Mudd" of type kinds
end try
return POSIX path of f
`;

export async function openDialog(): Promise<DialogResult> {
  if (process.platform === "win32") {
    const out = await runPowerShell(WINDOWS_OPEN);
    return out ? { path: out } : { cancelled: true };
  }
  if (process.platform === "darwin") {
    const r = await run(["osascript", "-e", MAC_OPEN]);
    if (r.code === 0 && r.out) return { path: r.out };
    // -128 is "User canceled."
    if (/-128/.test(r.err) || (r.code === 1 && !r.err)) return { cancelled: true };
    throw new Error(r.err || `osascript exited with ${r.code}`);
  }
  const tool = process.platform === "linux" ? linuxDialog() : null;
  if (tool === "zenity") {
    const r = await run(["zenity", "--file-selection", "--title=Import a spreadsheet into Mudd", "--file-filter=Spreadsheets | *.xlsx *.csv *.tsv *.txt"]);
    return r.code === 0 && r.out ? { path: r.out } : { cancelled: true };
  }
  if (tool === "kdialog") {
    const r = await run(["kdialog", "--getopenfilename", ".", "*.xlsx *.csv *.tsv *.txt|Spreadsheets"]);
    return r.code === 0 && r.out ? { path: r.out } : { cancelled: true };
  }
  return { unsupported: true };
}

/** Open an http(s) or mailto link in the default browser. Nothing else is ever launched. */
export function openExternal(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!["http:", "https:", "mailto:"].includes(parsed.protocol)) return false;
  const href = parsed.toString();
  const argv =
    process.platform === "win32"
      ? ["rundll32.exe", "url.dll,FileProtocolHandler", href]
      : process.platform === "darwin"
        ? ["open", href]
        : ["xdg-open", href];
  Bun.spawn(argv, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  return true;
}

export function downloadsDir(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ".";
  return path.join(home, "Downloads");
}
