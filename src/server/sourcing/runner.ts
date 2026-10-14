/**
 * The Discovery engine: from a campaign's ICP thesis to candidate companies with their buying
 * committees, waiting in the inbox.
 *
 * A Find run goes in stages. Thesis: draft the blank answers (only the blank ones; the user's
 * stand). Plan: a few search angles. Then a job queue worked by `concurrency` workers: one
 * angle job per angle (a web turn that names companies), and one map job per company found (a
 * web turn that names its people). Map jobs go first, so inbox cards appear early; angle jobs
 * stop once the target is reached. A company already in the campaign, already suggested (even
 * dismissed), already found by another angle this run, or found with no source page is dropped.
 *
 * As in enrich/runner.ts, the live run is the truth; its stored copy is rewritten on status
 * changes and every few seconds while it changes. The run is small (angles and per-company
 * steps), so it goes to the page whole, at most one every 400 ms.
 */
import type { ProviderId } from "../../shared/ai";
import type { Candidate, CandidateContact, DiscoveryKind, DiscoveryRun, EnrichChoice, SearchAngle } from "../../shared/sourcing";
import { websiteColumn } from "../../shared/schema";
import { DEAL_ROLES, DEFAULT_ENRICH, FIT_OPTIONS, PER_COMPANY_RANGE, TARGET_RANGE } from "../../shared/sourcing";
import { canFind, THESIS_IDS } from "../../shared/thesis";
import { isScreened, STAGES, type Thesis, type ThesisId } from "../../shared/types";
import { CompanyIndex, hrefFor } from "../../shared/values";
import { generateStructured } from "../ai";
import { getAiSettings } from "../ai/settings";
import * as db from "../db";
import { publish } from "../enrich/hub";
import { Gate, retryTurn } from "../jobs";
import { draftRequest, examples, findRequest, mapRequest, planRequest, type Examples } from "./prompts";
import * as store from "./store";

type Job = { kind: "angle"; angle: SearchAngle } | { kind: "map"; candidateId: string };

interface Controller {
  run: DiscoveryRun;
  abort: AbortController;
  /** Where the workers wait while paused. */
  gate: Gate;
  /** Where idle workers wait for an angle to produce map jobs. */
  work: Gate;
  done: Promise<void>;
  savedAt: number;
  saveTimer: ReturnType<typeof setTimeout> | null;
  /** When the run last went to the page, and the send waiting to follow a throttled one. */
  sentAt: number;
  sendTimer: ReturnType<typeof setTimeout> | null;
  /** Every company already known, for de-duplication: prospects, every candidate, this run's finds. */
  index: CompanyIndex<string>;
  queue: Job[];
  busy: number;
  thesis: Thesis;
  examples: Examples;
}

const active = new Map<string, Controller>();
const SEND_EVERY = 400;
const SAVE_EVERY = 2_000;

export const NOT_DISCOVERY = "Discovery is for campaigns created with it.";
export const THESIS_TOO_THIN = 'Answer "What do you sell?" and "Who qualifies?" first: Discovery can\'t search without them.';
export const FIND_RUNNING = "Discovery is already searching this campaign. Wait for it to finish, or stop it first.";

// ---------- storing and sending ----------

function save(ctrl: Controller): void {
  if (ctrl.saveTimer) clearTimeout(ctrl.saveTimer);
  ctrl.saveTimer = null;
  ctrl.savedAt = Date.now();
  store.saveDiscoveryRun(ctrl.run);
}

function saveSoon(ctrl: Controller): void {
  if (ctrl.saveTimer) return;
  const wait = ctrl.savedAt + SAVE_EVERY - Date.now();
  if (wait <= 0) return save(ctrl);
  ctrl.saveTimer = setTimeout(() => {
    try {
      save(ctrl);
    } catch (err) {
      console.error("[discovery] could not save run progress:", err);
    }
  }, wait);
}

