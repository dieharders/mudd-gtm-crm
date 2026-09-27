/** Does an email's domain accept mail at all? A cheap sanity check on a found address. */
import { promises as dns } from "node:dns";

const cache = new Map<string, Promise<boolean | null>>();

export function domainAcceptsMail(email: string): Promise<boolean | null> {
  const domain = /@([^@\s]+)$/.exec(email.trim())?.[1]?.toLowerCase();
  if (!domain) return Promise.resolve(false);
  let hit = cache.get(domain);
  if (!hit) {
    hit = Promise.race([
      dns.resolveMx(domain).then((r) => r.length > 0, (err: { code?: string }) => (err.code === "ENOTFOUND" || err.code === "ENODATA" ? false : null)),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
    ]);
    cache.set(domain, hit);
  }
  return hit;
}
