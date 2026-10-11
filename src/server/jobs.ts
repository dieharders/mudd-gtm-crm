/**
 * What the enrichment and discovery engines share about running jobs: a gate paused workers
 * wait at, and the retry policy of one agent turn.
 */
import { AiError } from "./ai";

/**
 * A gate several workers wait at (a paused run). `open()` releases every waiter at once: a
 * single stored resolver would let one worker through and leave the rest waiting forever.
 */
export class Gate {
  private waiters: (() => void)[] = [];

  wait(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  open(): void {
    const waiting = this.waiters;
    this.waiters = [];
    for (const resolve of waiting) resolve();
  }
}

export type TurnOutcome<T> = { ok: T } | { error: string } | { stop: "aborted" | "fatal" };

export const MAX_RETRIES = 2;
const RETRY_DELAYS = [3_000, 8_000];

/**
 * One agent turn, tried up to three times. Stopping mid-turn is reported as such, not as a
 * failure. A missing or signed-out CLI is fatal: every other turn would fail the same way, so the
 * caller fails the whole run (`onFatal`) and the turn is not retried.
 */
export async function retryTurn<T>(opts: {
  attempt: () => Promise<T>;
  signal: AbortSignal;
  /** Before each retry: which one this is, of how many. */
  onRetry?: (n: number, max: number) => void;
  onFatal: (message: string) => void;
  /** For the log line when every attempt failed. */
  label?: string;
  retries?: number;
}): Promise<TurnOutcome<T>> {
  const max = opts.retries ?? MAX_RETRIES;
  for (let attempt = 0; ; attempt++) {
    try {
      return { ok: await opts.attempt() };
    } catch (err) {
      if (opts.signal.aborted) return { stop: "aborted" };
      const message = (err as Error).message;
      const code = err instanceof AiError ? err.code : "cli_failed";
      if (code === "cli_missing" || code === "not_authenticated") {
        opts.onFatal(message);
        return { stop: "fatal" };
      }
      if (attempt < max) {
        opts.onRetry?.(attempt + 1, max);
        await Bun.sleep(RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)]!);
        continue;
      }
      console.error(`[ai] ${opts.label ?? "turn"} failed:`, err);
      return { error: message };
    }
  }
}
