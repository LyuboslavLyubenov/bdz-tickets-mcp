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
