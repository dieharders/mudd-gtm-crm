/** Discovery runs and candidates in SQLite, as JSON documents (see enrich/store.ts). */
import type { Candidate, CandidateStatus, DiscoveryRun } from "../../shared/sourcing";
import { getDb } from "../db";

// ---------- runs ----------

/** Store a run; not once its campaign is removed. */
export function saveDiscoveryRun(run: DiscoveryRun): void {
  getDb()
    .query("INSERT OR REPLACE INTO discovery_runs (id, campaign_id, json, started_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM campaigns WHERE id = ?)")
    .run(run.id, run.campaignId, JSON.stringify(run), run.startedAt, run.campaignId);
}

export function getDiscoveryRun(id: string): DiscoveryRun | null {
  const r = getDb().query("SELECT json FROM discovery_runs WHERE id = ?").get(id) as { json: string } | null;
  return r ? (JSON.parse(r.json) as DiscoveryRun) : null;
}

export function listDiscoveryRuns(campaignId: string, limit = 20): DiscoveryRun[] {
  return (getDb().query("SELECT json FROM discovery_runs WHERE campaign_id = ? ORDER BY started_at DESC LIMIT ?").all(campaignId, limit) as { json: string }[])
    .map((r) => JSON.parse(r.json) as DiscoveryRun);
}

/**
 * Runs that were live when the app last closed can't be resumed: they are marked stopped, and
 * the companies still being mapped marked as failed, so "Map again" can retry them.
 */
export function markInterruptedDiscovery(): void {
  const d = getDb();
  const rows = d.query("SELECT json FROM discovery_runs").all() as { json: string }[];
  for (const { json } of rows) {
    const run = JSON.parse(json) as DiscoveryRun;
    if (run.status !== "running" && run.status !== "paused" && run.status !== "stopping") continue;
    run.status = "stopped";
    run.error = "Mudd was closed while this run was going. Run Find again to look for more.";
    run.finishedAt ??= Date.now();
    for (const a of run.angles) if (a.state === "running" || a.state === "pending") a.state = "skipped";
    for (const j of Object.values(run.jobs)) if (j.state === "running" || j.state === "pending") j.state = "skipped";
    saveDiscoveryRun(run);
  }
  const stuck = d.query("SELECT json FROM candidates WHERE status = 'mapping'").all() as { json: string }[];
  for (const { json } of stuck) {
    const c = JSON.parse(json) as Candidate;
    saveCandidates([{ ...c, status: "error", error: "Mudd was closed before this company's buying committee was mapped.", updatedAt: Date.now() }]);
  }
}

// ---------- candidates ----------

export function saveCandidates(list: Candidate[]): void {
  if (!list.length) return;
  const d = getDb();
  d.transaction(() => {
    const ins = d.query(
      "INSERT OR REPLACE INTO candidates (id, campaign_id, run_id, status, json, created_at) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM campaigns WHERE id = ?)",
    );
    for (const c of list) ins.run(c.id, c.campaignId, c.runId, c.status, JSON.stringify(c), c.createdAt, c.campaignId);
  })();
}

export function getCandidate(campaignId: string, id: string): Candidate | null {
  const r = getDb().query("SELECT json FROM candidates WHERE id = ? AND campaign_id = ?").get(id, campaignId) as { json: string } | null;
  return r ? (JSON.parse(r.json) as Candidate) : null;
}

export function listCandidates(campaignId: string, status?: CandidateStatus): Candidate[] {
  const rows = status
    ? (getDb().query("SELECT json FROM candidates WHERE campaign_id = ? AND status = ? ORDER BY created_at").all(campaignId, status) as { json: string }[])
    : (getDb().query("SELECT json FROM candidates WHERE campaign_id = ? ORDER BY created_at").all(campaignId) as { json: string }[]);
  return rows.map((r) => JSON.parse(r.json) as Candidate);
}
