/** API routes for AI settings, recipes, enrichment runs, suggestions and the event stream. */
import type { AiSettings, CampaignEvent, IntroOptions, ProviderId, RecipeDraft, RunKind, SuggestionStatus } from "../shared/ai";
import { PROVIDER_IDS, PROVIDERS } from "../shared/ai";
import { AiError, generateStructured, providerStatus } from "./ai";
import { getAiSettings, updateAiSettings } from "./ai/settings";
import { installStream, openSignInPage, signInStream, signOut } from "./ai/setup";
import * as db from "./db";
import { eventStream, publishRecipes } from "./enrich/hub";
import { outreachRequest, unknownPlaceholders } from "./enrich/outreach";
import { createRecipe, resolveOutputs, type OutputInput } from "./enrich/recipes";
import { liveRuns, liveRunsOn, pauseRun, recentRuns, resumeRun, startRun, stopRun } from "./enrich/runner";
import * as store from "./enrich/store";
import { liveDiscovery, liveDiscoveryOn } from "./sourcing/runner";

type Json = (data: unknown, status?: number) => Response;
type On = (method: string, pattern: string, h: (req: Request, params: string[]) => Promise<Response> | Response) => void;
type Body = <T>(req: Request) => Promise<T>;
type Fail = (status: number, message: string) => never;

