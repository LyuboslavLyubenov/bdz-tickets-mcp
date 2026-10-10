import { describe, expect, test } from "bun:test";
import {
  getPendingPurchase,
  pendingPurchaseExpired,
  setPendingPurchase,
  SESSION_TTL_MS,
} from "../src/domain/session.ts";

describe("pending purchase session state", () => {
  test("fresh purchase is not expired", () => {
    setPendingPurchase({ ticket_ids: [1], total_price: 7.57, created_at_ms: Date.now() });
    expect(pendingPurchaseExpired()).toBe(false);
    expect(getPendingPurchase()?.ticket_ids).toEqual([1]);
  });

  test("purchase older than the 10-minute window is expired", () => {
    setPendingPurchase({
      ticket_ids: [1],
      total_price: 7.57,
      created_at_ms: Date.now() - SESSION_TTL_MS - 1000,
    });
    expect(pendingPurchaseExpired()).toBe(true);
  });

  test("purchase inside the window is not expired", () => {
    setPendingPurchase({
      ticket_ids: [1],
      total_price: 7.57,
      created_at_ms: Date.now() - SESSION_TTL_MS + 60_000,
    });
    expect(pendingPurchaseExpired()).toBe(false);
  });

  test("no purchase at all counts as expired", () => {
    // uses the real singleton; run last — reset to empty
    setPendingPurchase({ ticket_ids: [], total_price: 0, created_at_ms: Date.now() - SESSION_TTL_MS * 2 });
    expect(pendingPurchaseExpired()).toBe(true);
  });
});
