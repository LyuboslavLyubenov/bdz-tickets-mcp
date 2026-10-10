import { BASE_URL, getToken, invalidateToken } from "./auth.ts";
import { BdzApiError } from "./errors.ts";

export { BASE_URL };

export type RequestOptions = {
  method?: "GET" | "POST";
  /** JSON-serializable request body (sent as application/json). */
  json?: unknown;
  /** Attach Authorization header (default true). */
  auth?: boolean;
};

/**
 * Single JSON call against tickets.bdz.bg/portal.
 * On 401 the cached token is dropped and the call is retried once with a fresh login.
 */
export async function bdzFetch(path: string, opts: RequestOptions = {}, retried = false): Promise<any> {
  const headers: Record<string, string> = { "Accept-Language": "bg-BG" };
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  }
  if (opts.auth !== false) headers["Authorization"] = `Bearer ${await getToken()}`;

  let res: Response;
  try {
    res = await fetch(BASE_URL + path, { method: opts.method ?? (body !== undefined ? "POST" : "GET"), headers, body });
  } catch (e) {
    throw new Error(`Cannot reach BDZ API (${path}): network error — ${e}`);
  }

  if (res.status === 401 && opts.auth !== false && !retried) {
    await invalidateToken();
    return bdzFetch(path, opts, true);
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) throw new BdzApiError(res.status, data);
  return data;
}
