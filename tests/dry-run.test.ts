// F7/T4 from PLAN-FIXES.md: with BDZ_DRY_RUN=1 the purchase tools must run all
// guard logic and touch zero BDZ endpoints. A throwing fetch proves the latter.

import { afterAll, describe, expect, test } from "bun:test";
import { clearPendingPurchase } from "../src/domain/session.ts";
import { createTicketImpl, paymentLinkImpl } from "../src/tools/purchase-write.ts";
import { installFakeBdz, uninstallFakeBdz } from "./lib/fake-bdz.ts";

const passenger = { names: "Тест Пътуващ", gender: "m" as const };

afterAll(() => {
  delete process.env.BDZ_DRY_RUN;
  uninstallFakeBdz();
  clearPendingPurchase();
});

describe("BDZ_DRY_RUN mode (F7)", () => {
  test("create runs guards and never reaches the network", async () => {
    process.env.BDZ_DRY_RUN = "1";
    clearPendingPurchase();
    installFakeBdz([]); // any BDZ call would throw "no route matches"
    const r = await createTicketImpl({
      legs: [{ route_id: 447159326, train_id: 11, date: "2026-10-28", seat_type_id: 13 }],
      passengers: [passenger],
      confirm: true,
    });
    expect(r.dry_run).toBe(true);
    expect(r.created).toBe(false);
    expect(r.would_create.legs[0]!.route_id).toBe(447159326);
    expect(r.guards.pending_conflict).toBeNull();
    expect(r.note).toContain("no reservation was created");
  });

  test("supersede guard still fires in dry-run", async () => {
    process.env.BDZ_DRY_RUN = "1";
    // first dry-run stores the synthetic empty slot; seed a real pending conflict
    clearPendingPurchase();
    const { beginPendingPurchase } = await import("../src/domain/session.ts");
    beginPendingPurchase({ ticket_ids: [67815925], total_price: 20.2, created_at_ms: Date.now() });
    const refused = await createTicketImpl({
      legs: [{ route_id: 1, train_id: 1, date: "2026-10-28", seat_type_id: 13 }],
      passengers: [passenger],
      confirm: true,
    });
    expect(refused.dry_run).toBeUndefined();
    expect(refused.created).toBe(false);
    expect(refused.reason).toContain("ONE pending purchase");

    const ok = await createTicketImpl({
      legs: [{ route_id: 1, train_id: 1, date: "2026-10-28", seat_type_id: 13 }],
      passengers: [passenger],
      confirm: true,
      supersede: true,
    });
    expect(ok.dry_run).toBe(true);
    expect(ok.guards.pending_conflict).toEqual([67815925]);
    clearPendingPurchase();
  });

  test("payment link dry-run reports the provider plan without starting a transaction", async () => {
    process.env.BDZ_DRY_RUN = "1";
    installFakeBdz([]); // no network allowed here either
    // synthetic pending slot from a dry-run create
    const { setPendingPurchase } = await import("../src/domain/session.ts");
    setPendingPurchase({ ticket_ids: [], total_price: 27.87, created_at_ms: Date.now() });
    const r = await paymentLinkImpl({ provider: "auto", confirm: true });
    expect(r.dry_run).toBe(true);
    expect(r.started).toBe(false);
    expect(r.would_pay.provider).toBe("auto");
    expect(r.would_pay.provider_plan).toContain("ePay");
    expect(r.would_pay.total_price).toBe(27.87);
    expect(r.note).toContain("no payment transaction was started");
  });

  test("dry-run flag off restores real behavior (guard refuses on live pending)", async () => {
    delete process.env.BDZ_DRY_RUN;
    clearPendingPurchase();
    const { setPendingPurchase } = await import("../src/domain/session.ts");
    setPendingPurchase({ ticket_ids: [67815925], total_price: 20.2, created_at_ms: Date.now() });
    const r = await createTicketImpl({
      legs: [{ route_id: 1, train_id: 1, date: "2026-10-28", seat_type_id: 13 }],
      passengers: [passenger],
      confirm: true,
    });
    expect(r.dry_run).toBeUndefined();
    expect(r.created).toBe(false);
    clearPendingPurchase();
  });
});
