/** Typed calls to the local API. Every request is same-origin; the page itself never goes online. */
import type { AiSettings, EnrichRun, IntroOptions, ProviderId, ProviderStatus, Recipe, RecipeDraft, RunKind, SetupEvent, Suggestion, SuggestionStatus } from "../../shared/ai";
import type { Candidate, DiscoveryKind, DiscoveryRun, EnrichChoice } from "../../shared/sourcing";
import type {
  Campaign, CampaignBundle, CampaignSchema, CampaignSummary, CellEdit, InspectResult, Meeting, ReleaseNotes, Row, Template, Thesis, ThesisId, UpdateInfo,
} from "../../shared/types";

export type { RecipeDraft };

/** How a new campaign starts: the generic layout, another campaign's columns, or Discovery with its first two answers. */
export type NewCampaignLayout = "generic" | "discovery" | { copyFrom: string };

export interface StartDiscoveryBody {
  kind: DiscoveryKind;
  target?: number;
  perCompany?: number;
  focus?: string | null;
  enrich?: EnrichChoice;
  concurrency?: number;
  candidateIds?: string[];
}

export interface AcceptCandidatesResult {
  campaign: Campaign;
  rows: Row[];
  candidates: Candidate[];
}

export interface GeneratedTemplate {
  name: string;
  body: string;
  unknown: string[];
}

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

/**
 * POST, then read the answer as setup events: a stream while the work runs, or one JSON event
 * when the server answered at once (not installed yet). Frames split on the
 * blank line, with one decoder for the whole stream, so a chunk boundary never splits an event.
 */
