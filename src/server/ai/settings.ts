/** The AI settings (provider, model, effort), kept in SQLite. */
import { DEFAULT_AI_SETTINGS, PROVIDER_IDS, PROVIDERS, type AiSettings } from "../../shared/ai";
import { getSetting, setSetting } from "../db";

const KEY = "ai.settings";

export function getAiSettings(): AiSettings {
  const s = getSetting<Partial<AiSettings>>(KEY, {});
  return {
    ...DEFAULT_AI_SETTINGS,
    ...s,
    model: { ...DEFAULT_AI_SETTINGS.model, ...(s.model ?? {}) },
    effort: { ...DEFAULT_AI_SETTINGS.effort, ...(s.effort ?? {}) },
  };
}

export function updateAiSettings(patch: Partial<AiSettings>): AiSettings {
  const cur = getAiSettings();
  const next: AiSettings = {
    ...cur,
    ...patch,
    model: { ...cur.model, ...(patch.model ?? {}) },
    effort: { ...cur.effort, ...(patch.effort ?? {}) },
  };
  if (next.provider !== null && !PROVIDER_IDS.includes(next.provider)) next.provider = cur.provider;
  for (const id of PROVIDER_IDS) {
    if (!PROVIDERS[id].efforts.includes(next.effort[id]!)) next.effort[id] = DEFAULT_AI_SETTINGS.effort[id];
    // Codex takes any model name the user types; Claude takes its aliases or a full id.
    if (!next.model[id] || !/^[\w.:-]{1,64}$/.test(next.model[id]!)) next.model[id] = DEFAULT_AI_SETTINGS.model[id];
  }
  setSetting(KEY, next);
  return next;
}
