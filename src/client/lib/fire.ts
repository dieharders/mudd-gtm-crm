import toast from "react-hot-toast";

/**
 * Start async work from an event handler. React ignores a handler's promise, so a failure would
 * vanish; here it shows as an error toast instead. (Handlers that report their own errors lose
 * nothing: their promise just resolves.)
 */
export function fire(work: Promise<unknown>): void {
  work.catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)));
}
