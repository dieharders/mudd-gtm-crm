/** Date helpers. Values are wall-clock strings ("2026-10-02", "2026-10-02T14:30"), never UTC. */

const pad = (n: number) => String(n).padStart(2, "0");

export function todayString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parse a stored date or datetime as LOCAL time. */
export function parseLocal(v: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(v);
  if (!m) return null;
  return new Date(+m[1]!, +m[2]! - 1, +m[3]!, m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function formatDate(v: string): string {
  const d = parseLocal(v);
  if (!d) return v;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${sameYear ? "" : ` ${d.getFullYear()}`}`;
}

export function formatTime(d: Date): string {
  const h = d.getHours();
  const m = d.getMinutes();
  const h12 = h % 12 || 12;
  return `${h12}:${pad(m)} ${h < 12 ? "am" : "pm"}`;
}

export function formatDateTime(v: string): string {
  const d = parseLocal(v);
  if (!d) return v;
  if (!/[T ]\d{2}:\d{2}/.test(v)) return formatDate(v);
  return `${DAYS[d.getDay()]} ${formatDate(v)}, ${formatTime(d)}`;
}

export function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "in 2 days", "in 3 hours", "45 minutes ago" */
export function relative(v: string, now = new Date()): string {
  const d = parseLocal(v);
  if (!d) return "";
  const diff = d.getTime() - now.getTime();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60_000);
  const hours = Math.round(abs / 3_600_000);
  const days = Math.round(abs / 86_400_000);
  let s: string;
  if (mins < 1) return "now";
  if (mins < 60) s = `${mins} minute${mins === 1 ? "" : "s"}`;
  else if (hours < 24) s = `${hours} hour${hours === 1 ? "" : "s"}`;
  else if (days < 14) s = `${days} day${days === 1 ? "" : "s"}`;
  else s = `${Math.round(days / 7)} weeks`;
  return diff > 0 ? `in ${s}` : `${s} ago`;
}

export function timeAgo(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