async function* setupStream(url: string, body: unknown, signal: AbortSignal): AsyncGenerator<SetupEvent> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  if (!res.body || !res.headers.get("content-type")?.includes("text/event-stream")) {
    // One event, or the server's `{ error }` for a refused request.
    const j = (await res.json().catch(() => null)) as { type?: string; error?: string } | null;
    yield j?.type ? (j as SetupEvent) : { type: "done", ok: false, message: j?.error ?? `Request failed (${res.status})` };
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop() ?? "";
      for (const frame of frames) {
        const line = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        try {
          yield JSON.parse(line.slice(5).trim()) as SetupEvent;
        } catch {
          /* an unreadable frame is dropped */
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

export type DialogResult = { path: string } | { cancelled: true } | { unsupported: true };

export interface SaveResult {
  /** Where the file was written. */
  path: string;
  /** The campaign is (now) linked to `path`: the next Save file writes there again. */
  linked: boolean;
}

export const api = {
  env: () => call<{ platform: string; dialogs: boolean; dataDir: string }>("GET", "/api/env"),

  campaigns: () => call<CampaignSummary[]>("GET", "/api/campaigns"),
  createCampaign: (name: string, layout: NewCampaignLayout, thesis?: { offer: string; avatar: string }) =>
    call<Campaign>("POST", "/api/campaigns", { name, layout, ...(thesis ? { thesis } : {}) }),
  campaign: (id: string) => call<CampaignBundle>("GET", `/api/campaigns/${id}`),
  updateCampaign: (id: string, patch: { name?: string; schema?: CampaignSchema }) =>
    call<Campaign>("PATCH", `/api/campaigns/${id}`, patch),
  deleteCampaign: (id: string) => call<{ ok: true }>("DELETE", `/api/campaigns/${id}`),

  insertRows: (id: string, rows: Partial<Row>[]) =>
    call<Row[]>("POST", `/api/campaigns/${id}/rows`, { rows }),
  editRows: (id: string, edits: CellEdit[]) => call<{ updatedAt: number }>("PATCH", `/api/campaigns/${id}/rows`, { edits }),
  deleteRows: (id: string, ids: string[]) => call<{ ok: true }>("DELETE", `/api/campaigns/${id}/rows`, { ids }),

  createTemplate: (id: string, name: string, body: string) =>
    call<Template>("POST", `/api/campaigns/${id}/templates`, { name, body }),
  updateTemplate: (tid: string, patch: { name?: string; body?: string }) => call<Template>("PATCH", `/api/templates/${tid}`, patch),
  deleteTemplate: (tid: string) => call<{ ok: true }>("DELETE", `/api/templates/${tid}`),
  /** An AI-drafted template, not yet saved; `unknown` names placeholders that match no column. */
  generateTemplate: (id: string, problem: string) =>
    call<GeneratedTemplate>("POST", `/api/campaigns/${id}/templates/generate`, { problem }),

  inspectFile: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return call<InspectResult>("POST", "/api/import/inspect", fd);
  },
  inspectPath: (path: string) => call<InspectResult>("POST", "/api/import/inspect", { path }),
  /**
   * `skippedContacts`: Contacts-tab rows whose prospect isn't in the imported tab.
   * `mismatchedContacts`: ones linked by Prospect ID whose Company names another company.
   */
  importFile: (token: string, prospects: string, name?: string) =>
    call<Campaign & { skippedContacts?: number; mismatchedContacts?: number }>("POST", "/api/import", { token, prospects, name }),

  /**
   * Save file: write the campaign over the file it was imported from, or, when Mudd does not know
   * where that is, into Downloads (and keep saving there). `copy` always writes a new file in
   * Downloads and leaves the link alone; `force` replaces a file that changed outside Mudd.
   */
  saveFile: (id: string, opts: { force?: boolean; copy?: boolean } = {}) =>
    call<SaveResult>("POST", `/api/campaigns/${id}/save`, opts),
  /** Show the campaign's linked file in its folder. */
  revealFile: (id: string) => call<{ ok: true }>("POST", `/api/campaigns/${id}/reveal`),

  openDialog: () => call<DialogResult>("POST", "/api/dialog/open"),
  openUrl: (url: string) => call<{ ok: true }>("POST", "/api/open-url", { url }),
  meetings: () => call<Meeting[]>("GET", "/api/meetings"),

  /** The server asks GitHub for the latest release. */
  update: () => call<UpdateInfo>("GET", "/api/update"),
  installUpdate: () => call<{ version: string }>("POST", "/api/update/install"),
  /** What changed in the running version, read from its GitHub release by the server. */
  releaseNotes: () => call<ReleaseNotes>("GET", "/api/update/notes"),

  // ----- AI -----
  aiStatus: (fresh = false) => call<{ settings: AiSettings; providers: ProviderStatus[] }>("GET", `/api/ai/status${fresh ? "?fresh=1" : ""}`),
  aiSettings: (patch: Partial<AiSettings>) => call<AiSettings>("PATCH", "/api/ai/settings", patch),
  /** Download the provider's CLI into Mudd's folder. Abort `signal` to cancel. */
  aiInstall: (provider: ProviderId, signal: AbortSignal) => setupStream("/api/ai/install", { provider }, signal),
  /** Sign in through the browser, to the end. */
  aiSignIn: (provider: ProviderId, signal: AbortSignal) => setupStream("/api/ai/signin", { provider }, signal),
  aiSignInOpen: (provider: ProviderId) => call<{ ok: boolean }>("POST", "/api/ai/signin/open", { provider }),
  aiSignOut: (provider: ProviderId) => call<{ ok: boolean; message: string }>("POST", "/api/ai/signout", { provider }),

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

  // ----- Discovery -----
  /** Change some answers (a blank clears one); `keep` makes AI drafts the user's without changing them. */
  updateThesis: (id: string, patch: { answers?: Partial<Record<ThesisId, string | null>>; keep?: ThesisId[] }) =>
    call<Thesis>("PUT", `/api/campaigns/${id}/thesis`, patch),
  discovery: (id: string) => call<{ runs: DiscoveryRun[]; candidates: Candidate[] }>("GET", `/api/campaigns/${id}/discovery`),
  startDiscovery: (id: string, body: StartDiscoveryBody) => call<DiscoveryRun>("POST", `/api/campaigns/${id}/discovery/runs`, body),
  discoveryAction: (rid: string, action: "pause" | "resume" | "stop") => call<DiscoveryRun>("POST", `/api/discovery/${rid}/${action}`),
  acceptCandidates: (id: string, picks: { id: string; contactIds: string[] }[]) =>
    call<AcceptCandidatesResult>("POST", `/api/campaigns/${id}/candidates/accept`, { picks }),
  dismissCandidates: (id: string, ids: string[], reason: string | null) =>
    call<Candidate[]>("POST", `/api/campaigns/${id}/candidates/dismiss`, { ids, reason }),
  restoreCandidates: (id: string, ids: string[]) => call<Candidate[]>("POST", `/api/campaigns/${id}/candidates/restore`, { ids }),
};
