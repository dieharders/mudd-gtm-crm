/**
 * The inbox's actions. Accepting a candidate makes it a prospect, with its ticked people as
 * contacts and its intel in the Discovery columns, then queues the run's chosen enrichment on
 * it. Dismissing keeps it: later runs never suggest it again, and its reason is a negative
 * example for them.
 */
import { mergeSources, sourcesColumn, type Source } from "../../shared/ai";
import { norm } from "../../shared/merge";
import { allColumns, DISCOVERY_FIELDS, discoveryColumn, EMPLOYEES_HEADER, FIT_OPTIONS, isEmployeesHeader, makeKey, prospectIds, ROLE_HEADERS } from "../../shared/schema";
import { DEAL_ROLES, discoveryColumns, type Candidate, type CandidateContact } from "../../shared/sourcing";
import { CHECKED, stagesOf, type Campaign, type CampaignSchema, type CellValue, type Column, type Row } from "../../shared/types";
import { CompanyIndex } from "../../shared/values";
import * as db from "../db";
import { publish } from "../enrich/hub";
import { recipeForPreset } from "../enrich/recipes";
import { ensureSourcesColumn, normaliseValue } from "../enrich/runner";
import * as enrichStore from "../enrich/store";
import { enqueueEnrichment } from "./enrichQueue";
import * as store from "./store";

/**
 * The Discovery columns, back in place: any the user deleted is added at the end (on keys no
 * column, deleted ones included, left values under), the sources column with them, and a Fit or
 * Contact type option removed from its dropdown is restored, so every value written has a cell.
 */
export function ensureDiscoveryColumns(campaignId: string): Campaign {
  const c = db.getCampaign(campaignId);
  if (!c) throw new Error("Campaign not found.");
  const contacts = c.schema.contacts ? { ...c.schema.contacts, columns: [...c.schema.contacts.columns] } : { columns: [] };
  const schema: CampaignSchema = { ...c.schema, columns: [...c.schema.columns], contacts };
  let changed = false;
  let taken: Set<string> | null = null;
  const newKey = (header: string) => makeKey(header, (taken ??= new Set([...allColumns(schema).map((col) => col.key), ...db.allCellKeys(campaignId)])));
  for (const f of DISCOVERY_FIELDS) {
    const col = discoveryColumn(schema, f);
    if (col) {
      if (f.options && col.type === "select") {
        const missing = f.options.filter((o) => !col.options?.some((x) => x.toLowerCase() === o.toLowerCase()));
        if (missing.length) {
          replace(schema, col, { ...col, options: [...(col.options ?? []), ...missing] });
          changed = true;
        }
      }
      continue;
    }
    const made: Column = { key: newKey(f.header), header: f.header, type: f.type, origin: "discovery", ...(f.options ? { options: [...f.options] } : {}), ...(f.width ? { width: f.width } : {}) };
    (f.person ? contacts.columns : schema.columns).push(made);
    changed = true;
  }
  const typeCol = contacts.columns.find((x) => x.key === contacts.typeKey);
  if (typeCol) {
    const missing = DEAL_ROLES.filter((r) => !typeCol.options?.some((x) => x.toLowerCase() === r.toLowerCase()));
    if (missing.length || typeCol.type !== "select") {
      replace(schema, typeCol, { ...typeCol, type: "select", options: [...(typeCol.options ?? []), ...missing] });
      changed = true;
    }
  }
  if (changed) db.updateCampaign(campaignId, { schema });
  ensureSourcesColumn(campaignId);
  return db.getCampaign(campaignId)!;
}

function replace(schema: CampaignSchema, col: Column, next: Column): void {
  const i = schema.columns.indexOf(col);
  if (i >= 0) schema.columns[i] = next;
  const j = schema.contacts?.columns.indexOf(col) ?? -1;
  if (j >= 0) schema.contacts!.columns[j] = next;
}

export interface AcceptPick {
  id: string;
  /** The contacts to keep (their ids among the candidate's). */
  contactIds: string[];
}

