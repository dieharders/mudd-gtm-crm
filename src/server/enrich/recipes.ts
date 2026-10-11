/**
 * Making recipes: pointing each output at a column (creating the ones that don't exist yet),
 * and a preset as a recipe for a campaign. Used by the recipe routes and by Discovery, which
 * runs the user's chosen presets on the prospects it accepts.
 */
import type { Recipe, RecipeDraft, RecipeOutput } from "../../shared/ai";
import { PRESETS, presetRecipe } from "../../shared/presets";
import { allColumns, columnOf, EMPLOYEES_HEADER, isEmployeesHeader, makeKey, typeFromHeader } from "../../shared/schema";
import type { Campaign, CampaignSchema, ColumnType } from "../../shared/types";
import * as db from "../db";
import { publishCampaign, publishRecipes } from "./hub";
import { ensureSourcesColumn } from "./runner";
import * as store from "./store";

/** A new column's type: what import makes of the same header, else long text for a long hint. */
export function guessType(header: string, hint = ""): ColumnType {
  return typeFromHeader(header)?.type ?? (hint.length > 80 ? "longtext" : "text");
}

export type OutputInput = RecipeDraft["outputs"][number];

/**
 * Point each recipe output at a column, creating the ones that don't exist yet: among the
 * contact columns for a person's detail (`contact`), else the prospect's. New columns are
 * appended (never inserted), so they land after the sheet's last column on export.
 */
export function resolveOutputs(campaignId: string, outputs: OutputInput[], recipeId: string): RecipeOutput[] {
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
    const employees = !o.contact && isEmployeesHeader(o.header);
    const header = employees ? EMPLOYEES_HEADER : o.header.trim();
    if (!header) continue;
    const pool = o.contact && contacts ? contacts.columns : schema.columns;
    let col = o.key ? columnOf(schema, o.key) : undefined;
    col ??= pool.find((x) => x.header.toLowerCase() === header.toLowerCase() || (employees && isEmployeesHeader(x.header)));
    // The ID is Mudd's own, and the Primary box is the user's pick (one per prospect): nothing
    // is researched into either.
    if (col && (col.key === schema.idKey || col.key === schema.contacts?.primaryKey)) continue;
    if (!col) {
      col = { key: newKey(header), header, type: o.type ?? guessType(header, o.hint), origin: "enrichment", recipeId, width: 220, ...(o.options?.length ? { options: o.options } : {}) };
      pool.push(col);
    }
    if (!resolved.some((r) => r.key === col!.key)) resolved.push({ key: col.key, header: col.header, hint: o.hint?.trim() || undefined });
  }
  if (allColumns(schema).length !== before) {
    db.updateCampaign(campaignId, { schema });
    publishCampaign(campaignId);
  }
  return resolved;
}

/** Make a recipe from a draft. Throws with a message fit for the user when the draft is no recipe. */
export function createRecipe(campaignId: string, draft: RecipeDraft): { recipe: Recipe; campaign: Campaign } {
  if (!draft.instructions?.trim()) throw new Error("Describe what to find.");
  const recipeId = db.newId();
  const outputs = resolveOutputs(campaignId, draft.outputs ?? [], recipeId);
  if (!outputs.length) throw new Error("Add at least one output column.");
  ensureSourcesColumn(campaignId);
  const recipe = store.saveRecipe({
    id: recipeId,
    campaignId,
    name: draft.name?.trim() || "Untitled recipe",
    instructions: draft.instructions.trim(),
    inputKeys: draft.inputKeys ?? [],
    outputs,
    webSearch: draft.webSearch !== false,
    ...(draft.presetId ? { presetId: draft.presetId } : {}),
  });
  publishRecipes(campaignId);
  return { recipe, campaign: db.getCampaign(campaignId)! };
}

/**
 * The campaign's recipe for a preset: the one already made from it (the newest), else a new one.
 * Null for a preset id that isn't one.
 */
export function recipeForPreset(campaignId: string, presetId: string): Recipe | null {
  const preset = PRESETS.find((p) => p.id === presetId);
  if (!preset) return null;
  const existing = store.listRecipes(campaignId).find((r) => r.presetId === presetId);
  if (existing) return existing;
  const c = db.getCampaign(campaignId);
  if (!c) return null;
  const rows = [...db.listRows(campaignId), ...db.listRows(campaignId, "contacts")];
  return createRecipe(campaignId, presetRecipe(preset, c.schema, rows)).recipe;
}