/** The run to the page now; a status change always, a step only once per SEND_EVERY (the last one follows). */
function emit(ctrl: Controller, force = false): void {
  const wait = ctrl.sentAt + SEND_EVERY - Date.now();
  if (!force && wait > 0) {
    if (!ctrl.sendTimer) ctrl.sendTimer = setTimeout(() => emit(ctrl, true), wait);
    return;
  }
  if (ctrl.sendTimer) clearTimeout(ctrl.sendTimer);
  ctrl.sendTimer = null;
  ctrl.sentAt = Date.now();
  publish(ctrl.run.campaignId, { type: "discovery", run: ctrl.run });
  saveSoon(ctrl);
}

/** The whole run, stored now and sent: on start, on a status change, at the end. */
function emitRun(ctrl: Controller): void {
  save(ctrl);
  emit(ctrl, true);
}

function emitCandidates(ctrl: Controller, list: Candidate[]): void {
  if (!list.length) return;
  for (const c of list) c.updatedAt = Date.now();
  store.saveCandidates(list);
  publish(ctrl.run.campaignId, { type: "candidates", candidates: list });
}

// ---------- the live runs ----------

export function recentDiscovery(campaignId: string): DiscoveryRun[] {
  return store.listDiscoveryRuns(campaignId).map((r) => active.get(r.id)?.run ?? r);
}

export function liveDiscovery(campaignId: string): DiscoveryRun[] {
  return [...active.values()].filter((c) => c.run.campaignId === campaignId).map((c) => c.run);
}

export function liveDiscoveryOn(provider: ProviderId): number {
  return [...active.values()].filter((c) => c.run.provider === provider).length;
}

export function pauseDiscovery(id: string): DiscoveryRun | null {
  const c = active.get(id);
  if (!c || c.run.status !== "running") return c?.run ?? store.getDiscoveryRun(id);
  c.run.status = "paused";
  emitRun(c);
  return c.run;
}

export function resumeDiscovery(id: string): DiscoveryRun | null {
  const c = active.get(id);
  if (!c || c.run.status !== "paused") return c?.run ?? store.getDiscoveryRun(id);
  c.run.status = "running";
  emitRun(c);
  c.gate.open();
  return c.run;
}

export function stopDiscovery(id: string): DiscoveryRun | null {
  const c = active.get(id);
  if (!c) return store.getDiscoveryRun(id);
  c.run.status = "stopping";
  emitRun(c);
  c.abort.abort();
  c.gate.open();
  c.work.open();
  return c.run;
}

export function stopCampaignDiscovery(campaignId: string): void {
  for (const c of active.values()) if (c.run.campaignId === campaignId) stopDiscovery(c.run.id);
}

export function stopAllDiscovery(): void {
  for (const id of active.keys()) stopDiscovery(id);
}

/** Resolves once the run has ended (at once for a run that isn't live). */
export function discoveryDone(id: string): Promise<void> {
  return active.get(id)?.done ?? Promise.resolve();
}

// ---------- starting ----------

export interface StartDiscoveryInput {
  campaignId: string;
  kind: DiscoveryKind;
  target?: number;
  perCompany?: number;
  focus?: string | null;
  enrich?: EnrichChoice;
  concurrency?: number;
  /** For a `map` run: the candidates to map (again). */
  candidateIds?: string[];
}