export interface AcceptResult {
  campaign: Campaign;
  /** The prospects and contacts added. */
  rows: Row[];
  /** Every candidate changed: accepted, or dismissed as a duplicate. */
  candidates: Candidate[];
}

const byHeader = (cols: Column[], names: string[]) => names.map((n) => cols.find((c) => norm(c.header) === n)).find(Boolean);

/** Set a cell from a found value, as the column stores it; nothing for an empty one. */
function put(cells: Record<string, CellValue>, col: Column | undefined, raw: string | number | null | undefined): void {
  if (!col || raw === null || raw === undefined) return;
  const v = normaliseValue(col, String(raw));
  if (v !== null) cells[col.key] = v;
}

/** The contact to make Primary: the one the agent said to approach first, else the Champion, else the Economic Buyer, else the first. */
export function primaryPick(contacts: CandidateContact[], firstContact: string | null): CandidateContact | undefined {
  return contacts.find((p) => p.id === firstContact)
    ?? contacts.find((p) => p.type === "Champion")
    ?? contacts.find((p) => p.type === "Economic Buyer")
    ?? contacts[0];
}

export function acceptCandidates(campaignId: string, picks: AcceptPick[]): AcceptResult {
  const campaign = ensureDiscoveryColumns(campaignId);
  const { schema } = campaign;
  const cs = schema.contacts!;
  const intel = discoveryColumns(schema);
  const stages = stagesOf(schema);
  const website = byHeader(schema.columns, ["website", "url", "domain", "site"]);
  const location = byHeader(schema.columns, ["location", "city", "hq", "headquarters"]);
  const employees = schema.columns.find((c) => c.header === EMPLOYEES_HEADER) ?? schema.columns.find((c) => isEmployeesHeader(c.header));
  const sourceCol = byHeader(schema.columns, ["source"]);
  const sourcesKey = sourcesColumn(schema)?.key;
  const roleCol = byHeader(cs.columns, ROLE_HEADERS);
  const linkedinCol = byHeader(cs.columns, ["linkedin", "linkedinurl"]);
  const typeCol = cs.columns.find((c) => c.key === cs.typeKey);
  const fitCol = intel.fit && intel.fit.type === "select" ? { ...intel.fit, options: intel.fit.options?.length ? intel.fit.options : [...FIT_OPTIONS] } : intel.fit;

  // What is in the list now, so a company that got in since it was suggested is not added twice.
  const prospects = db.listRows(campaignId);
  const index = new CompanyIndex<string>();
  for (const r of prospects) index.add(schema.companyKey ? r.cells[schema.companyKey] : null, website ? r.cells[website.key] : null, String(schema.idKey ? r.cells[schema.idKey] ?? r.id : r.id));
  const nextId = prospectIds([...(schema.reservedIds ?? []), ...prospects.map((r) => String(schema.idKey ? r.cells[schema.idKey] ?? "" : ""))]);

  const rows: Row[] = [];
  const changed: Candidate[] = [];
  const accepted: { rowId: string; runId: string }[] = [];
  for (const pick of picks) {
    const c = store.getCandidate(campaignId, pick.id);
    if (!c || c.status === "accepted" || c.status === "dismissed" || c.status === "mapping") continue;
    const now = Date.now();
    const dup = index.find(c.company, c.website);
    if (dup) {
      changed.push({ ...c, status: "dismissed", dismissReason: `Already in the list as ${dup}`, updatedAt: now });
      continue;
    }
    const id = schema.idKey ? nextId() : null;
    const cells: Record<string, CellValue> = {};
    if (schema.idKey && id) cells[schema.idKey] = id;
    if (schema.companyKey) cells[schema.companyKey] = c.company;
    put(cells, website, c.website);
    put(cells, location, c.location);
    put(cells, employees, c.employees);
    put(cells, fitCol, c.fit);
    put(cells, intel.whyFit, c.whyFit);
    put(cells, intel.whyNow, c.whyNow);
    put(cells, intel.budget, c.budget);
    put(cells, intel.clock, c.clock);
    put(cells, sourceCol, "Discovery");
    if (schema.statusKey && stages[0]) cells[schema.statusKey] = stages[0];
    if (sourcesKey) {
      const company: Source[] = c.sources.filter((s) => !c.contacts.some((p) => p.source === s.url));
      let text = mergeSources(null, "Company", company);
      for (const p of c.contacts) if (p.source && pick.contactIds.includes(p.id)) text = mergeSources(text, p.name, [{ url: p.source }]);
      if (text) cells[sourcesKey] = text;
    }
    const rowId = db.newId();
    const chosen = c.contacts.filter((p) => pick.contactIds.includes(p.id));
    const primary = primaryPick(chosen, c.firstContact);
    const people: Partial<Row>[] = chosen.map((p) => {
      const pc: Record<string, CellValue> = {};
      if (cs.nameKey) pc[cs.nameKey] = p.name;
      put(pc, typeCol, p.type);
      put(pc, roleCol, p.title);
      put(pc, linkedinCol, p.linkedin);
      put(pc, intel.dealRole, p.dealRole);
      put(pc, intel.gain, p.gain);
      put(pc, intel.angle, p.angle);
      if (cs.primaryKey && p === primary) pc[cs.primaryKey] = CHECKED;
      return { id: db.newId(), parentId: rowId, cells: pc };
    });
    const inserted = db.insertRows(campaignId, [{ id: rowId, cells }, ...people]);
    rows.push(...inserted);
    index.add(c.company, c.website, id ?? rowId);
    changed.push({ ...c, status: "accepted", rowId, updatedAt: now });
    accepted.push({ rowId, runId: c.runId });
  }
  store.saveCandidates(changed);
  if (rows.length) publish(campaignId, { type: "rows", rows });
  if (changed.length) publish(campaignId, { type: "candidates", candidates: changed });

  // The enrichment each run chose, on the prospects accepted from it.
  const byRun = new Map<string, string[]>();
  for (const a of accepted) byRun.set(a.runId, [...(byRun.get(a.runId) ?? []), a.rowId]);
  for (const [runId, rowIds] of byRun) {
    const run = store.getDiscoveryRun(runId);
    const choice = run?.enrich;
    if (!choice) continue;
    const recipes = [
      ...choice.presets.map((p) => recipeForPreset(campaignId, p)?.id),
      ...choice.recipeIds.map((rid) => enrichStore.getRecipe(rid)?.id),
    ].filter((rid): rid is string => !!rid);
    enqueueEnrichment(campaignId, rowIds, [...new Set(recipes)], choice.autoFill);
  }
  return { campaign: db.getCampaign(campaignId)!, rows, candidates: changed };
}

