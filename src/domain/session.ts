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
