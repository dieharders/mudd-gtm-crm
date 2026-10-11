/** API routes for Discovery: the thesis, runs, and the inbox's candidates. */
import type { EnrichChoice } from "../../shared/sourcing";
import type { ThesisId } from "../../shared/types";
import { getAiSettings } from "../ai/settings";
import * as db from "../db";
import { acceptCandidates, dismissCandidates, restoreCandidates, type AcceptPick } from "./accept";
import { pauseDiscovery, recentDiscovery, resumeDiscovery, startDiscovery, stopDiscovery, type StartDiscoveryInput } from "./runner";
import * as store from "./store";

type Json = (data: unknown, status?: number) => Response;
type On = (method: string, pattern: string, h: (req: Request, params: string[]) => Promise<Response> | Response) => void;
type Body = <T>(req: Request) => Promise<T>;
type Fail = (status: number, message: string) => never;

export function registerDiscoveryRoutes(on: On, { json, body, fail }: { json: Json; body: Body; fail: Fail }) {
  const mustCampaign = (id: string) => db.getCampaign(id) ?? fail(404, "Campaign not found.");
  const mustThesis = (id: string) => {
    mustCampaign(id);
    return db.getThesis(id) ?? fail(404, "This campaign has no ICP thesis: Discovery is for campaigns created with it.");
  };

  // The thesis itself comes with the campaign bundle (GET /api/campaigns/:id).
  on("PUT", "/api/campaigns/:id/thesis", async (req, [id]) => {
    const cur = mustThesis(id!);
    const b = await body<{ answers?: Partial<Record<string, string | null>>; keep?: ThesisId[] }>(req);
    const patch: Partial<Record<string, string | null>> = { ...(b.answers ?? {}) };
    // Keeping a draft: the answer stays as it is, and is the user's now.
    for (const k of b.keep ?? []) if (!(k in patch)) patch[k] = cur.answers[k] ?? null;
    return json(db.patchThesis(id!, patch));
  });

  on("GET", "/api/campaigns/:id/discovery", (_req, [id]) => {
    mustCampaign(id!);
    return json({ runs: recentDiscovery(id!), candidates: store.listCandidates(id!) });
  });

  on("POST", "/api/campaigns/:id/discovery/runs", async (req, [id]) => {
    mustThesis(id!);
    const b = await body<Omit<StartDiscoveryInput, "campaignId"> & { enrich?: EnrichChoice }>(req);
    if (!getAiSettings().consented) fail(403, "Confirm that Mudd may send your thesis to your AI provider first.");
    try {
      return json(startDiscovery({ ...b, campaignId: id!, kind: b.kind === "thesis" || b.kind === "map" ? b.kind : "find" }));
    } catch (err) {
      return fail(400, (err as Error).message);
    }
  });
  on("POST", "/api/discovery/:id/pause", (_req, [rid]) => json(pauseDiscovery(rid!)));
  on("POST", "/api/discovery/:id/resume", (_req, [rid]) => json(resumeDiscovery(rid!)));
  on("POST", "/api/discovery/:id/stop", (_req, [rid]) => json(stopDiscovery(rid!)));

  on("POST", "/api/campaigns/:id/candidates/accept", async (req, [id]) => {
    mustThesis(id!);
    const b = await body<{ picks: AcceptPick[] }>(req);
    const picks = (b.picks ?? []).filter((p) => p && typeof p.id === "string").map((p) => ({ id: p.id, contactIds: Array.isArray(p.contactIds) ? p.contactIds : [] }));
    if (!picks.length) fail(400, "Nothing to accept.");
    return json(acceptCandidates(id!, picks));
  });
  on("POST", "/api/campaigns/:id/candidates/dismiss", async (req, [id]) => {
    mustCampaign(id!);
    const b = await body<{ ids: string[]; reason?: string | null }>(req);
    return json(dismissCandidates(id!, b.ids ?? [], b.reason ?? null));
  });
  on("POST", "/api/campaigns/:id/candidates/restore", async (req, [id]) => {
    mustCampaign(id!);
    const b = await body<{ ids: string[] }>(req);
    return json(restoreCandidates(id!, b.ids ?? []));
  });
}
