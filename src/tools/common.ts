import { BdzApiError } from "../api/errors.ts";
import { StationResolutionError } from "../domain/nomenclatures-cache.ts";

export function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

/**
 * Uniform tool error mapping: known BDZ/validation errors become readable text results,
 * anything else rethrows for the SDK's catch-all.
 */
export async function handle(fn: () => Promise<unknown>) {
  try {
    return jsonResult(await fn());
  } catch (e) {
    if (e instanceof StationResolutionError) return errorResult(e.message);
    if (e instanceof BdzApiError) {
      return errorResult(
        `BDZ API error (HTTP ${e.status}): ${e.message}` +
          (e.body && typeof e.body === "object" && Object.keys(e.body as object).length
            ? ` — body: ${JSON.stringify(e.body).slice(0, 500)}`
            : ""),
      );
    }
    if (e instanceof Error) return errorResult(e.message);
    throw e;
  }
}
