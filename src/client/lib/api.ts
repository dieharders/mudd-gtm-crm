/** Typed calls to the local API. Every request is same-origin; nothing goes to the internet. */
import type { AiSettings, EnrichRun, IntroOptions, ProviderId, ProviderStatus, Recipe, RecipeOutput, RunKind, Suggestion, SuggestionStatus } from "../../shared/ai";
import type { ColumnType } from "../../shared/types";
import type {
  Bucket, Campaign, CampaignBundle, CampaignSchema, CampaignSummary, CellEdit, InspectResult, Meeting, Row, Template,
} from "../../shared/types";

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  const res = await fetch(url, init);
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    let code: string | undefined;
    try {
      const j = await res.json();
      msg = j.error ?? msg;
      code = j.code;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, msg, code);
  }
  return (await res.json()) as T;
}

export type DialogResult = { path: string } | { cancelled: true } | { unsupported: true };

export const api = {
  env: () => call<{ platform: string; dialogs: boolean; dataDir: string }>("GET", "/api/env"),

  campaigns: () => call<CampaignSummary[]>("GET", "/api/campaigns"),
  createCampaign: (name: string, layout: "generic" | { copyFrom: string }) =>
    call<Campaign>("POST", "/api/campaigns", { name, layout }),
  campaign: (id: string) => call<CampaignBundle>("GET", `/api/campaigns/${id}`),
  updateCampaign: (id: string, patch: { name?: string; schema?: CampaignSchema }) =>
    call<Campaign>("PATCH", `/api/campaigns/${id}`, patch),
  deleteCampaign: (id: string) => call<{ ok: true }>("DELETE", `/api/campaigns/${id}`),

  insertRows: (id: string, rows: (Partial<Row> & { bucket: Bucket })[]) =>
    call<Row[]>("POST", `/api/campaigns/${id}/rows`, { rows }),
  editRows: (id: string, edits: CellEdit[]) => call<{ updatedAt: number }>("PATCH", `/api/campaigns/${id}/rows`, { edits }),
  deleteRows: (id: string, ids: string[]) => call<{ ok: true }>("DELETE", `/api/campaigns/${id}/rows`, { ids }),
  moveRows: (id: string, ids: string[], bucket: Bucket, positions?: Record<string, number>) =>
    call<{ ok: true }>("POST", `/api/campaigns/${id}/rows/move`, { ids, bucket, positions }),

  createTemplate: (id: string, name: string, body: string) =>
    call<Template>("POST", `/api/campaigns/${id}/templates`, { name, body }),
  updateTemplate: (tid: string, patch: { name?: string; body?: string }) => call<Template>("PATCH", `/api/templates/${tid}`, patch),
  deleteTemplate: (tid: string) => call<{ ok: true }>("DELETE", `/api/templates/${tid}`),

  inspectFile: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return call<InspectResult>("POST", "/api/import/inspect", fd);
  },
  inspectPath: (path: string) => call<InspectResult>("POST", "/api/import/inspect", { path }),
  importFile: (token: string, prospects: string, screened: string | null, name?: string) =>
    call<Campaign>("POST", "/api/import", { token, prospects, screened, name }),

  exportTo: (id: string, target: "original" | "saveAs", force = false) =>
    call<{ path?: string; cancelled?: boolean; linked?: boolean }>("POST", `/api/campaigns/${id}/export`, { target, force }),
  exportDownload: async (id: string): Promise<{ blob: Blob; name: string }> => {
    const res = await fetch(`/api/campaigns/${id}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "download" }),
    });
    if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))).error ?? "Export failed");
    const disp = res.headers.get("content-disposition") ?? "";
    const name = /filename="([^"]+)"/.exec(disp)?.[1] ?? "campaign.xlsx";
    return { blob: await res.blob(), name };
  },

  openDialog: () => call<DialogResult>("POST", "/api/dialog/open"),
  openUrl: (url: string) => call<{ ok: true }>("POST", "/api/open-url", { url }),
  meetings: () => call<Meeting[]>("GET", "/api/meetings"),

  // ----- AI -----
  aiStatus: (fresh = false) => call<{ settings: AiSettings; providers: ProviderStatus[] }>("GET", `/api/ai/status${fresh ? "?fresh=1" : ""}`),
  aiSettings: (patch: Partial<AiSettings>) => call<AiSettings>("PATCH", "/api/ai/settings", patch),
  aiSignIn: (provider: ProviderId) => call<{ ok: boolean; message?: string }>("POST", "/api/ai/signin", { provider }),

  recipes: (id: string) => call<Recipe[]>("GET", `/api/campaigns/${id}/recipes`),
  createRecipe: (id: string, r: RecipeDraft) => call<{ recipe: Recipe; campaign: Campaign }>("POST", `/api/campaigns/${id}/recipes`, r),
  updateRecipe: (rid: string, r: Partial<RecipeDraft>) => call<{ recipe: Recipe; campaign: Campaign }>("PATCH", `/api/recipes/${rid}`, r),
  deleteRecipe: (rid: string) => call<{ ok: true }>("DELETE", `/api/recipes/${rid}`),

  runs: (id: string) => call<EnrichRun[]>("GET", `/api/campaigns/${id}/runs`),
  startRun: (id: string, body: { kind: RunKind; recipeId?: string; rowIds: string[]; test?: boolean; autoFill?: boolean; concurrency?: number; intro?: IntroOptions }) =>
    call<EnrichRun>("POST", `/api/campaigns/${id}/runs`, body),
  runAction: (rid: string, action: "pause" | "resume" | "stop") => call<EnrichRun>("POST", `/api/runs/${rid}/${action}`),

  suggestions: (id: string, status: SuggestionStatus = "pending") => call<Suggestion[]>("GET", `/api/campaigns/${id}/suggestions?status=${status}`),
  setSuggestions: (id: string, ids: string[], status: SuggestionStatus) => call<Suggestion[]>("PATCH", `/api/campaigns/${id}/suggestions`, { ids, status }),
};

export interface RecipeDraft {
  name: string;
  instructions: string;
  inputKeys: string[];
  outputs: (Partial<RecipeOutput> & { header: string; type?: ColumnType; options?: string[] })[];
  webSearch: boolean;
}