export function dismissCandidates(campaignId: string, ids: string[], reason: string | null): Candidate[] {
  const changed: Candidate[] = [];
  for (const id of new Set(ids)) {
    const c = store.getCandidate(campaignId, id);
    if (!c || c.status === "accepted") continue;
    changed.push({ ...c, status: "dismissed", dismissReason: reason?.trim() || null, updatedAt: Date.now() });
  }
  store.saveCandidates(changed);
  if (changed.length) publish(campaignId, { type: "candidates", candidates: changed });
  return changed;
}

/** A dismissed candidate back in the inbox: ready if its people were mapped, else an error "Map again" fixes. */
export function restoreCandidates(campaignId: string, ids: string[]): Candidate[] {
  const changed: Candidate[] = [];
  for (const id of new Set(ids)) {
    const c = store.getCandidate(campaignId, id);
    if (!c || c.status !== "dismissed") continue;
    const mapped = c.contacts.length > 0;
    changed.push({ ...c, status: mapped ? "ready" : "error", error: mapped ? null : "Its buying committee has not been mapped. Map again to find who to talk to.", dismissReason: null, updatedAt: Date.now() });
  }
  store.saveCandidates(changed);
  if (changed.length) publish(campaignId, { type: "candidates", candidates: changed });
  return changed;
}
