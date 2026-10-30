/** Normalized API error: carries the HTTP status and parsed body (never the bearer token). */
export class BdzApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown, message?: string) {
    super(message ?? describe(status, body));
    this.name = "BdzApiError";
    this.status = status;
    this.body = body;
  }
}

function describe(status: number, body: unknown): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (typeof b.error_description === "string") return b.error_description;
    if (typeof b.message === "string" && b.message !== "The request is invalid.") return b.message;
    if (b.error) return String(b.error);
    if (b.modelState) {
      const parts: string[] = [];
      for (const [field, msgs] of Object.entries(b.modelState as Record<string, unknown>)) {
        if (Array.isArray(msgs)) parts.push(`${field}: ${msgs.join("; ")}`);
      }
      if (parts.length) return parts.join(" | ");
    }
  }
  if (typeof body === "string" && body) return body.slice(0, 300);
  return `BDZ API error (HTTP ${status})`;
}

// ---- known upstream errors (2026-10-26 lesson) -----------------------------
// These exact strings used to surface as raw errors and were misread as
// glitches; each has one specific meaning and one specific recovery path.

export type MappedBdzError = { code: string; meaning: string; guidance: string };

export function mapBdzErrorMessage(message: string): MappedBdzError | null {
  if (message.includes("Няма намерени свободни места")) {
    return {
      code: "no_free_seats",
      meaning: "Sold out: no free seats of this reservation type on this train and date.",
      guidance:
        "Not a malfunction. Check bdz_seat_map for another seat type (e.g. sleeper 2nd instead of sleeper 1st), another train, or another date before quoting again.",
    };
  }
  if (message.includes("Няма достатъчно спални места от поисканата класа")) {
    return {
      code: "combined_unavailable",
      meaning:
        "The combined two-leg (round-trip) reservation was refused even though per-leg seat maps showed free berths.",
      guidance:
        "Do not retry the combined call. Reserve legs ONE at a time, paying each before creating the next. The round-trip discount (~30% off the return leg) applies only inside one combined booking, so per-leg prices will be higher: re-quote and re-confirm the total with the user.",
    };
  }
  return null;
}
