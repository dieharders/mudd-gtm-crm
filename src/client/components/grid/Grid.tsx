/**
 * The spreadsheet view: virtualized rows, the first columns pinned (through the company's),
 * resizable columns, keyboard navigation and in-place editing.
 *
 * Keyboard, while the grid has focus:
 *   arrows / Tab      move          Enter or F2   edit          typing   edit, replacing
 *   Delete/Backspace  clear         Ctrl+C / V    copy / paste  Space    open the row
 * A checkbox cell has no editor: Enter, F2, a double-click or a click on the box ticks it.
 *
 * Locked rows (screened-out prospects) are greyed out and read-only, except their Screened out
 * box, so unticking it restores the prospect right here.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, Maximize2 } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { CHECKED, isChecked, type CampaignSchema, type CellEdit, type CellValue, type Column, type Row } from "../../../shared/types";
import { cn } from "../../lib/cn";
import { CellEditor, CellView, coercePasted, display, type Move } from "./cells";
import { clipboardCell, parseClipboard } from "./clipboard";

export interface SortState {
  key: string;
  dir: "asc" | "desc";
}

export interface GridHandle {
  focusCell: (rowId: string, key?: string) => void;
}

interface Props {
  columns: Column[];
  rows: Row[];
  schema: CampaignSchema;
  stages: string[];
  pinned: number;
  selected: Set<string>;
  onSelect: (next: Set<string>) => void;
  onEdit: (edits: CellEdit[], label?: string) => void;
  onOpenRow: (rowId: string) => void;
  onResize: (key: string, width: number) => void;
  sort: SortState | null;
  onSort: (s: SortState | null) => void;
  openRowId: string | null;
  readOnly?: boolean;
  /** Rows shown greyed out and read-only (all but the schema's Screened out box). */
  isLocked?: (row: Row) => boolean;
  /** Columns no row can change here: the prospect's ID, a contact's (derived) company. */
  readOnlyKeys?: Set<string>;
  /** What the row's open button says ("Open prospect"). */
  openLabel?: string;
  /** Cells with an AI suggestion waiting: row id → column keys. */
  pending?: Map<string, Set<string>>;
}

const ROW_H = 36;
const GUTTER = 64;

