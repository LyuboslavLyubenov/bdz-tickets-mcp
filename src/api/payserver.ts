// Localhost host for gateway form-POST pages. One server per transaction,
// bound to 127.0.0.1 on a random port, self-stops after the payment window.

import { buildPayFormPage } from "../domain/payform.ts";
import { SESSION_TTL_MS } from "../domain/session.ts";

type RunningForm = { url: string; stop: () => void };
const running = new Map<number, RunningForm>();

/**
 * Serve the auto-submit page for one transaction. Returns the clickable URL
 * (http://127.0.0.1:<port>/pay/<transactionId>). Stops any previous server for
 * the same transaction and self-stops SESSION_TTL_MS + 60s later.
 */
export function servePayForm(
  transactionId: number,
  gatewayUrl: string,
  fields: Record<string, string>,
): string {
  stopPayFormServer(transactionId);
  const page = buildPayFormPage(gatewayUrl, fields);
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      if (path === `/pay/${transactionId}`) {
        return new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      return new Response("Not found\n", { status: 404 });
    },
  });
  const url = `http://127.0.0.1:${server.port}/pay/${transactionId}`;
  const timer = setTimeout(() => stopPayFormServer(transactionId), SESSION_TTL_MS + 60_000);
  timer.unref?.();
  running.set(transactionId, {
    url,
    stop: () => {
      clearTimeout(timer);
      server.stop(true);
    },
  });
  return url;
}

export function stopPayFormServer(transactionId: number) {
  running.get(transactionId)?.stop();
  running.delete(transactionId);
}

export function stopAllPayFormServers() {
  for (const id of [...running.keys()]) stopPayFormServer(id);
}

/** URL if a page is being served for this transaction, else null. */
export function getPayFormUrl(transactionId: number): string | null {
  return running.get(transactionId)?.url ?? null;
}
