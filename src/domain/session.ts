// In-memory state of the last pending purchase (single-user server, so one slot is enough).

export type PendingPurchase = {
  ticket_ids: number[];
  total_price: number;
  created_at_ms: number;
  transaction_id?: number;
  provider?: "borica" | "epay";
};

/** BDZ payment sessions last 10 minutes from search/ticket creation. */
export const SESSION_TTL_MS = 10 * 60 * 1000;

let last: PendingPurchase | null = null;

export function setPendingPurchase(p: PendingPurchase) {
  last = p;
}

/**
 * Store a new pending purchase and report the one it replaced. BDZ allows only ONE
 * pending purchase per account: creating a second reservation releases the first
 * server-side, so the previous slot is returned (when it was still live) for the
 * caller to warn about. Only call this after the BDZ create succeeded.
 */
export function beginPendingPurchase(p: PendingPurchase): { superseded: PendingPurchase | null } {
  const previous = last;
  last = p;
  const live =
    previous &&
    previous.ticket_ids.length > 0 &&
    Date.now() - previous.created_at_ms <= SESSION_TTL_MS;
  return { superseded: live ? previous : null };
}

export function getPendingPurchase(): PendingPurchase | null {
  return last;
}

export function updatePendingPurchase(patch: Partial<PendingPurchase>) {
  if (!last) throw new Error("No pending purchase in this server session.");
  last = { ...last, ...patch };
}

export function clearPendingPurchase() {
  last = null;
}

export function pendingPurchaseAgeMs(): number | null {
  return last ? Date.now() - last.created_at_ms : null;
}

export function pendingPurchaseExpired(): boolean {
  const age = pendingPurchaseAgeMs();
  return age === null || age > SESSION_TTL_MS;
}
