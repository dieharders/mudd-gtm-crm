/** One editable field in the prospect panel. Commits on blur / Enter, or on change for pickers. */
import { useEffect, useRef, useState } from "react";
import { isChecked, type CellValue, type Column } from "../../../shared/types";
import { flagValue, toLocalInput } from "../../../shared/values";
import { cn } from "../../lib/cn";
import { coerce, display } from "../grid/cells";

export function FieldInput({
  col, value, onCommit, className, placeholder, rows = 3, autoFocus, disabled,
}: {
  col: Column;
  value: CellValue | undefined;
  onCommit: (v: CellValue) => void;
  className?: string;
  placeholder?: string;
  rows?: number;
  autoFocus?: boolean;
  /** Read-only: shown, and selectable to copy, but not changed. */
  disabled?: boolean;
}) {
  const text = display(value);
  const [draft, setDraft] = useState(text);
  const focused = useRef(false);
  const cancelled = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(text);
  }, [text]);

  const commit = (raw = draft) => {
    if (disabled) return;
    // A date + time field shows a bare date as 09:00: leaving it as shown is not a change.
    if (col.type === "datetime" && /^\d{4}-\d{2}-\d{2}/.test(text) && raw === toLocalInput(text)) return;
    const v = coerce(raw, col);
    if (display(v) !== text) onCommit(v);
  };
  const common = {
    onFocus: () => (focused.current = true),
    onBlur: () => {
      focused.current = false;
      if (cancelled.current) {
        cancelled.current = false;
        setDraft(text);
        return;
      }
      commit();
    },
    autoFocus,
    placeholder,
    readOnly: disabled,
    className: cn("field", disabled && "bg-paper-deep/40 text-mud-soft", className),
  };

  if (col.type === "checkbox") {
    return (
      <input
        type="checkbox"
        className={cn("block h-4 w-4 accent-clay", disabled && "opacity-60", className)}
        checked={isChecked(value)}
        disabled={disabled}
        autoFocus={autoFocus}
        aria-label={col.header}
        onChange={(e) => onCommit(flagValue(e.target.checked))}
      />
    );
  }
  if (col.type === "select") {
    const opts = col.options ?? [];
    return (
      <select
        className={cn("field", disabled && "bg-paper-deep/40 text-mud-soft", className)}
        value={text}
        disabled={disabled}
        onChange={(e) => {
          setDraft(e.target.value);
          onCommit(e.target.value || null);
        }}
      >
        <option value="">—</option>
        {text && !opts.includes(text) && <option value={text}>{text}</option>}
        {opts.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  if (col.type === "date" || col.type === "datetime") {
    const isDt = col.type === "datetime";
    const v = isDt ? toLocalInput(draft) : draft.slice(0, 10);
    const valid = isDt ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) || !v : /^\d{4}-\d{2}-\d{2}$/.test(v) || !v;
    if (!valid) {
      // Free text in a date column (e.g. "Q3 2026"): edit it as text rather than lose it.
      return <input {...common} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()} />;
    }
    return (
      <input
        {...common}
        // A picker ignores readOnly in some browsers: a read-only date is disabled instead.
        disabled={disabled}
        type={isDt ? "datetime-local" : "date"}
        value={v}
        onChange={(e) => {
          setDraft(e.target.value);
          if (!focused.current) commit(e.target.value);
        }}
      />
    );
  }
  if (col.type === "longtext") {
    return (
      <textarea
        {...common}
        rows={rows}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className={cn("field resize-y leading-relaxed", disabled && "bg-paper-deep/40 text-mud-soft", className)}
      />
    );
  }
  return (
    <input
      {...common}
      type={col.type === "email" ? "email" : "text"}
      inputMode={col.type === "number" || col.type === "currency" ? "decimal" : undefined}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
        if (e.key === "Escape") {
          cancelled.current = true;
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
    />
  );
}
