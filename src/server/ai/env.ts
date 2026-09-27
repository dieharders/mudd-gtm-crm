/**
 * The environment every agent CLI gets.
 *
 * The point of driving the user's CLI is that it bills their SUBSCRIPTION. But Claude Code
 * prefers an API key when one is exported, so a developer with ANTHROPIC_API_KEY set for other
 * work would be billed per token. In `subscription` mode those variables are removed from the
 * child's environment. The user can switch to `auto` in AI settings, and claude.ts never lets
 * the strip take someone's ONLY credential (see authStatus there). From motionbuff's env.ts.
 */
import { getAiSettings } from "./settings";

const OVERRIDES = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"] as const;

export function childEnv(): Record<string, string | undefined> {
  // Spread: the Agent SDK's `env` REPLACES the child environment, so PATH, HOME and
  // USERPROFILE must be carried over or the CLI cannot find its own credentials.
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "mudd.io/0.2" };
  if (getAiSettings().credentialMode !== "subscription") return env;
  for (const k of OVERRIDES) delete env[k];
  return env;
}

export function hadApiKeyOverride(): boolean {
  return OVERRIDES.some((k) => Boolean(process.env[k]));
}
