/** One editable field in the prospect panel. Commits on blur / Enter, or on change for pickers. */
import { useEffect, useRef, useState } from "react";
import type { CellValue, Column } from "../../../shared/types";
import { cn } from "../../lib/cn";
import { coerce, display } from "../grid/cells";

export function FieldInput({
  col, value, onCommit, className, placeholder, rows = 3, autoFocus,
}: {
  col: Column;
  value: CellValue | undefined;
  onCommit: (v: CellValue) => void;
  className?: string;
  placeholder?: string;
  rows?: number;
  autoFocus?: boolean;
}) {
  const text = display(value);
  const [draft, setDraft] = useState(text);
  const focused = useRef(false);
  const cancelled = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(text);
  }, [text]);

  const commit = (raw = draft) => {
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
    className: cn("field", className),
  };

  if (col.type === "select") {
    const opts = col.options ?? [];
    return (
      <select
        className={cn("field", className)}
        value={text}
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
    const v = isDt && /^\d{4}-\d{2}-\d{2}$/.test(draft) ? `${draft}T09:00` : isDt ? draft.slice(0, 16) : draft.slice(0, 10);
    const valid = isDt ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) || !v : /^\d{4}-\d{2}-\d{2}$/.test(v) || !v;
    if (!valid) {
      // Free text in a date column (e.g. "Q3 2026"): edit it as text rather than lose it.
      return <input {...common} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()} />;
    }
    return (
      <input
        {...common}
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
        className={cn("field resize-y leading-relaxed", className)}
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
