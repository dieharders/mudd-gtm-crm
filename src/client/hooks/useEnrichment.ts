/**
 * One campaign's enrichment state: recipes, runs, pending suggestions, and the live event
 * stream from the server. Accepting a suggestion goes through the campaign's own `edit`, so
 * it saves, shows "Saved", and can be undone like any other edit.
 *
 * A live run comes whole over the stream (when it connects, and on each status change), then
 * one changed row at a time, in order. So the stream's copy of a live run is the newest the
 * page has, and a copy a request returned only fills a gap: replacing the stream's copy with
 * it would undo the row updates that arrived in between, and nothing would bring them back.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { applyRunRow, mergeSources, SOURCES_HEADER, type CampaignEvent, type EnrichRun, type IntroOptions, type Recipe, type Suggestion } from "../../shared/ai";
import type { CellEdit } from "../../shared/types";
import { api, ApiError, type RecipeDraft } from "../lib/api";
import type { CampaignState } from "./useCampaign";

const isLive = (r: EnrichRun) => r.status === "running" || r.status === "paused" || r.status === "stopping";
const newestFirst = (a: EnrichRun, b: EnrichRun) => b.startedAt - a.startedAt;

/** Take a run a request returned, unless it is live and the stream already brought it. */
function withRun(runs: EnrichRun[], run: EnrichRun): EnrichRun[] {
  if (isLive(run) && runs.some((r) => r.id === run.id)) return runs;
  return [run, ...runs.filter((r) => r.id !== run.id)].sort(newestFirst);
}

const cellOf = (s: Suggestion) => `${s.rowId}\n${s.key}`;

