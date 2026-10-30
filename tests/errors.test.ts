import { describe, expect, test } from "bun:test";
import { BdzApiError, mapBdzErrorMessage } from "../src/api/errors.ts";
import { handle } from "../src/tools/common.ts";

describe("mapBdzErrorMessage (F5 error mapping)", () => {
  test("seat-map sold-out string maps to no_free_seats", () => {
    const m = mapBdzErrorMessage("Няма намерени свободни места!");
    expect(m?.code).toBe("no_free_seats");
    expect(m?.meaning).toContain("Sold out");
    expect(m?.guidance).toContain("bdz_seat_map");
  });

  test("combined-booking refusal maps to combined_unavailable", () => {
    const m = mapBdzErrorMessage(
      "Неуспешно получаване на запазени места! Причина: Няма достатъчно спални места от поисканата класа",
    );
    expect(m?.code).toBe("combined_unavailable");
    expect(m?.guidance).toContain("ONE at a time");
    expect(m?.guidance).toContain("round-trip discount");
  });

  test("unknown messages map to null", () => {
    expect(mapBdzErrorMessage("Some other failure")).toBeNull();
    expect(mapBdzErrorMessage("")).toBeNull();
  });
});

describe("handle() renders mapped errors (F5)", () => {
  test("no_free_seats error becomes a coded, actionable text result", async () => {
    const res = await handle(async () => {
      throw new BdzApiError(400, { message: "Няма намерени свободни места!" });
    });
    const text = res.content[0]!.text as string;
    expect(text).toContain("[no_free_seats]");
    expect(text).toContain("Няма намерени свободни места!");
    expect(text).toContain("Guidance:");
  });

  test("combined refusal keeps the recovery path in the message", async () => {
    const res = await handle(async () => {
      throw new BdzApiError(400, {
        message: "Неуспешно получаване на запазени места! Причина: Няма достатъчно спални места от поисканата класа",
      });
    });
    const text = res.content[0]!.text as string;
    expect(text).toContain("[combined_unavailable]");
    expect(text).toContain("ONE at a time");
  });

  test("unmapped errors keep the raw format", async () => {
    const res = await handle(async () => {
      throw new BdzApiError(500, { message: "Internal error" });
    });
    const text = res.content[0]!.text as string;
    expect(text).toContain("BDZ API error (HTTP 500)");
    expect(text).not.toContain("[");
  });
});