export function startDiscovery(input: StartDiscoveryInput): DiscoveryRun {
  const settings = getAiSettings();
  const provider = settings.provider;
  if (!provider) throw new Error("No AI provider chosen. Open AI settings to pick one.");
  const campaign = db.getCampaign(input.campaignId);
  if (!campaign) throw new Error("Campaign not found.");
  const thesis = db.getThesis(input.campaignId);
  if (!thesis) throw new Error(NOT_DISCOVERY);
  if (input.kind === "find" && !canFind(thesis)) throw new Error(THESIS_TOO_THIN);
  // One Find at a time per campaign: each run de-duplicates against what was known when it
  // started, so two at once would both suggest the same companies.
  if (input.kind === "find" && liveDiscovery(input.campaignId).some((r) => r.kind === "find")) throw new Error(FIND_RUNNING);
  const candidateIds = [...new Set(input.candidateIds ?? [])];
  if (input.kind === "map" && !candidateIds.length) throw new Error("Nothing to map.");
  const target = Math.max(TARGET_RANGE.min, Math.min(TARGET_RANGE.max, Math.round(input.target ?? 10) || 10));
  const perCompany = Math.max(PER_COMPANY_RANGE.min, Math.min(PER_COMPANY_RANGE.max, Math.round(input.perCompany ?? 5) || 5));
  const model = settings.model[provider] ?? "default";

  const run: DiscoveryRun = {
    id: db.newId(),
    campaignId: input.campaignId,
    kind: input.kind,
    status: "running",
    stage: input.kind === "map" ? "map" : "thesis",
    provider,
    model,
    concurrency: Math.max(1, Math.min(4, Math.round(input.concurrency ?? 2) || 2)),
    target,
    perCompany,
    focus: input.focus?.trim() || null,
    enrich: input.enrich ?? DEFAULT_ENRICH,
    drafted: [],
    angles: [],
    candidateIds: input.kind === "map" ? candidateIds : [],
    jobs: Object.fromEntries(input.kind === "map" ? candidateIds.map((id) => [id, { state: "pending" as const }]) : []),
    found: 0,
    ready: 0,
    disqualified: 0,
    failed: 0,
    costUsd: null,
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
  };

  // What is already known, so no company is suggested twice: the prospects, and every candidate
  // (dismissed ones included: the user said no once).
  const index = new CompanyIndex<string>();
  const { schema } = campaign;
  const prospects = db.listRows(input.campaignId);
  // The same column accept.ts reads, so what Find drops as a repeat, accept would have too.
  const website = websiteColumn(schema);
  for (const r of prospects) index.add(schema.companyKey ? r.cells[schema.companyKey] : null, website ? r.cells[website.key] : null, r.id);
  const candidates = store.listCandidates(input.campaignId);
  for (const c of candidates) index.add(c.company, c.website, c.id);
  const ex = examples({
    stages: STAGES,
    prospects: prospects.map((r) => ({
      company: String(schema.companyKey ? r.cells[schema.companyKey] ?? "" : ""),
      status: schema.statusKey ? (r.cells[schema.statusKey] as string | null) ?? null : null,
      screened: isScreened(r, schema),
      reason: schema.reasonKey ? (r.cells[schema.reasonKey] as string | null) ?? null : null,
    })),
    candidates,
  });

  const ctrl: Controller = {
    run, abort: new AbortController(), gate: new Gate(), work: new Gate(), done: Promise.resolve(),
    savedAt: 0, saveTimer: null, sentAt: 0, sendTimer: null, index, queue: [], busy: 0, thesis, examples: ex,
  };
  active.set(run.id, ctrl);
  emitRun(ctrl);
  ctrl.done = pump(ctrl);
  return run;
}

// ---------- the pump ----------

async function pump(ctrl: Controller): Promise<void> {
  const { run } = ctrl;
  try {
    if (run.kind === "thesis" || run.kind === "find") await stageThesis(ctrl);
    if (run.kind === "find" && !ended(ctrl)) await stagePlan(ctrl);
    if (run.kind === "map") ctrl.queue = run.candidateIds.map((candidateId) => ({ kind: "map", candidateId }));
    if ((run.kind === "find" || run.kind === "map") && !ended(ctrl)) {
      run.stage = run.kind === "map" ? "map" : "find";
      emitRun(ctrl);
      await Promise.all(Array.from({ length: run.concurrency }, () => worker(ctrl)));
    }
  } catch (err) {
    console.error("[discovery] run failed:", err);
    run.status = "failed";
    run.error ??= (err as Error).message;
  } finally {
    for (const a of run.angles) if (a.state === "pending" || a.state === "running") a.state = "skipped";
    const stuck: Candidate[] = [];
    for (const [id, job] of Object.entries(run.jobs)) {
      if (job.state !== "pending" && job.state !== "running") continue;
      job.state = "skipped";
      const c = store.getCandidate(run.campaignId, id);
      if (c?.status === "mapping") stuck.push({ ...c, status: "error", error: "Stopped before its buying committee was mapped. Map again to finish." });
    }
    emitCandidates(ctrl, stuck);
    if (run.status !== "failed") run.status = ctrl.abort.signal.aborted ? "stopped" : "done";
    run.stage = "done";
    run.finishedAt = Date.now();
    if (ctrl.sendTimer) clearTimeout(ctrl.sendTimer);
    active.delete(run.id);
    emitRun(ctrl);
  }
}

