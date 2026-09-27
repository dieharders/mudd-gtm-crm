/** The Mudd mark: a clay tile with a spreadsheet fold. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="1.5" y="1.5" width="21" height="21" rx="6" fill="#9c4d2f" />
      <path d="M6 16.5V8.2c0-.5.6-.8 1-.4l3.6 3.9c.3.3.8.3 1.1 0l3.6-3.9c.4-.4 1-.1 1 .4v8.3" fill="none" stroke="#fbf5f1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="18" cy="17" r="1.4" fill="#eaccb7" />
    </svg>
  );
}