export const Grid = forwardRef<GridHandle, Props>(function Grid(p, ref) {
  const scroller = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<{ r: number; c: number } | null>(null);
  const [editing, setEditing] = useState<{ r: number; c: number; initial?: string } | null>(null);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const widthOf = useCallback((c: Column) => widths[c.key] ?? c.width ?? 160, [widths]);

  const lefts = useMemo(() => {
    const out: number[] = [];
    let x = GUTTER;
    p.columns.forEach((c, i) => {
      out.push(x);
      if (i < p.pinned) x += widthOf(c);
    });
    return out;
  }, [p.columns, p.pinned, widthOf]);
  const totalWidth = GUTTER + p.columns.reduce((s, c) => s + widthOf(c), 0);

  const virt = useVirtualizer({
    count: p.rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });

  // Keep the active cell inside the data when rows are filtered away.
  useEffect(() => {
    if (!active) return;
    if (active.r >= p.rows.length || active.c >= p.columns.length) {
      setActive(p.rows.length && p.columns.length ? { r: Math.min(active.r, p.rows.length - 1), c: Math.min(active.c, p.columns.length - 1) } : null);
      setEditing(null);
    }
  }, [p.rows.length, p.columns.length, active]);

  const reveal = useCallback((r: number, c: number) => {
    virt.scrollToIndex(r, { align: "auto" });
    const el = scroller.current;
    if (!el) return;
    if (c < p.pinned) return;
    const pinnedW = lefts[p.pinned] ?? GUTTER;
    let x = GUTTER;
    for (let i = 0; i < c; i++) x += widthOf(p.columns[i]!);
    const w = widthOf(p.columns[c]!);
    if (x - el.scrollLeft < pinnedW) el.scrollLeft = x - pinnedW;
    else if (x + w - el.scrollLeft > el.clientWidth) el.scrollLeft = x + w - el.clientWidth;
  }, [virt, p.pinned, p.columns, lefts, widthOf]);

  const move = useCallback((dir: Move | "none", from?: { r: number; c: number }) => {
    const cur = from ?? active;
    if (!cur) return;
    let { r, c } = cur;
    if (dir === "down") r = Math.min(p.rows.length - 1, r + 1);
    if (dir === "up") r = Math.max(0, r - 1);
    if (dir === "right") c = Math.min(p.columns.length - 1, c + 1);
    if (dir === "left") c = Math.max(0, c - 1);
    setActive({ r, c });
    reveal(r, c);
  }, [active, p.rows.length, p.columns.length, reveal]);

  useImperativeHandle(ref, () => ({
    focusCell: (rowId, key) => {
      const r = p.rows.findIndex((x) => x.id === rowId);
      if (r < 0) return;
      const c = Math.max(0, key ? p.columns.findIndex((x) => x.key === key) : 0);
      setActive({ r, c });
      reveal(r, c);
      scroller.current?.focus({ preventScroll: true });
    },
  }), [p.rows, p.columns, reveal]);

  /** A cell that can't be changed: the grid is read-only, or its row is locked (bar the Screened out box). */
  const isFixed = (row: Row, col: Column) =>
    !!p.readOnly || !!p.readOnlyKeys?.has(col.key) || (!!p.isLocked?.(row) && col.key !== p.schema.screenedKey);

  const commit = (r: number, c: number, value: CellValue, dir?: Move) => {
    const row = p.rows[r];
    const col = p.columns[c];
    setEditing(null);
    if (row && col && !isFixed(row, col)) p.onEdit([{ rowId: row.id, key: col.key, value }], `Edit ${col.header}`);
    scroller.current?.focus({ preventScroll: true });
    if (dir) move(dir, { r, c });
  };

  /** Edit a cell in place: a checkbox is ticked or unticked, anything else opens its editor. */
  const startEdit = (r: number, c: number, initial?: string) => {
    const row = p.rows[r];
    const col = p.columns[c];
    if (!row || !col || isFixed(row, col)) return;
    if (col.type === "checkbox") p.onEdit([{ rowId: row.id, key: col.key, value: isChecked(row.cells[col.key]) ? null : CHECKED }], `Edit ${col.header}`);
    else setEditing({ r, c, initial });
  };

  /** Make a row the one the keys act on (Space opens it), from its checkbox or open button. */
  const pickRow = (r: number) => setActive({ r, c: active?.c ?? 0 });

  /**
   * A click anywhere in the grid leaves the keys with the grid: no control in it (a sort header,
   * select-all, a row's box or open button, a cell's link) keeps focus from a click, which in
   * Chromium would take the arrows, Enter and Space for itself. The cell being edited keeps its
   * clicks, and so does the scrollbar.
   */
  const onMouseDownCapture = (e: React.MouseEvent) => {
    if (editing || e.target === e.currentTarget) return;
    e.preventDefault();
    scroller.current?.focus({ preventScroll: true });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // A control reached with Tab keeps its own keys (Space ticks a box); a click never leaves
    // one focused (onMouseDownCapture).
    if (e.target !== e.currentTarget) return;
    if (editing || !active) return;
    const row = p.rows[active.r];
    const col = p.columns[active.c];
    if (!row || !col) return;
    const mod = e.ctrlKey || e.metaKey;
    switch (e.key) {
      case "ArrowDown": case "ArrowUp": case "ArrowLeft": case "ArrowRight":
        e.preventDefault();
        move(e.key.slice(5).toLowerCase() as Move);
        return;
      case "Tab":
        e.preventDefault();
        move(e.shiftKey ? "left" : "right");
        return;
      case "Enter": case "F2":
        e.preventDefault();
        startEdit(active.r, active.c);
        return;
      case " ":
        e.preventDefault();
        p.onOpenRow(row.id);
        return;
      case "Delete": case "Backspace":
        e.preventDefault();
        if (!isFixed(row, col) && row.cells[col.key] !== undefined) p.onEdit([{ rowId: row.id, key: col.key, value: null }], `Clear ${col.header}`);
        return;
      case "Home":
        e.preventDefault();
        setActive({ r: mod ? 0 : active.r, c: 0 });
        reveal(mod ? 0 : active.r, 0);
        return;
      case "End":
        e.preventDefault();
        setActive({ r: mod ? p.rows.length - 1 : active.r, c: p.columns.length - 1 });
        reveal(mod ? p.rows.length - 1 : active.r, p.columns.length - 1);
        return;
    }
    if (mod && e.key.toLowerCase() === "c") {
      void navigator.clipboard?.writeText(clipboardCell(display(row.cells[col.key]))).catch(() => {});
      return;
    }
    // Typing replaces the cell's text; a checkbox has none, so a key does nothing there.
    if (!mod && !e.altKey && e.key.length === 1 && !isFixed(row, col) && col.type !== "checkbox") {
      e.preventDefault();
      startEdit(active.r, active.c, col.type === "date" || col.type === "datetime" ? undefined : e.key);
    }
  };

  // Paste a block from Excel or Sheets. Cells of locked rows are skipped, and so are values a
  // dropdown doesn't list.
  const onPaste = (e: React.ClipboardEvent) => {
    if (editing || !active || p.readOnly) return;
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    const edits: CellEdit[] = [];
    parseClipboard(text).forEach((cells, i) => {
      const row = p.rows[active.r + i];
      if (!row) return;
      cells.forEach((raw, j) => {
        const col = p.columns[active.c + j];
        if (!col || isFixed(row, col)) return;
        const value = coercePasted(raw, col);
        if (value !== undefined) edits.push({ rowId: row.id, key: col.key, value });
      });
    });
    if (edits.length) p.onEdit(edits, "Paste");
  };

  // Column resizing
  const resizing = useRef<{ key: string; startX: number; startW: number } | null>(null);
  const startResize = (e: React.MouseEvent, col: Column) => {
    e.preventDefault();
    e.stopPropagation();
    resizing.current = { key: col.key, startX: e.clientX, startW: widthOf(col) };
    const onMove = (ev: MouseEvent) => {
      const r = resizing.current;
      if (!r) return;
      setWidths((w) => ({ ...w, [r.key]: Math.max(64, Math.min(640, r.startW + ev.clientX - r.startX)) }));
    };
    const onUp = (ev: MouseEvent) => {
      const r = resizing.current;
      resizing.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (r) p.onResize(r.key, Math.max(64, Math.min(640, r.startW + ev.clientX - r.startX)));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const allSelected = p.rows.length > 0 && p.rows.every((r) => p.selected.has(r.id));
  const someSelected = !allSelected && p.rows.some((r) => p.selected.has(r.id));
  const toggleAll = () => {
    const next = new Set(p.selected);
    if (allSelected) p.rows.forEach((r) => next.delete(r.id));
    else p.rows.forEach((r) => next.add(r.id));
    p.onSelect(next);
  };
  const toggleOne = (id: string) => {
    const next = new Set(p.selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    p.onSelect(next);
  };

  const pinnedStyle = (i: number) => (i < p.pinned ? { position: "sticky" as const, left: lefts[i], zIndex: 2 } : undefined);

  return (
    <div
      ref={scroller}
      tabIndex={0}
      onMouseDownCapture={onMouseDownCapture}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      className="relative h-full overflow-auto bg-paper outline-none scroll-thin"
    >
      <div style={{ width: totalWidth, minWidth: "100%" }}>
        {/* header */}
        <div className="sticky top-0 z-20 flex h-10 border-b-2 border-rim/40 bg-paper-deep/60 font-label text-[12px] font-bold tracking-wide text-mud-soft uppercase" style={{ width: totalWidth, minWidth: "100%" }}>
          <div className="sticky left-0 z-[3] flex shrink-0 items-center gap-1.5 border-r border-rim/40 bg-paper pl-3" style={{ width: GUTTER }}>
            <input
              type="checkbox"
              aria-label="Select all rows"
              className="h-3.5 w-3.5 accent-clay"
              checked={allSelected}
              ref={(el) => { if (el) el.indeterminate = someSelected; }}
              onChange={toggleAll}
            />
            {/* Capped to fit beside the checkbox; the full count is in the tooltip. */}
            <span className="truncate font-sans text-xs font-normal tracking-normal normal-case tabular-nums" title={`${p.rows.length.toLocaleString()} rows`}>
              {p.rows.length > 999 ? "999+" : p.rows.length}
            </span>
          </div>
          {p.columns.map((col, i) => {
            const s = p.sort?.key === col.key ? p.sort.dir : null;
            return (
              <div
                key={col.key}
                style={{ width: widthOf(col), ...pinnedStyle(i) }}
                className={cn(
                  "group relative flex shrink-0 items-center border-r border-rim/25 bg-paper px-2.5",
                  i === p.pinned - 1 && "shadow-[1px_0_0_var(--color-rim)]",
                )}
              >
                <button
                  className="flex min-w-0 flex-1 items-center gap-1 text-left hover:text-mud"
                  onClick={() => p.onSort(s === null ? { key: col.key, dir: "asc" } : s === "asc" ? { key: col.key, dir: "desc" } : null)}
                  title={`${col.header} — click to sort`}
                >
                  <span className="truncate">{col.header}</span>
                  {s === "asc" && <ArrowUp size={12} className="shrink-0 text-clay-deep" />}
                  {s === "desc" && <ArrowDown size={12} className="shrink-0 text-clay-deep" />}
                </button>
                <div
                  onMouseDown={(e) => startResize(e, col)}
                  className="absolute top-0 -right-1 z-10 h-full w-2 cursor-col-resize hover:bg-clay/50"
                />
              </div>
            );
          })}
        </div>

        {/* body */}
        <div className="relative" style={{ height: virt.getTotalSize() }}>
          {virt.getVirtualItems().map((vr) => {
            const row = p.rows[vr.index]!;
            const isSel = p.selected.has(row.id);
            const isOpen = p.openRowId === row.id;
            const locked = !!p.isLocked?.(row);
            // Every one opaque: the pinned cells wear it too, and the cells scrolling under them
            // would show through a see-through tint. So the tints are mixed into paper, not alpha.
            const rowBg = isOpen ? "bg-[color-mix(in_oklab,var(--color-clay-soft)_60%,var(--color-paper))]"
              : isSel ? "bg-[color-mix(in_oklab,var(--color-clay-soft)_45%,var(--color-paper))]"
              : locked ? "bg-[color-mix(in_oklab,var(--color-paper-deep)_40%,var(--color-paper))] group-hover/row:bg-paper-deep"
              : "bg-paper group-hover/row:bg-[color-mix(in_oklab,var(--color-paper-deep)_40%,var(--color-paper))]";
            return (
              <div
                key={row.id}
                className="group/row absolute left-0 flex border-b border-rim/25"
                style={{ top: 0, transform: `translateY(${vr.start}px)`, height: ROW_H, width: totalWidth, minWidth: "100%" }}
              >
                <div className={cn("sticky left-0 z-[3] flex shrink-0 items-center gap-1.5 border-r border-rim/40 pl-3", rowBg)} style={{ width: GUTTER }}>
                  <input
                    type="checkbox"
                    aria-label="Select row"
                    className="h-3.5 w-3.5 accent-clay"
                    checked={isSel}
                    onChange={() => toggleOne(row.id)}
                    // A click (not Space on the box) also picks the row, so Space then opens it.
                    onClick={(e) => e.detail > 0 && pickRow(vr.index)}
                  />
                  <button
                    className={cn("rounded-sm p-1 text-mud-faint hover:bg-clay-soft hover:text-clay-deep", !isOpen && "opacity-0 group-hover/row:opacity-100")}
                    onClick={() => {
                      pickRow(vr.index);
                      p.onOpenRow(row.id);
                    }}
                    title={`${p.openLabel ?? "Open prospect"} (Space)`}
                  >
                    <Maximize2 size={13} />
                  </button>
                </div>
                {p.columns.map((col, ci) => {
                  const isActive = active?.r === vr.index && active?.c === ci;
                  const isEditing = editing?.r === vr.index && editing?.c === ci;
                  const greyed = locked && col.key !== p.schema.screenedKey;
                  const view = <CellView col={col} cells={row.cells} schema={p.schema} stages={p.stages} />;
                  return (
                    <div
                      key={col.key}
                      style={{ width: widthOf(col), ...pinnedStyle(ci) }}
                      className={cn(
                        "group/cell relative flex shrink-0 items-center border-r border-rim/50 px-2.5 text-[13px]",
                        rowBg,
                        ci === p.pinned - 1 && "shadow-[1px_0_0_var(--color-rim)]",
                        ci === 0 && "font-medium",
                        isActive && !isEditing && "ring-2 ring-clay ring-inset",
                        isEditing && "z-[4] overflow-visible p-0",
                      )}
                      onMouseDown={(e) => {
                        if (editing && !isEditing) return;
                        if (e.button !== 0) return;
                        setActive({ r: vr.index, c: ci });
                      }}
                      onDoubleClick={() => startEdit(vr.index, ci)}
                    >
                      {isEditing ? (
                        <CellEditor
                          col={col}
                          value={row.cells[col.key] ?? null}
                          initial={editing.initial}
                          onCommit={(v, dir) => commit(vr.index, ci, v, dir)}
                          onCancel={() => {
                            setEditing(null);
                            scroller.current?.focus({ preventScroll: true });
                          }}
                        />
                      ) : (
                        <div className={cn("flex min-w-0 flex-1 items-center overflow-hidden", greyed && "opacity-50")}>
                          {col.type === "checkbox" && !isFixed(row, col) ? (
                            <button
                              type="button"
                              role="checkbox"
                              tabIndex={-1}
                              aria-checked={isChecked(row.cells[col.key])}
                              aria-label={col.header}
                              className="-ml-0.5 rounded-sm p-0.5 hover:bg-paper-deep"
                              onClick={() => startEdit(vr.index, ci)}
                              onDoubleClick={(e) => e.stopPropagation()}
                            >
                              {view}
                            </button>
                          ) : view}
                          {p.pending?.get(row.id)?.has(col.key) && (
                            <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-clay ring-2 ring-paper" title="AI suggestion waiting for review" />
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});
