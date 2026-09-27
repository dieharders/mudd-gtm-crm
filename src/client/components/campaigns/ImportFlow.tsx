/**
 * Importing a spreadsheet, from anywhere in the app.
 *
 *   1. Pick a file: the native Open dialog (which remembers the path, so the campaign can later
 *      save straight back to it), a drop anywhere on the window, or a plain file input.
 *   2. Map its tabs: one Prospects tab, optionally one Screened-out tab. Every other tab is kept
 *      untouched and written back on export.
 */
import { FileSpreadsheet, Info, Upload } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import toast from "react-hot-toast";
import { useNavigate } from "react-router-dom";
import type { InspectResult } from "../../../shared/types";
import { api } from "../../lib/api";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";

interface ImportApi {
  startImport: () => void;
  busy: boolean;
}
const Ctx = createContext<ImportApi>({ startImport: () => {}, busy: false });
export const useImport = () => useContext(Ctx);

export function ImportProvider({ children }: { children: ReactNode }) {
  const [result, setResult] = useState<InspectResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const dialogs = useRef<boolean | null>(null);

  useEffect(() => {
    api.env().then((e) => (dialogs.current = e.dialogs)).catch(() => (dialogs.current = false));
  }, []);

  const inspect = useCallback(async (p: Promise<InspectResult>) => {
    setBusy(true);
    try {
      setResult(await p);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  const startImport = useCallback(async () => {
    if (busy) return;
    if (dialogs.current) {
      setBusy(true);
      try {
        const pick = await api.openDialog();
        if ("path" in pick) {
          await inspect(api.inspectPath(pick.path));
          return;
        }
        if ("cancelled" in pick) return;
      } catch (err) {
        toast.error(`Could not open the file dialog: ${(err as Error).message}`);
      } finally {
        setBusy(false);
      }
    }
    fileInput.current?.click();
  }, [busy, inspect]);

  // Drop a spreadsheet anywhere in the window.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const file = e.dataTransfer?.files[0];
      if (file) void inspect(api.inspectFile(file));
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [inspect]);

  return (
    <Ctx.Provider value={{ startImport, busy }}>
      {children}
      <input
        ref={fileInput}
        type="file"
        accept=".xlsx,.xlsm,.csv,.tsv"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void inspect(api.inspectFile(f));
        }}
      />
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center bg-brand-900/20 p-8 animate-fade-in">
          <div className="flex flex-col items-center gap-3 rounded-3xl border-2 border-dashed border-brand-400 bg-white/95 px-14 py-10 text-center shadow-2xl">
            <Upload className="text-brand-500" size={32} />
            <p className="text-lg font-semibold">Drop to import</p>
            <p className="text-sm text-ink-soft">.xlsx or .csv · read on this computer, never uploaded</p>
          </div>
        </div>
      )}
      {result && <MappingDialog result={result} onClose={() => setResult(null)} />}
    </Ctx.Provider>
  );
}

function MappingDialog({ result, onClose }: { result: InspectResult; onClose: () => void }) {
  const navigate = useNavigate();
  const initialP = result.sheets.find((s) => s.guess === "prospects")?.name ?? result.sheets[0]?.name ?? "";
  const initialS = result.sheets.find((s) => s.guess === "screened")?.name ?? null;
  const [prospects, setProspects] = useState(initialP);
  const [screened, setScreened] = useState<string | null>(initialS);
  const base = result.fileName.replace(/\.[^.]+$/, "");
  const multi = result.sheets.filter((s) => !s.hasFormulas && s.guess !== "templates").length > 2;
  const [name, setName] = useState(multi ? `${base} · ${initialP}` : base);
  const [nameTouched, setNameTouched] = useState(false);
  const [saving, setSaving] = useState(false);

  const candidates = result.sheets.filter((s) => s.guess !== "templates");
  const kept = result.sheets.filter((s) => s.name !== prospects && s.name !== screened && s.guess !== "templates");

  const chooseProspects = (n: string) => {
    setProspects(n);
    if (screened === n) setScreened(null);
    if (!nameTouched && multi) setName(`${base} · ${n}`);
  };

  const submit = async () => {
    setSaving(true);
    try {
      const c = await api.importFile(result.token, prospects, screened, name);
      toast.success(`Imported ${c.name}`);
      onClose();
      navigate(`/c/${c.id}`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const sheet = (n: string | null) => result.sheets.find((s) => s.name === n);
  const p = sheet(prospects);

  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-2xl"
      title={
        <span className="flex items-center gap-2">
          <FileSpreadsheet size={18} className="text-emerald-600" /> Import {result.fileName}
        </span>
      }
      subtitle="Choose which tab holds your prospects, and which (if any) holds the screened-out list."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={!prospects || !name.trim() || saving}>
            {saving ? "Importing…" : "Import campaign"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="label" htmlFor="imp-name">Campaign name</label>
          <input id="imp-name" className="field" value={name} onChange={(e) => { setName(e.target.value); setNameTouched(true); }} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Prospects tab</label>
            <select className="field" value={prospects} onChange={(e) => chooseProspects(e.target.value)}>
              {candidates.map((s) => (
                <option key={s.name} value={s.name} disabled={s.hasFormulas}>
                  {s.name} — {s.rows} rows{s.hasFormulas ? " (formulas)" : ""}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Screened-out tab</label>
            <select className="field" value={screened ?? ""} onChange={(e) => setScreened(e.target.value || null)}>
              <option value="">None — start empty</option>
              {candidates.filter((s) => s.name !== prospects && !s.hasFormulas).map((s) => (
                <option key={s.name} value={s.name}>{s.name} — {s.rows} rows</option>
              ))}
            </select>
          </div>
        </div>

        {p && (
          <div className="rounded-xl border border-line bg-zinc-50 p-3">
            <p className="mb-2 text-xs font-medium text-ink-soft">
              {p.name}: {p.rows} prospects · {p.cols} columns{p.hasStatus ? " · Status column found" : " · no Status column (Mudd will add one)"}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {p.headers.map((h) => (
                <span key={h} className="rounded-md border border-line bg-white px-1.5 py-0.5 text-xs text-ink-soft">{h}</span>
              ))}
              {p.cols > p.headers.length && <span className="px-1 text-xs text-ink-faint">+{p.cols - p.headers.length} more</span>}
            </div>
          </div>
        )}

        <div className="flex gap-2.5 rounded-xl bg-brand-50 p-3 text-sm text-brand-900">
          <Info size={16} className="mt-0.5 shrink-0 text-brand-500" />
          <div className="space-y-1">
            {kept.length > 0 && (
              <p>
                Kept as-is and written back on export: <strong>{kept.map((s) => s.name).join(", ")}</strong>.
              </p>
            )}
            <p>Intro message, Meeting URL and Meeting at columns are added after your last column, so formulas that point at existing columns keep working.</p>
            {result.templates > 0 && <p>{result.templates} intro template{result.templates === 1 ? "" : "s"} found and will be restored.</p>}
            {!result.path && <p className="text-brand-700">Dropped files can't be saved back in place — use <em>Save as</em> when exporting, or import with the Import button to link the file.</p>}
          </div>
        </div>
      </div>
    </Modal>
  );
}
