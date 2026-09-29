/** API routes for AI settings, recipes, enrichment runs, suggestions and the event stream. */
import type { AiSettings, CampaignEvent, IntroOptions, ProviderId, RecipeOutput, RunKind, SuggestionStatus } from "../shared/ai";
import { PROVIDER_IDS } from "../shared/ai";
import { allColumns, columnOf, makeKey, typeFromHeader } from "../shared/schema";
import type { CampaignSchema, ColumnType } from "../shared/types";
import { openSignIn, providerStatus } from "./ai";
import { getAiSettings, updateAiSettings } from "./ai/settings";
import * as db from "./db";
import { eventStream } from "./enrich/hub";
import { ensureSourcesColumn, liveRuns, pauseRun, recentRuns, resumeRun, startRun, stopRun } from "./enrich/runner";
import * as store from "./enrich/store";

type Json = (data: unknown, status?: number) => Response;
type On = (method: string, pattern: string, h: (req: Request, params: string[]) => Promise<Response> | Response) => void;
type Body = <T>(req: Request) => Promise<T>;
type Fail = (status: number, message: string) => never;

/** A new column's type: what import makes of the same header, else long text for a long hint. */
function guessType(header: string, hint = ""): ColumnType {
  return typeFromHeader(header)?.type ?? (hint.length > 80 ? "longtext" : "text");
}

type OutputInput = Partial<RecipeOutput> & { header: string; type?: ColumnType; options?: string[]; contact?: boolean };

/**
 * Point each recipe output at a column, creating the ones that don't exist yet: among the
 * contact columns for a person's detail (`contact`), else the prospect's. New columns are
 * appended (never inserted), so they land after the sheet's last column on export.
 */
function resolveOutputs(campaignId: string, outputs: OutputInput[], recipeId: string) {
  const c = db.getCampaign(campaignId)!;
  const contacts = c.schema.contacts ? { ...c.schema.contacts, columns: [...c.schema.contacts.columns] } : undefined;
  const schema: CampaignSchema = { ...c.schema, columns: [...c.schema.columns], contacts };
  const before = allColumns(c.schema).length;
  // Keys in use, and keys a deleted column left values under: a new column must not show a
  // deleted one's data. Read only once a column is actually added.
  let taken: Set<string> | null = null;
  const newKey = (header: string) => makeKey(header, (taken ??= new Set([...allColumns(schema).map((col) => col.key), ...db.allCellKeys(campaignId)])));
  const resolved: RecipeOutput[] = [];
  for (const o of outputs) {
    const header = o.header.trim();
    if (!header) continue;
    const pool = o.contact && contacts ? contacts.columns : schema.columns;
    let col = o.key ? columnOf(schema, o.key) : undefined;
    col ??= pool.find((x) => x.header.toLowerCase() === header.toLowerCase());
    // The ID is Mudd's own: nothing is researched into it.
    if (col && col.key === schema.idKey) continue;
    if (!col) {
      col = { key: newKey(header), header, type: o.type ?? guessType(header, o.hint), origin: "enrichment", recipeId, width: 220, ...(o.options?.length ? { options: o.options } : {}) };
      pool.push(col);
    }
    if (!resolved.some((r) => r.key === col!.key)) resolved.push({ key: col.key, header: col.header, hint: o.hint?.trim() || undefined });
  }
  if (allColumns(schema).length !== before) db.updateCampaign(campaignId, { schema });
  return resolved;
}

export function registerAiRoutes(on: On, { json, body, fail }: { json: Json; body: Body; fail: Fail }) {
  const mustCampaign = (id: string) => db.getCampaign(id) ?? fail(404, "Campaign not found.");

  on("GET", "/api/ai/status", async (req) => {
    const fresh = new URL(req.url).searchParams.has("fresh");
    const providers = await Promise.all(PROVIDER_IDS.map((id) => providerStatus(id, fresh)));
    return json({ settings: getAiSettings(), providers });
  });
  on("PATCH", "/api/ai/settings", async (req) => json(updateAiSettings(await body<Partial<AiSettings>>(req))));
  on("POST", "/api/ai/signin", async (req) => {
    const { provider } = await body<{ provider: ProviderId }>(req);
    if (!PROVIDER_IDS.includes(provider)) fail(400, "Unknown provider.");
    return json(await openSignIn(provider));
  });

  // ----- recipes -----
  on("GET", "/api/campaigns/:id/recipes", (_req, [id]) => json(store.listRecipes(id!)));
  on("POST", "/api/campaigns/:id/recipes", async (req, [id]) => {
    mustCampaign(id!);
    const b = await body<{ name: string; instructions: string; inputKeys: string[]; outputs: OutputInput[]; webSearch: boolean }>(req);
    if (!b.instructions?.trim()) fail(400, "Describe what to find.");
    const recipeId = db.newId();
    const outputs = resolveOutputs(id!, b.outputs ?? [], recipeId);
    if (!outputs.length) fail(400, "Add at least one output column.");
    ensureSourcesColumn(id!);
    const recipe = store.saveRecipe({ id: recipeId, campaignId: id!, name: b.name?.trim() || "Untitled recipe", instructions: b.instructions.trim(), inputKeys: b.inputKeys ?? [], outputs, webSearch: b.webSearch !== false });
    return json({ recipe, campaign: db.getCampaign(id!) });
  });
  on("PATCH", "/api/recipes/:id", async (req, [rid]) => {
    const cur = store.getRecipe(rid!) ?? fail(404, "Recipe not found.");
    const b = await body<{ name?: string; instructions?: string; inputKeys?: string[]; outputs?: OutputInput[]; webSearch?: boolean }>(req);
    const outputs = b.outputs ? resolveOutputs(cur.campaignId, b.outputs, cur.id) : cur.outputs;
    const recipe = store.saveRecipe({ ...cur, ...b, name: b.name?.trim() || cur.name, instructions: b.instructions?.trim() || cur.instructions, outputs });
    return json({ recipe, campaign: db.getCampaign(cur.campaignId) });
  });
  on("DELETE", "/api/recipes/:id", (_req, [rid]) => {
    store.deleteRecipe(rid!);
    return json({ ok: true });
  });

  // ----- runs -----
  on("GET", "/api/campaigns/:id/runs", (_req, [id]) => json(recentRuns(id!)));
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
    return eventStream(id!, () => liveRuns(id!).map((run): CampaignEvent => ({ type: "run", run })));
  });
}
