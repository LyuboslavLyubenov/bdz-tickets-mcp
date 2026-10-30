// Interpretation of BORICA/ePay CheckPayment responses (PLAN.md 3.8).
// The 2026-10-26 session misread rc:-24 as a card decline; it is not.

export type PaymentStatus = {
  status: "paid" | "expired_unpaid" | "failed" | "pending_or_unconfirmed" | "unknown";
  rc: number | null;
  approval: string | null;
  detail: string;
};

/**
 * BORICA status reports carry `rc` (0 = success, negative = error code) plus an
 * `approval` code when a card actually authorized. rc:-24 with no approval means
 * the payment session expired with nothing charged and nothing attempted against
 * the card. Unknown payloads pass through as "unknown" with the raw data intact.
 */
export function interpretCheckPayment(raw: unknown): PaymentStatus {
  if (!raw || typeof raw !== "object") {
    return { status: "unknown", rc: null, approval: null, detail: "No parsable payload from the gateway." };
  }
  const b = raw as Record<string, unknown>;
  const approval = typeof b.approval === "string" && b.approval.length > 0 ? b.approval : null;
  const rcRaw = b.rc;
  const rc = rcRaw === undefined || rcRaw === null || rcRaw === "" ? null : Number(rcRaw);

  if (rc === null || Number.isNaN(rc)) {
    return {
      status: "unknown",
      rc: null,
      approval,
      detail: "Payload has no numeric rc field; inspect the raw gateway response and bdz_tickets status.",
    };
  }
  if (rc === 0 && approval) {
    return { status: "paid", rc, approval, detail: "Gateway approved the payment." };
  }
  if (rc === 0) {
    return {
      status: "pending_or_unconfirmed",
      rc,
      approval,
      detail: "Gateway reports success without an approval code; confirm via bdz_tickets (status 2 = issued/paid).",
    };
  }
  if (rc === -24) {
    return {
      status: "expired_unpaid",
      rc,
      approval,
      detail:
        "The payment session expired with nothing charged and no card attempt. Not a card decline. " +
        "Re-search (route_ids are session-scoped), re-create the reservation, and open the payment link within ~10 minutes.",
    };
  }
  return {
    status: "failed",
    rc,
    approval,
    detail: `Gateway error code ${rc}; nothing was confirmed. Check bdz_tickets status before any retry.`,
  };
}
