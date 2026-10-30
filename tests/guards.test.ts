import { describe, expect, test } from "bun:test";
import {
  annotateQuoteLegs,
  decideCreate,
  type ExistingPurchase,
} from "../src/domain/purchase.ts";
import {
  beginPendingPurchase,
  clearPendingPurchase,
  getPendingPurchase,
} from "../src/domain/session.ts";

const NOW = 1_700_000_000_000;
const livePurchase = (ids: number[]): ExistingPurchase => ({
  ticket_ids: ids,
  total_price: 20.2,
  created_at_ms: NOW - 60_000, // 1 minute ago
});
const expiredPurchase = (ids: number[]): ExistingPurchase => ({
  ticket_ids: ids,
  total_price: 20.2,
  created_at_ms: NOW - 11 * 60_000, // 11 minutes ago
});

describe("decideCreate (F1 pending-purchase guard)", () => {
  test("no existing purchase allows the create", () => {
    const d = decideCreate(null, { nowMs: NOW });
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.warning).toBeNull();
  });

  test("expired pending purchase does not block", () => {
    const d = decideCreate(expiredPurchase([67815925]), { nowMs: NOW });
    expect(d.allowed).toBe(true);
  });

  test("pending purchase with no tickets does not block", () => {
    const d = decideCreate({ ticket_ids: [], total_price: 0, created_at_ms: NOW - 1 }, { nowMs: NOW });
    expect(d.allowed).toBe(true);
  });

  test("live pending purchase refuses without supersede", () => {
    const d = decideCreate(livePurchase([67815925]), { nowMs: NOW });
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.reason).toContain("ONE pending purchase");
      expect(d.reason).toContain("67815925");
      expect(d.reason).toContain("supersede:true");
    }
  });

  test("supersede:true allows, but warns about release and discount loss", () => {
    const d = decideCreate(livePurchase([67815925]), { nowMs: NOW, supersede: true });
    expect(d.allowed).toBe(true);
    if (d.allowed) {
      expect(d.superseded_ticket_ids).toEqual([67815925]);
      expect(d.warning).toContain("round-trip discount");
      expect(d.warning).toContain("67815925");
    }
  });
});

describe("beginPendingPurchase (F1 session slot)", () => {
  test("stores new purchase and reports the live one it replaced", () => {
    clearPendingPurchase();
    beginPendingPurchase({ ticket_ids: [1], total_price: 10, created_at_ms: Date.now() });
    const { superseded } = beginPendingPurchase({
      ticket_ids: [2],
      total_price: 20,
      created_at_ms: Date.now(),
    });
    expect(superseded?.ticket_ids).toEqual([1]);
    expect(getPendingPurchase()?.ticket_ids).toEqual([2]);
  });

  test("does not report an expired previous purchase", () => {
    clearPendingPurchase();
    beginPendingPurchase({
      ticket_ids: [1],
      total_price: 10,
      created_at_ms: Date.now() - 11 * 60_000,
    });
    const { superseded } = beginPendingPurchase({
      ticket_ids: [2],
      total_price: 20,
      created_at_ms: Date.now(),
    });
    expect(superseded).toBeNull();
    clearPendingPurchase();
  });
});

describe("annotateQuoteLegs (F4 honest quotes)", () => {
  test("all legs available → bookable", () => {
    const r = annotateQuoteLegs([
      { free_seats: 2, available: true },
      { free_seats: 3, available: true },
    ]);
    expect(r.bookable).toBe(true);
    expect(r.price_is_theoretical).toBe(false);
    expect(r.note).toContain("ONE create_ticket");
  });

  test("one sold-out leg → price is theoretical", () => {
    const r = annotateQuoteLegs([
      { free_seats: 2, available: true },
      { free_seats: 0, available: false },
    ]);
    expect(r.bookable).toBe(false);
    expect(r.price_is_theoretical).toBe(true);
    expect(r.note).toContain("THEORETICAL");
  });

  test("empty availability list is not bookable", () => {
    expect(annotateQuoteLegs([]).bookable).toBe(false);
  });
});
