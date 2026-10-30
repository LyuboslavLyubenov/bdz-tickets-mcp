// Shared helper for offline tests: prime auth with a token and route every
// bdzFetch call to fixture responses matched by URL substring / request body.

import { primeTokenForTests } from "../../src/api/auth.ts";
import { setFetchImpl } from "../../src/api/client.ts";

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export type FakeRoute = {
  match: (url: string, init?: RequestInit) => boolean;
  respond: (url: string, init?: RequestInit) => Response;
};

export function installFakeBdz(routes: FakeRoute[]) {
  primeTokenForTests();
  setFetchImpl((url, init) => {
    const target = String(url);
    const hit = routes.find((r) => r.match(target, init));
    if (!hit) throw new Error(`fake-bdz: no route matches ${target}`);
    return Promise.resolve(hit.respond(target, init));
  });
}

export function uninstallFakeBdz() {
  setFetchImpl(null);
}

/** Parse the JSON body of a captured request (bdzFetch always JSON-serializes opts.json). */
export function bodyOf(init?: RequestInit): any {
  if (!init?.body || typeof init.body !== "string") return {};
  return JSON.parse(init.body);
}
