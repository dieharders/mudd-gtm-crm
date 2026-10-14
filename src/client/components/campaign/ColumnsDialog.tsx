/**
 * Add, rename, retype, hide and delete columns.
 *
 * Columns that exist in the spreadsheet can be hidden but not deleted: they are still in the
 * file, and export writes every row back to them. Columns Mudd itself relies on (Status, Company,
 * Intro message, the meeting pair, the Screened out box and its reason, the prospect's ID; a
 * contact's name, Contact type, Primary box, Last contacted and Last reply) can only be hidden:
 * import makes them Mudd's again (header, type and dropdown list), so an edit here wouldn't last.
 *
 * It edits one list at a time: the prospects' columns, or their contacts'.
 */
import { Eye, EyeOff, Lock, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { EMPLOYEES_HEADER, isEmployeesHeader, makeKey } from "../../../shared/schema";
import { COLUMN_TYPES, type CampaignSchema, type Column, type ColumnType, type ContactSchema } from "../../../shared/types";
import { cn } from "../../lib/cn";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";

type Editable = CampaignSchema & Partial<ContactSchema>;

export function ColumnsDialog({ open, onClose, kind, schema, onSave, inSheet, usedKeys }: {
  open: boolean;
  onClose: () => void;
  kind: "prospects" | "contacts";
  schema: Editable;
  onSave: (s: Editable) => void;
  inSheet: Set<string>;
  /** Keys any row holds a value for, deleted columns' included, and every column's, prospects'
   *  and contacts' alike: a new column never reuses one. */
  usedKeys: Set<string>;
}) {
  const [cols, setCols] = useState<Column[]>(schema.columns);
  const [newHeader, setNewHeader] = useState("");
  const [newType, setNewType] = useState<ColumnType>("text");
  useEffect(() => {
    if (open) setCols(schema.columns.map((c) => ({ ...c })));
  }, [open, schema]);

  const roles: Record<string, string> = kind === "contacts"
    ? Object.fromEntries([[schema.nameKey, "Contact name"], [schema.typeKey, "Contact type"], [schema.primaryKey, "Primary contact"], [schema.lastContactedKey, "Last contacted"], [schema.lastReplyKey, "Last reply"]].filter(([k]) => k))
    : Object.fromEntries([
      [schema.statusKey, "Pipeline status"], [schema.companyKey, "Company"], [schema.introKey, "Intro message"], [schema.meetingAtKey, "Meeting time"],
      [schema.meetingUrlKey, "Meeting link"], [schema.screenedKey, "Screened out"], [schema.reasonKey, "Screened reason"],
      [schema.idKey, "Prospect ID: the Contacts tab links by it"],
    ].filter(([k]) => k));
  const roleKeys = new Set(Object.keys(roles));
  const role = (k: string) => roles[k] ?? null;

  // A company's Staff, Headcount or Size is its "# Employees", a number.
  const employees = (header: string) => kind === "prospects" && isEmployeesHeader(header);
  const tidy = (c: Column): Column => {
    const header = c.header.trim() || c.header;
    return employees(header) ? { ...c, header: EMPLOYEES_HEADER, type: "number", options: undefined } : { ...c, header };
  };
  const patch = (key: string, p: Partial<Column>) => setCols((cs) => cs.map((c) => (c.key === key ? { ...c, ...p } : c)));
  const add = () => {
    const header = newHeader.trim();
    if (!header) return;
    // Not the key of a column deleted just now, or of one whose values the rows still hold.
    const key = makeKey(header, new Set([...cols.map((c) => c.key), ...schema.columns.map((c) => c.key), ...usedKeys]));
    setCols((cs) => [...cs, tidy({ key, header, type: newType, origin: "user", options: newType === "select" ? [] : undefined })]);
    setNewHeader("");
  };
  const save = () => {
    onSave({ ...schema, columns: cols.map(tidy) });
    onClose();
  };
  const dupes = new Set(cols.map((c) => tidy(c).header.toLowerCase()).filter((h, i, a) => a.indexOf(h) !== i));
  // Only a column Mudd alone has: one in the file stays there, one Mudd uses stays in the app.
  const deletable = (c: Column) => !inSheet.has(c.key) && !roleKeys.has(c.key);
  const anyDeletable = cols.some(deletable);
  const colgroup = (
    <colgroup>
      <col className="w-14" />
      <col />
      <col className="w-36" />
      <col />
      {anyDeletable && <col className="w-14" />}
    </colgroup>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      width="max-w-3xl"
      title={kind === "contacts" ? "Contact columns" : "Columns"}
      subtitle="New columns are added after your last spreadsheet column on export, so existing formulas keep working."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={dupes.size > 0}>Save columns</Button>
        </>
      }
    >
      {/* The header sits outside the scroller, so rows scroll under a clean edge rather than showing around a sticky row
          shorter than they are. Both tables share fixed column widths and reserve the same scrollbar gutter to stay aligned. */}
      <div className="overflow-hidden border-b border-rim/40 pr-1 [scrollbar-gutter:stable] scroll-thin">
        <table className="w-full table-fixed text-sm">
          {colgroup}
          <thead className="text-left text-xs text-mud">
            <tr>
              <th className="py-1.5 text-center font-medium" title="Show the column in the grid, or hide it">Show</th>
              <th className="py-1.5 font-medium">Header</th>
              <th className="py-1.5 font-medium">Type</th>
              <th className="py-1.5 font-medium">Dropdown options</th>
              {anyDeletable && <th className="py-1.5 text-center font-medium">Delete</th>}
            </tr>
          </thead>
        </table>
      </div>
      <div className="max-h-[52vh] overflow-y-auto overscroll-contain pr-1 [scrollbar-gutter:stable] scroll-thin">
        <table className="w-full table-fixed text-sm">
          {colgroup}
          <tbody className="[&>tr:first-child]:border-t-0">
            {cols.map((c) => {
              // Mudd's own: hidden or shown, nothing else.
              const fixed = roleKeys.has(c.key);
              const why = fixed ? "Mudd relies on this column: it can be hidden, not changed" : undefined;
              const dup = dupes.has(tidy(c).header.toLowerCase());
              return (
                <tr key={c.key} className="border-t border-rim/40 align-top">
                  <td className="py-1.5">
                    <div className="flex h-8 items-center justify-center">
                      <button className="rounded-sm p-1 text-mud-faint hover:bg-paper-deep hover:text-mud" onClick={() => patch(c.key, { hidden: !c.hidden })} title={c.hidden ? "Show in grid" : "Hide in grid"}>
                        {c.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                  </td>
                  <td className="py-1.5 pr-2" title={why}>
                    <input className={cn("field h-8 py-0", dup && "border-rose-300")} value={c.header} disabled={fixed} onChange={(e) => patch(c.key, { header: e.target.value })} />
                    {fixed && (
                      <span className="mt-0.5 block text-[10px] text-clay-deep"><Lock size={10} className="inline align-[-1px]" /> {role(c.key)}</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-2" title={why}>
                    <select className="field h-8 py-0" value={c.type} disabled={fixed}
                      onChange={(e) => patch(c.key, { type: e.target.value as ColumnType, options: e.target.value === "select" ? c.options ?? [] : c.options })}>
                      {COLUMN_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                  </td>
                  <td className="py-1.5 pr-2" title={why}>
                    {c.type === "select" ? (
                      <input className="field h-8 py-0 text-xs" placeholder="Comma-separated" value={(c.options ?? []).join(", ")} disabled={fixed}
                        onChange={(e) => patch(c.key, { options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
                    ) : <span className="flex h-8 items-center text-xs text-mud-faint">—</span>}
                  </td>
                  {anyDeletable && (
                    <td className="py-1.5">
                      {deletable(c) && (
                        <div className="flex h-8 items-center justify-center">
                          <button className="rounded-sm p-1 text-mud-faint hover:bg-rose-50 hover:text-rose-600" title="Delete column" onClick={() => setCols((cs) => cs.filter((x) => x.key !== c.key))}>
                            <Trash2 size={14} />
                          </button>
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 flex flex-wrap items-center gap-x-1 text-xs text-mud-faint">
        <Lock size={11} className="text-clay-deep" /> Used by Mudd: can be hidden, not renamed or changed.
        Columns in your spreadsheet can be hidden, not deleted.
      </p>
      <form className="mt-3 flex gap-2 border-t border-rim/40 pt-3" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <input className="field h-9 py-0" placeholder="New column header" value={newHeader} onChange={(e) => setNewHeader(e.target.value)} />
        <select className="field h-9 w-40 py-0" value={newType} onChange={(e) => setNewType(e.target.value as ColumnType)}>
          {COLUMN_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <Button type="submit" size="sm" disabled={!newHeader.trim()}><Plus size={15} /> Add</Button>
      </form>
      {dupes.size > 0 && <p className="mt-2 text-xs text-rose-600">Two columns can't share a header.</p>}
    </Modal>
  );
}
