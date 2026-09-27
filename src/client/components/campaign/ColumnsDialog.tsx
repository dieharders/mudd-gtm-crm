/**
 * Add, rename, retype, hide and delete columns.
 *
 * Columns that exist in the spreadsheet can be hidden but not deleted: they are still in the
 * file, and export writes every row back to them. Columns Mudd itself relies on (Status, Intro
 * message, the meeting pair, the screening reason) can be renamed or hidden, not removed.
 */
import { Eye, EyeOff, Lock, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { COLUMN_TYPES, type CampaignSchema, type Column, type ColumnType } from "../../../shared/types";
import { cn } from "../../lib/cn";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";

const slug = (h: string, taken: Set<string>) => {
  const base = h.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32) || "col";
  let k = base;
  for (let i = 2; taken.has(k); i++) k = `${base}_${i}`;
  return k;
};

export function ColumnsDialog({ open, onClose, schema, onSave, inSheet }: {
  open: boolean;
  onClose: () => void;
  schema: CampaignSchema;
  onSave: (s: CampaignSchema) => void;
  inSheet: Set<string>;
}) {
  const [cols, setCols] = useState<Column[]>(schema.columns);
  const [newHeader, setNewHeader] = useState("");
  const [newType, setNewType] = useState<ColumnType>("text");
  useEffect(() => {
    if (open) setCols(schema.columns.map((c) => ({ ...c })));
  }, [open, schema]);

  const roleKeys = new Set([schema.statusKey, schema.introKey, schema.meetingAtKey, schema.meetingUrlKey, schema.reasonKey].filter(Boolean));
  const role = (k: string) =>
    k === schema.statusKey ? "Pipeline status" : k === schema.introKey ? "Intro message" : k === schema.meetingAtKey ? "Meeting time"
      : k === schema.meetingUrlKey ? "Meeting link" : k === schema.reasonKey ? "Screened reason" : null;

  const patch = (key: string, p: Partial<Column>) => setCols((cs) => cs.map((c) => (c.key === key ? { ...c, ...p } : c)));
  const add = () => {
    const header = newHeader.trim();
    if (!header) return;
    const key = slug(header, new Set(cols.map((c) => c.key)));
    setCols((cs) => [...cs, { key, header, type: newType, origin: "user", options: newType === "select" ? [] : undefined }]);
    setNewHeader("");
  };
  const save = () => {
    onSave({ ...schema, columns: cols.map((c) => ({ ...c, header: c.header.trim() || c.header })) });
    onClose();
  };
  const dupes = new Set(cols.map((c) => c.header.trim().toLowerCase()).filter((h, i, a) => a.indexOf(h) !== i));

  return (
    <Modal
      open={open}
      onClose={onClose}
      width="max-w-3xl"
      title="Columns"
      subtitle="New columns are added after your last spreadsheet column on export, so existing formulas keep working."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={dupes.size > 0}>Save columns</Button>
        </>
      }
    >
      <div className="max-h-[52vh] overflow-y-auto pr-1 scroll-thin">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-panel text-left text-xs text-ink-faint">
            <tr>
              <th className="w-8 py-1.5" />
              <th className="py-1.5 font-medium">Header</th>
              <th className="w-36 py-1.5 font-medium">Type</th>
              <th className="py-1.5 font-medium">Dropdown options</th>
              <th className="w-9" />
            </tr>
          </thead>
          <tbody>
            {cols.map((c) => {
              const locked = inSheet.has(c.key) || roleKeys.has(c.key);
              const dup = dupes.has(c.header.trim().toLowerCase());
              return (
                <tr key={c.key} className={cn("border-t border-line", c.hidden && "opacity-55")}>
                  <td className="py-1.5">
                    <button className="rounded p-1 text-ink-faint hover:bg-stone-100 hover:text-ink" onClick={() => patch(c.key, { hidden: !c.hidden })} title={c.hidden ? "Show in grid" : "Hide in grid"}>
                      {c.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </td>
                  <td className="py-1.5 pr-2">
                    <input className={cn("field h-8 py-0", dup && "border-rose-300")} value={c.header} onChange={(e) => patch(c.key, { header: e.target.value })} />
                    {role(c.key) && <span className="mt-0.5 block text-[10px] text-clay-600">{role(c.key)}</span>}
                  </td>
                  <td className="py-1.5 pr-2">
                    <select className="field h-8 py-0" value={c.type} disabled={c.key === schema.statusKey}
                      onChange={(e) => patch(c.key, { type: e.target.value as ColumnType, options: e.target.value === "select" ? c.options ?? [] : c.options })}>
                      {COLUMN_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                  </td>
                  <td className="py-1.5 pr-2">
                    {c.type === "select" ? (
                      <input className="field h-8 py-0 text-xs" placeholder="Comma-separated" value={(c.options ?? []).join(", ")}
                        onChange={(e) => patch(c.key, { options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
                    ) : <span className="text-xs text-ink-faint">—</span>}
                  </td>
                  <td className="py-1.5">
                    {locked ? (
                      <span className="flex justify-center text-ink-faint" title={inSheet.has(c.key) ? "In your spreadsheet — hide it instead" : "Used by Mudd — hide it instead"}><Lock size={13} /></span>
                    ) : (
                      <button className="rounded p-1 text-ink-faint hover:bg-rose-50 hover:text-rose-600" title="Delete column" onClick={() => setCols((cs) => cs.filter((x) => x.key !== c.key))}>
                        <Trash2 size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <form className="mt-3 flex gap-2 border-t border-line pt-3" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <input className="field h-9" placeholder="New column header" value={newHeader} onChange={(e) => setNewHeader(e.target.value)} />
        <select className="field h-9 w-40" value={newType} onChange={(e) => setNewType(e.target.value as ColumnType)}>
          {COLUMN_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <Button type="submit" disabled={!newHeader.trim()}><Plus size={15} /> Add</Button>
      </form>
      {dupes.size > 0 && <p className="mt-2 text-xs text-rose-600">Two columns can't share a header.</p>}
    </Modal>
  );
}