const ended = (ctrl: Controller) => ctrl.abort.signal.aborted || ctrl.run.status === "failed";

/** A turn's result, or why there is none: stopped, or the run failed for want of a CLI. */
async function turn<T>(ctrl: Controller, label: string, attempt: () => Promise<{ data: T; costUsd: number | null }>, onRetry?: (n: number, max: number) => void) {
  const { run } = ctrl;
  return retryTurn({
    attempt: async () => {
      const r = await attempt();
      if (r.costUsd !== null) run.costUsd = (run.costUsd ?? 0) + r.costUsd;
      return r.data;
    },
    signal: ctrl.abort.signal,
    label: `discovery ${label}`,
    onRetry,
    onFatal: (message) => {
      run.status = "failed";
      run.error = message;
      ctrl.abort.abort();
      ctrl.gate.open();
      ctrl.work.open();
      emitRun(ctrl);
    },
  });
}

/** A pause holds here until Resume; after a Stop, true. */
async function paused(ctrl: Controller): Promise<boolean> {
  while (ctrl.run.status === "paused") await ctrl.gate.wait();
  return ended(ctrl);
}

// ---------- stages ----------

/** Draft the blank answers. The user's own answers are never touched, nor ones typed meanwhile. */
async function stageThesis(ctrl: Controller): Promise<void> {
  const { run } = ctrl;
  run.stage = "thesis";
  emitRun(ctrl);
  const before = db.getThesis(run.campaignId);
  if (!before) return;
  const req = draftRequest(before);
  if (!req.blanks.length) return;
  const result = await turn(ctrl, "thesis", () => generateStructured({ ...req, webSearch: false, signal: ctrl.abort.signal, onStep: () => emit(ctrl) }));
  if ("stop" in result) return;
  if ("error" in result) {
    if (run.kind === "thesis") {
      run.status = "failed";
      run.error = result.error;
    }
    return;
  }
  // Only the questions still blank now: the user may have typed into one while the turn ran.
  const now = db.getThesis(run.campaignId);
  if (!now) return;
  const patch: Partial<Record<string, string>> = {};
  const drafted: ThesisId[] = [];
  const answers = result.ok.answers ?? {};
  for (const id of req.blanks) {
    const v = answers[id];
    if (!v?.trim() || now.answers[id]?.trim()) continue;
    patch[id] = v.trim();
    drafted.push(id);
  }
  if (!drafted.length) return;
  const thesis = db.patchThesis(run.campaignId, patch, drafted);
  if (!thesis) return;
  ctrl.thesis = thesis;
  run.drafted = THESIS_IDS.filter((id) => drafted.includes(id));
  publish(run.campaignId, { type: "thesis", thesis });
  emit(ctrl, true);
}

async function stagePlan(ctrl: Controller): Promise<void> {
  const { run } = ctrl;
  run.stage = "plan";
  emitRun(ctrl);
  const req = planRequest(ctrl.thesis, run.target, run.focus, ctrl.examples);
  const result = await turn(ctrl, "plan", () => generateStructured({ ...req, webSearch: false, signal: ctrl.abort.signal, onStep: () => emit(ctrl) }));
  if ("stop" in result) return;
  if ("error" in result) {
    run.status = "failed";
    run.error = `Could not plan the search: ${result.error}`;
    return;
  }
  run.angles = result.ok.angles.slice(0, req.count).map((a) => ({ id: db.newId(), label: a.label.trim(), query: a.query.trim(), state: "pending", found: 0 }));
  ctrl.queue = run.angles.map((angle) => ({ kind: "angle", angle }));
}

