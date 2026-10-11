/** The Find run's settings: how many companies and people, a focus, what to enrich accepted ones with. */
import { Radar } from "lucide-react";
import { useState } from "react";
import type { Recipe } from "../../../shared/ai";
import { PRESETS } from "../../../shared/presets";
import { DEFAULT_ENRICH, estimateTurns, PER_COMPANY_OPTIONS, TARGET_OPTIONS, type EnrichChoice } from "../../../shared/sourcing";
import { canFind } from "../../../shared/thesis";
import type { DiscoveryState } from "../../hooks/useDiscovery";
import { cn } from "../../lib/cn";
import { Button } from "../ui/Button";
import { fire } from "../../lib/fire";

export function FindBox({ discovery, recipes, ready, onSetup, onStarted }: {
  discovery: DiscoveryState;
  /** The campaign's saved recipes, offered beside the presets. */
  recipes: Recipe[];
  ready: boolean;
  onSetup: () => void;
  onStarted?: () => void;
}) {
  const [target, setTarget] = useState(10);
  const [perCompany, setPerCompany] = useState(5);
  const [focus, setFocus] = useState("");
  const [enrich, setEnrich] = useState<EnrichChoice>(DEFAULT_ENRICH);
  const [starting, setStarting] = useState(false);
  const { thesis } = discovery;
  const busy = discovery.activeRuns.some((r) => r.kind === "find");
  const can = !!thesis && canFind(thesis);
  const turns = estimateTurns(target);
  const minutes = Math.max(1, Math.round((turns * 90) / 60 / 2));
  // Recipes made from a preset are the preset's own: listed once, as the preset.
  const own = recipes.filter((r) => !r.presetId);
  const toggle = (list: "presets" | "recipeIds", id: string) =>
    setEnrich((e) => ({ ...e, [list]: e[list].includes(id) ? e[list].filter((x) => x !== id) : [...e[list], id] }));

  const go = async () => {
    setStarting(true);
    try {
      const run = await discovery.start({ kind: "find", target, perCompany, focus: focus.trim() || null, enrich, concurrency: 2 });
      if (run) onStarted?.();
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="rounded-2xl border border-clay bg-clay-soft/30 p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="fb-target">Number of companies</label>
          <select id="fb-target" className="field" value={target} onChange={(e) => setTarget(Number(e.target.value))}>
            {TARGET_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="fb-per">Contacts per company</label>
          <select id="fb-per" className="field" value={perCompany} onChange={(e) => setPerCompany(Number(e.target.value))}>
            {PER_COMPANY_OPTIONS.map((n) => <option key={n} value={n}>up to {n}</option>)}
          </select>
        </div>
      </div>
      <div className="mt-3">
        <label className="label" htmlFor="fb-focus">Focus for this run <span className="font-normal text-mud-faint">(optional)</span></label>
        <input id="fb-focus" className="field" placeholder="e.g. only the Midwest, or companies that exhibited at FABTECH" value={focus} onChange={(e) => setFocus(e.target.value)} />
      </div>
      <div className="mt-3">
        <span className="label">Enrich accepted prospects with…</span>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => {
            const on = enrich.presets.includes(p.id);
            return (
              <button key={p.id} type="button" onClick={() => toggle("presets", p.id)} title={p.blurb}
                className={cn("tag border", on ? "border-clay bg-clay-soft text-clay-deep" : "border-rim/40 bg-paper text-mud-soft hover:border-rim")}>
                {p.name}
              </button>
            );
          })}
          {own.map((r) => {
            const on = enrich.recipeIds.includes(r.id);
            return (
              <button key={r.id} type="button" onClick={() => toggle("recipeIds", r.id)} title={`Your recipe: fills ${r.outputs.map((o) => o.header).join(", ")}`}
                className={cn("tag border", on ? "border-clay bg-clay-soft text-clay-deep" : "border-rim/40 bg-paper text-mud-soft hover:border-rim")}>
                {r.name}
              </button>
            );
          })}
        </div>
        <p className="mt-1 text-[11px] text-mud-faint">Runs on each company as you accept it, one run at a time. Its findings go to Review.</p>
      </div>
      <label className="mt-3 flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5 h-4 w-4 accent-clay" checked={enrich.autoFill} onChange={(e) => setEnrich({ ...enrich, autoFill: e.target.checked })} />
        <span>Fill empty cells automatically <span className="block text-xs text-mud-faint">Findings for cells that already have a value always wait for your review.</span></span>
      </label>
      <p className="mt-3 text-xs text-mud-soft">
        About {turns} web research turns (a few to search, one per company to map its people) · usually 1–3 minutes each, two at a time · about {minutes} min in all. Counts toward your plan's usage.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!ready ? (
          <Button variant="primary" onClick={onSetup}>Set up AI first</Button>
        ) : (
          <Button variant="primary" onClick={() => fire(go())} disabled={!can || busy || starting} title={can ? undefined : "Answer what you sell and who qualifies first"}>
            <Radar size={14} /> Find {target} companies
          </Button>
        )}
        {busy && <span className="text-xs text-clay-deep">Discovery is running…</span>}
        {!can && ready && <span className="text-xs text-mud-faint">Answer the two required thesis questions first.</span>}
      </div>
    </div>
  );
}
