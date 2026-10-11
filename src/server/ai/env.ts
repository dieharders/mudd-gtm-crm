/**
 * The environment every agent CLI gets.
 *
 * Research always bills the user's SUBSCRIPTION, never an API key. The CLIs prefer a key when
 * one is exported, so a user with ANTHROPIC_API_KEY or OPENAI_API_KEY set for other work would
 * be billed per token: those variables are always removed from the child's environment.
 */
const OVERRIDES = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
  "OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL",
] as const;

export function childEnv(): Record<string, string | undefined> {
  // Spread: the Agent SDK's `env` REPLACES the child environment, so PATH, HOME and
  // USERPROFILE must be carried over or the CLI cannot find its own credentials.
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "mudd/0.2" };
  for (const k of OVERRIDES) delete env[k];
  return env;
}
