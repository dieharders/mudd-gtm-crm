/** Recipes, runs and suggestions in SQLite. Stored as JSON documents: small, and read whole. */
import type { EnrichRun, Recipe, Suggestion, SuggestionStatus } from "../../shared/ai";
import type { CellValue } from "../../shared/types";
import { sameValue } from "../../shared/values";
import { getDb, newId } from "../db";

// ---------- recipes ----------

export function listRecipes(campaignId: string): Recipe[] {
  return (getDb().query("SELECT json FROM recipes WHERE campaign_id = ? ORDER BY updated_at DESC").all(campaignId) as { json: string }[])
    .map((r) => JSON.parse(r.json) as Recipe);
}

export function getRecipe(id: string): Recipe | null {
  const r = getDb().query("SELECT json FROM recipes WHERE id = ?").get(id) as { json: string } | null;
  return r ? (JSON.parse(r.json) as Recipe) : null;
}

export function saveRecipe(recipe: Omit<Recipe, "id" | "createdAt" | "updatedAt"> & Partial<Pick<Recipe, "id" | "createdAt">>): Recipe {
  const now = Date.now();
  const full: Recipe = { ...recipe, id: recipe.id ?? newId(), createdAt: recipe.createdAt ?? now, updatedAt: now } as Recipe;
  getDb().query("INSERT OR REPLACE INTO recipes (id, campaign_id, json, updated_at) VALUES (?, ?, ?, ?)").run(full.id, full.campaignId, JSON.stringify(full), now);
  return full;
}

export function deleteRecipe(id: string): void {
  getDb().query("DELETE FROM recipes WHERE id = ?").run(id);
}

// ---------- runs ----------

/** Store a run; not once its campaign is removed (a run stopping just after has nowhere to go). */
export function saveRun(run: EnrichRun): void {
  getDb()
    .query("INSERT OR REPLACE INTO runs (id, campaign_id, json, started_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM campaigns WHERE id = ?)")
    .run(run.id, run.campaignId, JSON.stringify(run), run.startedAt, run.campaignId);
}

export function getRun(id: string): EnrichRun | null {
  const r = getDb().query("SELECT json FROM runs WHERE id = ?").get(id) as { json: string } | null;
  return r ? (JSON.parse(r.json) as EnrichRun) : null;
}

export function listRuns(campaignId: string, limit = 20): EnrichRun[] {
  return (getDb().query("SELECT json FROM runs WHERE campaign_id = ? ORDER BY started_at DESC LIMIT ?").all(campaignId, limit) as { json: string }[])
    .map((r) => JSON.parse(r.json) as EnrichRun);
}

/**
 * The rows each recipe's runs finished, over every run the campaign kept (listRuns has only the
 * latest): recipe id → row ids. A row a run finished keeps its answer, even when that was a blank.
 */
export function finishedRows(campaignId: string): Record<string, string[]> {
  const rows = getDb()
    .query(`SELECT DISTINCT json_extract(r.json, '$.recipeId') AS recipe, j.key AS row FROM runs r, json_each(r.json, '$.rows') j
      WHERE r.campaign_id = ? AND json_extract(r.json, '$.kind') = 'enrich' AND json_extract(r.json, '$.recipeId') IS NOT NULL
        AND json_extract(j.value, '$.state') = 'done'`)
    .all(campaignId) as { recipe: string; row: string }[];
  const out: Record<string, string[]> = {};
  for (const { recipe, row } of rows) (out[recipe] ??= []).push(row);
  return out;
}

/** Runs that were live when the app last closed can't be resumed; say so instead of "running". */
export function markInterruptedRuns(): void {
  const rows = getDb().query("SELECT json FROM runs").all() as { json: string }[];
  for (const { json } of rows) {
    const run = JSON.parse(json) as EnrichRun;
    if (run.status === "running" || run.status === "paused" || run.status === "stopping") {
      run.status = "stopped";
      run.error = "Mudd was closed while this run was going. Start it again to finish the remaining rows.";
      run.finishedAt ??= Date.now();
      for (const r of Object.values(run.rows)) if (r.state === "running" || r.state === "pending") r.state = "skipped";
      saveRun(run);
    }
  }
}

