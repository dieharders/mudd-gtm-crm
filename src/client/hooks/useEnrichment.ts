/**
 * One campaign's enrichment state: recipes, runs, pending suggestions, and the live event
 * stream from the server. Accepting a suggestion goes through the campaign's own `edit`, so
 * it saves, shows "Saved", and can be undone like any other edit.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { mergeSources, SOURCES_HEADER, type CampaignEvent, type EnrichRun, type IntroOptions, type Recipe, type Suggestion } from "../../shared/ai";
import type { CellEdit } from "../../shared/types";
import { api, ApiError, type RecipeDraft } from "../lib/api";
import type { CampaignState } from "./useCampaign";

export function useEnrichment(state: CampaignState) {
  const campaign = state.campaign;
  const id = campaign?.id ?? "";
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [runs, setRuns] = useState<EnrichRun[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [needsConsent, setNeedsConsent] = useState<null | { confirm: () => void; cancel: () => void }>(null);

  useEffect(() => {
    if (!id) return;
    api.recipes(id).then(setRecipes).catch(() => {});
    api.runs(id).then(setRuns).catch(() => {});
    api.suggestions(id).then(setSuggestions).catch(() => {});
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
        setRuns((prev) => [run, ...prev.filter((r) => r.id !== run.id)].sort((a, b) => b.startedAt - a.startedAt));
        if (run.status === "done" && run.finishedAt && Date.now() - run.finishedAt < 3000) {
          toast.success(`${run.label}: ${run.completed} of ${run.total} rows done${run.suggestions ? ` · ${run.suggestions} suggestions to review` : ""}`, { id: `run-${run.id}` });
        }
        if (run.status === "failed" && run.error) toast.error(run.error, { id: `run-${run.id}` });
      } else if (ev.type === "suggestions") {
        const fresh = ev.suggestions.filter((s) => s.status === "pending");
        if (fresh.length) {
          setSuggestions((prev) => {
            const replaced = prev.filter((p) => !fresh.some((f) => f.rowId === p.rowId && f.key === p.key));
            return [...replaced, ...fresh];
          });
        }
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
      setRuns((prev) => [run, ...prev.filter((r) => r.id !== run.id)]);
      return run;
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        return new Promise<EnrichRun | null>((resolve) => {
          setNeedsConsent({
            cancel: () => {
              setNeedsConsent(null);
              resolve(null);
            },
            confirm: async () => {
              setNeedsConsent(null);
              try {
                await api.aiSettings({ consented: true });
                const run = await api.startRun(id, body);
                setRuns((prev) => [run, ...prev.filter((r) => r.id !== run.id)]);
                resolve(run);
              } catch (e) {
                toast.error((e as Error).message);
                resolve(null);
              }
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
    if (run) setRuns((prev) => prev.map((r) => (r.id === run.id ? run : r)));
  }, []);

  const activeRuns = runs.filter((r) => r.status === "running" || r.status === "paused" || r.status === "stopping");

  return {
    recipes, runs, activeRuns, suggestions, pendingByRow, accept, reject, saveRecipe, deleteRecipe, start, action,
    needsConsent,
  };
}

export type EnrichmentState = ReturnType<typeof useEnrichment>;
