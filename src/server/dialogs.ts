/**
 * Native Open / Save dialogs, and opening a link in the user's browser.
 *
 * The webview cannot show a file dialog that returns a PATH (a browser file input only hands
 * over bytes), and the path is the whole point: it is what lets "Save to original file" write
 * back to the workbook the user imported. On Windows a PowerShell child shows the stock
 * WinForms dialog and prints the chosen path. Elsewhere these return `unsupported`, and the
 * client falls back to a file input and a download.
 *
 * The dialog is parented to a hidden TOPMOST form. Without an owner it opens behind the app's
 * own window, where it looks exactly like a hang.
 */
import path from "node:path";

export type DialogResult = { path: string } | { cancelled: true } | { unsupported: true };

export const dialogsSupported = () => process.platform === "win32";

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

async function runPowerShell(script: string): Promise<string> {
  const proc = Bun.spawn(
    ["powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(err.trim() || `PowerShell exited with ${code}`);
  return out.trim();
}

const PRELUDE = `
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
`;

export async function openDialog(): Promise<DialogResult> {
  if (!dialogsSupported()) return { unsupported: true };
  const out = await runPowerShell(`${PRELUDE}
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = 'Import a spreadsheet into Mudd.io'
$d.Filter = 'Spreadsheets (*.xlsx;*.xlsm;*.csv)|*.xlsx;*.xlsm;*.csv|All files (*.*)|*.*'
$d.Multiselect = $false
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }
$owner.Close()
`);
  return out ? { path: out } : { cancelled: true };
}

export async function saveDialog(defaultPath: string): Promise<DialogResult> {
  if (!dialogsSupported()) return { unsupported: true };
  const dir = path.dirname(defaultPath);
  const file = path.basename(defaultPath);
  const out = await runPowerShell(`${PRELUDE}
$d = New-Object System.Windows.Forms.SaveFileDialog
$d.Title = 'Export campaign'
$d.Filter = 'Excel workbook (*.xlsx)|*.xlsx'
$d.DefaultExt = 'xlsx'
$d.AddExtension = $true
$d.OverwritePrompt = $true
$d.FileName = ${psQuote(file)}
if (Test-Path -LiteralPath ${psQuote(dir)}) { $d.InitialDirectory = ${psQuote(dir)} }
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }
$owner.Close()
`);
  return out ? { path: out } : { cancelled: true };
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
