/** Recipes, runs and suggestions in SQLite. Stored as JSON documents: small, and read whole. */
import type { EnrichRun, Recipe, Suggestion, SuggestionStatus } from "../../shared/ai";
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

export function saveRun(run: EnrichRun): void {
  getDb().query("INSERT OR REPLACE INTO runs (id, campaign_id, json, started_at) VALUES (?, ?, ?, ?)").run(run.id, run.campaignId, JSON.stringify(run), run.startedAt);
}

export function getRun(id: string): EnrichRun | null {
  const r = getDb().query("SELECT json FROM runs WHERE id = ?").get(id) as { json: string } | null;
  return r ? (JSON.parse(r.json) as EnrichRun) : null;
}

export function listRuns(campaignId: string, limit = 20): EnrichRun[] {
  return (getDb().query("SELECT json FROM runs WHERE campaign_id = ? ORDER BY started_at DESC LIMIT ?").all(campaignId, limit) as { json: string }[])
    .map((r) => JSON.parse(r.json) as EnrichRun);
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

/** A newer suggestion for the same cell replaces an older one still waiting for review. */
export function supersedePending(campaignId: string, rowId: string, key: string): void {
  const d = getDb();
  const rows = d.query("SELECT id, json FROM suggestions WHERE campaign_id = ? AND row_id = ? AND status = 'pending'").all(campaignId, rowId) as { id: string; json: string }[];
  for (const r of rows) {
    const s = JSON.parse(r.json) as Suggestion;
    if (s.key === key) d.query("DELETE FROM suggestions WHERE id = ?").run(r.id);
  }
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