/** The next job: a company to map before a new angle, and no new angle once the target is met. */
function nextJob(ctrl: Controller): Job | undefined {
  const { queue, run } = ctrl;
  const map = queue.findIndex((j) => j.kind === "map");
  if (map >= 0) return queue.splice(map, 1)[0];
  while (queue.length) {
    const job = queue.shift()!;
    if (job.kind === "angle" && run.found >= run.target) {
      job.angle.state = "skipped";
      continue;
    }
    return job;
  }
  return undefined;
}

async function worker(ctrl: Controller): Promise<void> {
  for (;;) {
    if (await paused(ctrl)) return;
    const job = nextJob(ctrl);
    if (!job) {
      // Nothing to do now; an angle still running may add companies to map.
      if (ctrl.busy === 0) {
        ctrl.work.open();
        return;
      }
      await ctrl.work.wait();
      continue;
    }
    ctrl.busy++;
    try {
      if (job.kind === "angle") await doAngle(ctrl, job.angle);
      else await doMap(ctrl, job.candidateId);
    } finally {
      ctrl.busy--;
      ctrl.work.open();
    }
  }
}

const normaliseType = (t: string | null): string | null => (t ? DEAL_ROLES.find((r) => r.toLowerCase() === t.trim().toLowerCase()) ?? null : null);
const normaliseFit = (f: string | null): Candidate["fit"] => (f ? (FIT_OPTIONS.find((o) => o.toLowerCase() === f.trim().toLowerCase()) as Candidate["fit"] | undefined) ?? null : null);
const link = (v: string | null): string | null => (v ? hrefFor(v) || null : null);

async function doAngle(ctrl: Controller, angle: SearchAngle): Promise<void> {
  const { run } = ctrl;
  angle.state = "running";
  angle.step = "Starting";
  emit(ctrl, true);
  const want = Math.ceil((run.target - run.found) * 1.5);
  const req = findRequest(ctrl.thesis, angle, run.focus, ctrl.examples, want);
  const onStep = (label: string) => {
    angle.step = label;
    emit(ctrl);
  };
  const result = await turn(ctrl, `angle "${angle.label}"`, () => generateStructured({ ...req, webSearch: true, signal: ctrl.abort.signal, onStep }), (n, max) => onStep(`Retrying (${n}/${max})`));
  angle.step = undefined;
  if ("stop" in result) {
    angle.state = "skipped";
    emit(ctrl, true);
    return;
  }
  if ("error" in result) {
    angle.state = "error";
    angle.error = result.error;
    run.failed++;
    emit(ctrl, true);
    return;
  }
  const fresh: Candidate[] = [];
  for (const c of result.ok.companies) {
    if (run.found >= run.target) break;
    const company = c.company.trim();
    const source = link(c.source);
    // No page it was found on: nothing the user could check, so not a candidate.
    if (!company || !source) continue;
    const website = link(c.website);
    if (ctrl.index.has(company, website)) continue;
    const id = db.newId();
    ctrl.index.add(company, website, id);
    const now = Date.now();
    fresh.push({
      id, campaignId: run.campaignId, runId: run.id, status: "mapping",
      company, website, location: c.location?.trim() || null, employees: c.employees,
      fit: normaliseFit(c.fit), whyFit: c.whyFit?.trim() || null, whyNow: c.whyNow?.trim() || null, budget: c.budget?.trim() || null, clock: c.clock?.trim() || null,
      sources: [{ url: source, title: angle.label }], contacts: [], firstContact: null, angle: angle.label,
      error: null, dismissReason: null, rowId: null, createdAt: now, updatedAt: now,
    });
    run.found++;
    angle.found++;
    run.candidateIds.push(id);
    run.jobs[id] = { state: "pending" };
    ctrl.queue.push({ kind: "map", candidateId: id });
  }
  angle.state = "done";
  emitCandidates(ctrl, fresh);
  emit(ctrl, true);
  ctrl.work.open();
}

