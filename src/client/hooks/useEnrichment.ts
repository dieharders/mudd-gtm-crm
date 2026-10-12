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
import { useCallback, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { applyRunRow, isLiveStatus, mergeSources, newestFirst, sourcesColumn, withRun, type CampaignEvent, type EnrichRun, type IntroOptions, type Recipe, type RecipeDraft, type Suggestion } from "../../shared/ai";
import { columnOf } from "../../shared/schema";
import { contactLabel, isEmptyContact } from "../../shared/values";
import type { CellEdit } from "../../shared/types";
import { api } from "../lib/api";
import type { FinishedRows } from "../lib/quickFilters";
import { useCampaignEvents } from "../lib/campaignEvents";
import { useLoadOnce } from "../lib/loadOnce";
import type { CampaignState } from "./useCampaign";
import type { ConsentGate } from "./useConsentGate";

const cellOf = (s: Suggestion) => `${s.rowId}\n${s.key}`;

export function useEnrichment(state: CampaignState, consent: ConsentGate) {
  const campaign = state.campaign;
  const id = campaign?.id ?? "";
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [runs, setRuns] = useState<EnrichRun[]>([]);
  // The rows every kept run finished, by recipe: `runs` holds only the latest, and those since.
  const [finished, setFinished] = useState<FinishedRows>(new Map());
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);

  useLoadOnce(id, (current) => {
    api.recipes(id).then((list) => current() && setRecipes(list)).catch(() => {});
    api.runs(id).then((list) => current() && setRuns((prev) => list.reduce(withRun, prev.filter((r) => r.campaignId === id)))).catch(() => {});
    api.finishedRows(id).then((byRecipe) => current() && setFinished(new Map(Object.entries(byRecipe).map(([recipe, rows]) => [recipe, new Set(rows)])))).catch(() => {});
    api.suggestions(id).then((list) => current() && setSuggestions(list)).catch(() => {});
  });

  // Live updates while the campaign is open.
  const { applyRemote, applyRemoteRows, replaceCampaign } = state;
  useCampaignEvents(id, useCallback((ev: CampaignEvent) => {
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
    } else if (ev.type === "rows") {
      applyRemoteRows(ev.rows);
    } else if (ev.type === "campaign") {
      // The server added columns (a recipe's outputs, Discovery's intel): the cells that follow need them.
      replaceCampaign(ev.campaign);
    } else if (ev.type === "recipes") {
      // A recipe the server made (Discovery, accepting a company), changed or removed.
      setRecipes(ev.recipes);
    }
  }, [applyRemote, applyRemoteRows, replaceCampaign]));

  const pendingByRow = useMemo(() => {
    const map = new Map<string, Suggestion[]>();
    for (const s of suggestions) map.set(s.rowId, [...(map.get(s.rowId) ?? []), s]);
    return map;
  }, [suggestions]);

  const accept = useCallback(async (list: Suggestion[]) => {
    if (!campaign || !list.length) return;
    const schema = campaign.schema;
    const sourcesCol = sourcesColumn(schema);
    const nameKey = schema.contacts?.nameKey;
    // Names accepted in this same batch: a contact a run made is still unnamed until then.
    const names = new Map(list.filter((s) => s.key === nameKey).map((s) => [s.rowId, s.value]));
    const edits: CellEdit[] = [];
    const sourcesByRow = new Map<string, string | null>();
    for (const s of list) {
      edits.push({ rowId: s.rowId, key: s.key, value: s.value });
      const found = state.rowById.get(s.rowId);
      if (sourcesCol && s.sources.length && found) {
        // A contact's finding: its sources go on its prospect, where the column is, under the
        // person's name, so each of its people's sources can be told apart.
        const orgId = found.parentId ?? found.id;
        const cur = sourcesByRow.has(orgId) ? sourcesByRow.get(orgId)! : ((state.rowById.get(orgId)?.cells[sourcesCol.key] as string | undefined) ?? null);
        const header = columnOf(schema, s.key)?.header ?? s.key;
        const named = nameKey && names.has(found.id) && !found.cells[nameKey] ? { ...found.cells, [nameKey]: names.get(found.id)! } : found.cells;
        sourcesByRow.set(orgId, mergeSources(cur, found.parentId ? `${contactLabel({ cells: named }, schema)} · ${header}` : header, s.sources));
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
    // A contact a run made for someone it found is empty until accepted: with every finding
    // for it rejected, it goes too (one undo step, like any delete). Only such a contact is both
    // empty and has findings: a run researches no empty contact of the user's (researchedContacts).
    const schema = campaign?.schema;
    if (schema) {
      const waiting = new Set(suggestions.filter((s) => !ids.has(s.id)).map((s) => s.rowId));
      const empty = [...new Set(list.map((s) => s.rowId))].filter((rowId) => {
        const row = state.rowById.get(rowId);
        return !!row?.parentId && !waiting.has(rowId) && isEmptyContact(row, schema);
      });
      if (empty.length) state.deleteRows(empty, empty.length === 1 ? "Remove empty contact" : `Remove ${empty.length} empty contacts`);
    }
    await api.setSuggestions(id, [...ids], "rejected").catch((e) => toast.error(e.message));
  }, [campaign, id, state, suggestions]);

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
  const { withConsent } = consent;
  const start = useCallback(async (body: { kind: "enrich" | "intro"; recipeId?: string; rowIds: string[]; test?: boolean; autoFill?: boolean; concurrency?: number; intro?: IntroOptions }) => {
    await state.flush();
    const run = await withConsent(() => api.startRun(id, body));
    if (run) setRuns((prev) => withRun(prev, run));
    return run;
  }, [id, state, withConsent]);

  const action = useCallback(async (runId: string, a: "pause" | "resume" | "stop") => {
    const run = await api.runAction(runId, a).catch((e) => {
      toast.error(e.message);
      return null;
    });
    // The new status itself comes over the stream, sent before this reply.
    if (run) setRuns((prev) => withRun(prev, run));
  }, []);

  const activeRuns = runs.filter((r) => isLiveStatus(r.status));

  return {
    recipes, runs, finished, activeRuns, suggestions, pendingByRow, accept, reject, saveRecipe, deleteRecipe, start, action,
  };
}

export type EnrichmentState = ReturnType<typeof useEnrichment>;