// ---------- suggestions ----------

export function insertSuggestions(list: Suggestion[]): void {
  const d = getDb();
  d.transaction(() => {
    const ins = d.query("INSERT OR REPLACE INTO suggestions (id, campaign_id, run_id, row_id, status, json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const s of list) ins.run(s.id, s.campaignId, s.runId, s.rowId, s.status, JSON.stringify(s), s.createdAt);
  })();
}

export function listSuggestions(campaignId: string, status?: SuggestionStatus): Suggestion[] {
  const rows = status
    ? (getDb().query("SELECT json FROM suggestions WHERE campaign_id = ? AND status = ? ORDER BY created_at").all(campaignId, status) as { json: string }[])
    : (getDb().query("SELECT json FROM suggestions WHERE campaign_id = ? ORDER BY created_at").all(campaignId) as { json: string }[]);
  return rows.map((r) => JSON.parse(r.json) as Suggestion);
}

/**
 * Where a cell's value came from: the source of the newest finding, accepted or auto-filled, of
 * exactly this value. Null for a value typed, edited or imported, whose source nobody recorded.
 */
export function sourceOfValue(campaignId: string, rowId: string, key: string, value: CellValue): string | null {
  const rows = getDb()
    .query("SELECT json FROM suggestions WHERE campaign_id = ? AND row_id = ? AND status IN ('accepted', 'auto') AND json_extract(json, '$.key') = ? ORDER BY created_at DESC")
    .all(campaignId, rowId, key) as { json: string }[];
  for (const r of rows) {
    const s = JSON.parse(r.json) as Suggestion;
    if (sameValue(s.value, value) && s.sources[0]) return s.sources[0].url;
  }
  return null;
}

/** The values waiting for review in one column of these rows: row id → the newest one. */
export function pendingValues(campaignId: string, rowIds: string[], key: string): Map<string, CellValue> {
  const out = new Map<string, CellValue>();
  if (!rowIds.length) return out;
  const rows = getDb()
    .query("SELECT row_id, json FROM suggestions WHERE campaign_id = ? AND status = 'pending' AND row_id IN (SELECT value FROM json_each(?)) AND json_extract(json, '$.key') = ? ORDER BY created_at")
    .all(campaignId, JSON.stringify(rowIds), key) as { row_id: string; json: string }[];
  for (const r of rows) out.set(r.row_id, (JSON.parse(r.json) as Suggestion).value);
  return out;
}

/** A newer suggestion for the same cell replaces an older one still waiting for review. */
export function supersedePending(campaignId: string, rowId: string, key: string): void {
  getDb()
    .query("DELETE FROM suggestions WHERE campaign_id = ? AND row_id = ? AND status = 'pending' AND json_extract(json, '$.key') = ?")
    .run(campaignId, rowId, key);
}

export function setSuggestionStatus(campaignId: string, ids: string[], status: SuggestionStatus): Suggestion[] {
  const d = getDb();
  const out: Suggestion[] = [];
  d.transaction(() => {
    for (const id of ids) {
      const r = d.query("SELECT json FROM suggestions WHERE id = ? AND campaign_id = ?").get(id, campaignId) as { json: string } | null;
      if (!r) continue;
      const s = { ...(JSON.parse(r.json) as Suggestion), status };
      d.query("UPDATE suggestions SET status = ?, json = ? WHERE id = ?").run(status, JSON.stringify(s), id);
      out.push(s);
    }
  })();
  return out;
}

/** Suggestions for rows that no longer exist are dropped rather than shown forever. */
export function pruneOrphanSuggestions(campaignId: string): void {
  getDb().query("DELETE FROM suggestions WHERE campaign_id = ? AND status = 'pending' AND row_id NOT IN (SELECT id FROM rows WHERE campaign_id = ?)").run(campaignId, campaignId);
}