async function doMap(ctrl: Controller, candidateId: string): Promise<void> {
  const { run } = ctrl;
  const job = (run.jobs[candidateId] ??= { state: "pending" });
  const c = store.getCandidate(run.campaignId, candidateId);
  if (!c || c.status === "accepted" || c.status === "dismissed") {
    job.state = "skipped";
    job.error = c ? `Already ${c.status}.` : "No longer in the inbox.";
    emit(ctrl, true);
    return;
  }
  job.state = "running";
  job.step = "Starting";
  emit(ctrl, true);
  if (c.status !== "mapping") emitCandidates(ctrl, [{ ...c, status: "mapping", error: null }]);
  const req = mapRequest(ctrl.thesis, c, run.perCompany);
  const onStep = (label: string) => {
    job.step = label;
    emit(ctrl);
  };
  const result = await turn(ctrl, `map ${c.company}`, () => generateStructured({ ...req, webSearch: true, signal: ctrl.abort.signal, onStep }), (n, max) => onStep(`Retrying (${n}/${max})`));
  job.step = undefined;
  if ("stop" in result) {
    job.state = "skipped";
    emit(ctrl, true);
    return;
  }
  const latest = store.getCandidate(run.campaignId, candidateId) ?? c;
  // The user may have dismissed or accepted it while the turn ran: that decision stands.
  const settled = latest.status === "dismissed" || latest.status === "accepted";
  if ("error" in result) {
    job.state = "error";
    job.error = result.error;
    run.failed++;
    if (!settled) emitCandidates(ctrl, [{ ...latest, status: "error", error: result.error }]);
    emit(ctrl, true);
    return;
  }
  const data = result.ok;
  const contacts: CandidateContact[] = data.contacts
    .map((p) => ({
      id: db.newId(),
      name: p.name.trim(),
      title: p.title?.trim() || null,
      type: normaliseType(p.type),
      dealRole: p.dealRole?.trim() || null,
      gain: p.gain?.trim() || null,
      angle: p.angle?.trim() || null,
      linkedin: link(p.linkedin),
      source: link(p.source),
      confidence: p.confidence,
    }))
    // A person with no page they were found on is no one the user can check.
    .filter((p) => p.name && p.source)
    .slice(0, run.perCompany);
  const firstIdx = typeof data.firstContact === "number" ? data.firstContact : Number(data.firstContact);
  const first = Number.isInteger(firstIdx) && firstIdx >= 0 && firstIdx < data.contacts.length ? data.contacts[firstIdx]!.name.trim() : null;
  const sources = [...latest.sources];
  for (const url of data.company.sources) {
    const href = link(url);
    if (href && !sources.some((s) => s.url === href)) sources.push({ url: href });
  }
  for (const p of contacts) if (p.source && !sources.some((s) => s.url === p.source)) sources.push({ url: p.source, title: p.name });
  const disqualify = data.disqualify?.trim() || null;
  const next: Candidate = {
    ...latest,
    status: settled ? latest.status : disqualify ? "dismissed" : "ready",
    error: null,
    dismissReason: disqualify && !settled ? `Disqualified: ${disqualify}` : latest.dismissReason,
    contacts,
    firstContact: contacts.find((p) => p.name === first)?.id ?? null,
    fit: normaliseFit(data.company.fit) ?? latest.fit,
    whyNow: data.company.whyNow?.trim() || latest.whyNow,
    budget: data.company.budget?.trim() || latest.budget,
    clock: data.company.clock?.trim() || latest.clock,
    employees: data.company.employees ?? latest.employees,
    sources,
  };
  if (!settled) {
    if (disqualify) run.disqualified++;
    else run.ready++;
  }
  job.state = "done";
  emitCandidates(ctrl, [next]);
  emit(ctrl, true);
}