export function useEnrichment(state: CampaignState) {
  const campaign = state.campaign;
  const id = campaign?.id ?? "";
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [runs, setRuns] = useState<EnrichRun[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [needsConsent, setNeedsConsent] = useState<null | { confirm: () => void; cancel: () => void }>(null);

  useEffect(() => {
    if (!id) return;
    // A reply for the campaign the page has since left is dropped.
    let current = true;
    api.recipes(id).then((list) => current && setRecipes(list)).catch(() => {});
    api.runs(id).then((list) => current && setRuns((prev) => list.reduce(withRun, prev.filter((r) => r.campaignId === id)))).catch(() => {});
    api.suggestions(id).then((list) => current && setSuggestions(list)).catch(() => {});
    return () => {
      current = false;
    };
  }, [id]);

  // Live updates while the campaign is open.
  const { applyRemote } = state;
  useEffect(() => {
    if (!id) return;
    const es = new EventSource(`/api/campaigns/${id}/events`);
    es.onmessage = (m) => {
      let ev: CampaignEvent;
      try {
        ev = JSON.parse(m.data) as CampaignEvent;
      } catch {
        return;
      }
      if (ev.type === "run") {
        const run = ev.run;
        setRuns((prev) => [run, ...prev.filter((r) => r.id !== run.id)].sort(newestFirst));
        if (run.status === "done" && run.finishedAt && Date.now() - run.finishedAt < 3000) {
          toast.success(`${run.label}: ${run.completed} of ${run.total} rows done${run.suggestions ? ` · ${run.suggestions} suggestions to review` : ""}`, { id: `run-${run.id}` });
        }
        if (run.status === "failed" && run.error) toast.error(run.error, { id: `run-${run.id}` });
      } else if (ev.type === "runRow") {
        // A run the page doesn't have yet is skipped: it arrives whole, rows included.
        setRuns((prev) => applyRunRow(prev, ev));
      } else if (ev.type === "suggestions") {
        // Any new finding for a cell replaces the one waiting there, as on the server, even
        // when auto-fill used it: accepting the old one would overwrite the filled value.
        const cells = new Set(ev.suggestions.map(cellOf));
        const fresh = ev.suggestions.filter((s) => s.status === "pending");
        setSuggestions((prev) => {
          const kept = prev.filter((p) => !cells.has(cellOf(p)));
          return kept.length === prev.length && !fresh.length ? prev : [...kept, ...fresh];
        });
      } else if (ev.type === "cells") {
        applyRemote(ev.edits);
      }
    };
    return () => es.close();
  }, [id, applyRemote]);

  const pendingByRow = useMemo(() => {
    const map = new Map<string, Suggestion[]>();
    for (const s of suggestions) map.set(s.rowId, [...(map.get(s.rowId) ?? []), s]);
    return map;
  }, [suggestions]);

  const accept = useCallback(async (list: Suggestion[]) => {
    if (!campaign || !list.length) return;
    const schema = campaign.schema;
    const sourcesCol = schema.columns.find((c) => c.header === SOURCES_HEADER);
    const edits: CellEdit[] = [];
    const sourcesByRow = new Map<string, string | null>();
    for (const s of list) {
      edits.push({ rowId: s.rowId, key: s.key, value: s.value });
      if (sourcesCol && s.sources.length) {
        const row = state.rows.find((r) => r.id === s.rowId);
        const cur = sourcesByRow.has(s.rowId) ? sourcesByRow.get(s.rowId)! : ((row?.cells[sourcesCol.key] as string | undefined) ?? null);
        const header = schema.columns.find((c) => c.key === s.key)?.header ?? s.key;
        sourcesByRow.set(s.rowId, mergeSources(cur, header, s.sources));
      }
    }
    if (sourcesCol) for (const [rowId, v] of sourcesByRow) edits.push({ rowId, key: sourcesCol.key, value: v });
    state.edit(edits, list.length === 1 ? "Accept suggestion" : `Accept ${list.length} suggestions`);
    const ids = new Set(list.map((s) => s.id));
    setSuggestions((prev) => prev.filter((s) => !ids.has(s.id)));
    await api.setSuggestions(id, [...ids], "accepted").catch((e) => toast.error(e.message));
  }, [campaign, id, state]);

  const reject = useCallback(async (list: Suggestion[]) => {
    if (!list.length) return;
    const ids = new Set(list.map((s) => s.id));
    setSuggestions((prev) => prev.filter((s) => !ids.has(s.id)));
    await api.setSuggestions(id, [...ids], "rejected").catch((e) => toast.error(e.message));
  }, [id]);

  const saveRecipe = useCallback(async (draft: RecipeDraft, existing?: Recipe | null) => {
    const res = existing ? await api.updateRecipe(existing.id, draft) : await api.createRecipe(id, draft);
    setRecipes((prev) => [res.recipe, ...prev.filter((r) => r.id !== res.recipe.id)]);
    state.replaceCampaign(res.campaign);
    return res.recipe;
  }, [id, state]);

  const deleteRecipe = useCallback(async (rid: string) => {
    await api.deleteRecipe(rid);
    setRecipes((prev) => prev.filter((r) => r.id !== rid));
  }, []);

  /** Start a run; the first time, the user confirms that rows are sent to their provider. */
  const start = useCallback(async (body: { kind: "enrich" | "intro"; recipeId?: string; rowIds: string[]; test?: boolean; autoFill?: boolean; concurrency?: number; intro?: IntroOptions }) => {
    await state.flush();
    try {
      const run = await api.startRun(id, body);
      setRuns((prev) => withRun(prev, run));
      return run;
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        return new Promise<EnrichRun | null>((resolve) => {
          setNeedsConsent({
            cancel: () => {
              setNeedsConsent(null);
              resolve(null);
            },
            confirm: () => {
              setNeedsConsent(null);
              api.aiSettings({ consented: true })
                .then(() => api.startRun(id, body))
                .then((run) => {
                  setRuns((prev) => withRun(prev, run));
                  resolve(run);
                })
                .catch((e: unknown) => {
                  toast.error((e as Error).message);
                  resolve(null);
                });
            },
          });
        });
      }
      toast.error((err as Error).message);
      return null;
    }
  }, [id, state]);

  const action = useCallback(async (runId: string, a: "pause" | "resume" | "stop") => {
    const run = await api.runAction(runId, a).catch((e) => {
      toast.error(e.message);
      return null;
    });
    // The new status itself comes over the stream, sent before this reply.
    if (run) setRuns((prev) => withRun(prev, run));
  }, []);

  const activeRuns = runs.filter(isLive);

  return {
    recipes, runs, activeRuns, suggestions, pendingByRow, accept, reject, saveRecipe, deleteRecipe, start, action,
    needsConsent,
  };
}

export type EnrichmentState = ReturnType<typeof useEnrichment>;