export function registerAiRoutes(on: On, { json, body, fail }: { json: Json; body: Body; fail: Fail }) {
  const mustCampaign = (id: string) => db.getCampaign(id) ?? fail(404, "Campaign not found.");

  on("GET", "/api/ai/status", async (req) => {
    const fresh = new URL(req.url).searchParams.has("fresh");
    const providers = await Promise.all(PROVIDER_IDS.map((id) => providerStatus(id, fresh)));
    return json({ settings: getAiSettings(), providers });
  });
  on("PATCH", "/api/ai/settings", async (req) => json(updateAiSettings(await body<Partial<AiSettings>>(req))));
  const providerOf = (b: { provider?: unknown }) => (PROVIDER_IDS.includes(b.provider as ProviderId) ? (b.provider as ProviderId) : fail(400, "Unknown provider."));
  // Install and sign-in answer with an event stream; closing it cancels them.
  on("POST", "/api/ai/install", async (req) => installStream(providerOf(await body<{ provider?: unknown }>(req)), req.signal));
  on("POST", "/api/ai/signin", async (req) => signInStream(providerOf(await body<{ provider?: unknown }>(req)), req.signal));
  on("POST", "/api/ai/signin/open", async (req) => json({ ok: openSignInPage(providerOf(await body<{ provider?: unknown }>(req))) }));
  on("POST", "/api/ai/signout", async (req) => {
    const provider = providerOf(await body<{ provider?: unknown }>(req));
    // The sign-in is one per machine: removing it mid-run fails every turn left.
    const live = liveRunsOn(provider) + liveDiscoveryOn(provider);
    if (live) fail(409, `${live === 1 ? "A run is" : `${live} runs are`} still using ${PROVIDERS[provider].label}. Stop ${live === 1 ? "it" : "them"} first, then sign out.`);
    return json(await signOut(provider));
  });

  // ----- recipes -----
  on("GET", "/api/campaigns/:id/recipes", (_req, [id]) => json(store.listRecipes(id!)));
  on("POST", "/api/campaigns/:id/recipes", async (req, [id]) => {
    mustCampaign(id!);
    const b = await body<RecipeDraft>(req);
    try {
      return json(createRecipe(id!, b));
    } catch (err) {
      return fail(400, (err as Error).message);
    }
  });
  on("PATCH", "/api/recipes/:id", async (req, [rid]) => {
    const cur = store.getRecipe(rid!) ?? fail(404, "Recipe not found.");
    const b = await body<{ name?: string; instructions?: string; inputKeys?: string[]; outputs?: OutputInput[]; webSearch?: boolean }>(req);
    const outputs = b.outputs ? resolveOutputs(cur.campaignId, b.outputs, cur.id) : cur.outputs;
    const recipe = store.saveRecipe({ ...cur, ...b, name: b.name?.trim() || cur.name, instructions: b.instructions?.trim() || cur.instructions, outputs });
    publishRecipes(cur.campaignId);
    return json({ recipe, campaign: db.getCampaign(cur.campaignId) });
  });
  on("DELETE", "/api/recipes/:id", (_req, [rid]) => {
    const cur = store.getRecipe(rid!);
    store.deleteRecipe(rid!);
    if (cur) publishRecipes(cur.campaignId);
    return json({ ok: true });
  });

  // ----- runs -----
  on("GET", "/api/campaigns/:id/runs", (_req, [id]) => json(recentRuns(id!)));
  on("GET", "/api/campaigns/:id/runs/finished", (_req, [id]) => json(store.finishedRows(id!)));
  on("POST", "/api/campaigns/:id/runs", async (req, [id]) => {
    mustCampaign(id!);
    const b = await body<{ kind: RunKind; recipeId?: string; rowIds: string[]; test?: boolean; autoFill?: boolean; concurrency?: number; intro?: IntroOptions }>(req);
    const settings = getAiSettings();
    if (!settings.consented) fail(403, "Confirm that Mudd may send these rows to your AI provider first.");
    try {
      return json(startRun({ campaignId: id!, kind: b.kind === "intro" ? "intro" : "enrich", recipeId: b.recipeId ?? null, rowIds: b.rowIds ?? [], test: !!b.test, autoFill: !!b.autoFill, concurrency: b.concurrency ?? 2, intro: b.intro }));
    } catch (err) {
      return fail(400, (err as Error).message);
    }
  });
  on("POST", "/api/runs/:id/pause", (_req, [rid]) => json(pauseRun(rid!)));
  on("POST", "/api/runs/:id/resume", (_req, [rid]) => json(resumeRun(rid!)));
  on("POST", "/api/runs/:id/stop", (_req, [rid]) => json(stopRun(rid!)));

  // ----- templates -----
  // Draft an intro template from the user's words about the problem (one turn, no web). Not saved:
  // the page shows it first, and Keep creates it through the ordinary templates route.
  on("POST", "/api/campaigns/:id/templates/generate", async (req, [id]) => {
    const campaign = mustCampaign(id!);
    const b = await body<{ problem?: unknown }>(req);
    const problem = typeof b.problem === "string" ? b.problem.trim() : "";
    if (!problem) fail(400, "Say what problem you're working on first.");
    if (!getAiSettings().consented) fail(403, "Confirm that Mudd may send these rows to your AI provider first.");
    const r = outreachRequest({ problem, thesis: db.getThesis(id!), schema: campaign.schema, existing: db.listTemplates(id!) });
    try {
      const { data } = await generateStructured({ ...r, webSearch: false, signal: req.signal });
      return json({ name: data.name, body: data.body, unknown: unknownPlaceholders(data.body, campaign.schema) });
    } catch (err) {
      return fail(err instanceof AiError ? 502 : 500, (err as Error).message);
    }
  });

  // ----- suggestions -----
  on("GET", "/api/campaigns/:id/suggestions", (req, [id]) => {
    store.pruneOrphanSuggestions(id!);
    const status = new URL(req.url).searchParams.get("status") as SuggestionStatus | null;
    return json(store.listSuggestions(id!, status ?? undefined));
  });
  on("PATCH", "/api/campaigns/:id/suggestions", async (req, [id]) => {
    const b = await body<{ ids: string[]; status: SuggestionStatus }>(req);
    if (!["accepted", "rejected", "pending"].includes(b.status)) fail(400, "Unknown status.");
    return json(store.setSuggestionStatus(id!, b.ids ?? [], b.status));
  });

  on("GET", "/api/campaigns/:id/events", (_req, [id]) => {
    mustCampaign(id!);
    // Live runs first, whole: the row updates that follow apply to them.
    return eventStream(id!, () => [
      ...liveRuns(id!).map((run): CampaignEvent => ({ type: "run", run })),
      ...liveDiscovery(id!).map((run): CampaignEvent => ({ type: "discovery", run })),
    ]);
  });
}
