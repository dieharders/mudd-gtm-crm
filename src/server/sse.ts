/**
 * Server-sent event streams: the campaign hub's and AI setup's. `: connected` goes first so the
 * headers flush at once, and a comment ping every 25 s keeps a quiet stream (a sign-in while the
 * user is in their browser) under the server's idle timeout.
 */

export const sseFrame = (ev: unknown) => `data: ${JSON.stringify(ev)}\n\n`;

/**
 * `start` gets `push` (a ready-made frame or comment) and `close`; `cancel` runs when the client
 * goes away. A push after either is dropped.
 */
export function sseResponse(start: (push: (text: string) => void, close: () => void) => void, cancel: () => void = () => {}): Response {
  const enc = new TextEncoder();
  let ping: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (text: string) => {
        try {
          controller.enqueue(enc.encode(text));
        } catch {
          /* closed */
        }
      };
      const close = () => {
        clearInterval(ping);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      push(": connected\n\n");
      ping = setInterval(() => push(": ping\n\n"), 25_000);
      start(push, close);
    },
    cancel() {
      clearInterval(ping);
      cancel();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" } });
}
