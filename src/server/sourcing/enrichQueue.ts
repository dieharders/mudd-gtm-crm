/**
 * Enrichment of accepted prospects, one run at a time per campaign.
 *
 * Accepting companies one by one would otherwise start a run (two CLIs) per accept, all at once.
 * Here each accept merges its rows into the campaign's waiting batch; a loop takes a batch,
 * runs each chosen recipe on it to the end, then takes the next. A recipe that cannot start (one
 * the user deleted meanwhile) is skipped, and the batch's other recipes still run. A run that
 * FAILS (a CLI gone missing or signed out) drops what is waiting: every run after it would fail
 * the same way.
 */
import { runDone, startRun } from "../enrich/runner";
import * as db from "../db";

interface Batch {
  rowIds: Set<string>;
  /** Recipe id → fill empty cells automatically. */
  recipes: Map<string, boolean>;
}

interface Queue {
  pending: Batch | null;
  running: Promise<void> | null;
}

const queues = new Map<string, Queue>();

/** Queue these rows for these recipes. Returns once they are queued, not run. */
export function enqueueEnrichment(campaignId: string, rowIds: string[], recipeIds: string[], autoFill: boolean): void {
  if (!rowIds.length || !recipeIds.length) return;
  let q = queues.get(campaignId);
  if (!q) queues.set(campaignId, (q = { pending: null, running: null }));
  const batch = (q.pending ??= { rowIds: new Set(), recipes: new Map() });
  for (const id of rowIds) batch.rowIds.add(id);
  for (const id of recipeIds) batch.recipes.set(id, batch.recipes.get(id) || autoFill);
  kick(campaignId, q);
}

/**
 * Start a drain unless one is running. A batch queued between the drain's last loop and its
 * promise settling would see `running` still set, so settling re-kicks for whatever waits.
 */
function kick(campaignId: string, q: Queue): void {
  if (q.running || !q.pending) return;
  q.running = drain(campaignId, q)
    .catch((err: unknown) => {
      // Never a rejected `running`: it would stay unhandled, and idle waiters would throw.
      console.error("[discovery] enrichment of accepted prospects failed:", err);
      q.pending = null;
    })
    .finally(() => {
      q.running = null;
      kick(campaignId, q);
    });
}

/** Resolves once nothing is queued or running for the campaign (for tests). */
export async function enrichQueueIdle(campaignId: string): Promise<void> {
  let running: Promise<void> | null | undefined;
  while ((running = queues.get(campaignId)?.running)) await running;
}

async function drain(campaignId: string, q: Queue): Promise<void> {
  while (q.pending) {
    const batch = q.pending;
    q.pending = null;
    for (const [recipeId, autoFill] of batch.recipes) {
      if (!db.getCampaign(campaignId)) return;
      let run;
      try {
        run = startRun({ campaignId, kind: "enrich", recipeId, rowIds: [...batch.rowIds], test: false, autoFill, concurrency: 2 });
      } catch (err) {
        // This recipe alone: gone, or nothing left to run it on. The others still run.
        console.error("[discovery] could not start enrichment of accepted prospects:", err);
        continue;
      }
      // A run whose pump threw (a store error mid-row) is one that failed: its recipe's turn is
      // over, and the batch's other recipes still get theirs.
      await runDone(run.id).catch((err: unknown) => console.error("[discovery] enrichment run ended in error:", err));
      if (run.status === "failed") {
        q.pending = null;
        return;
      }
    }
  }
}
