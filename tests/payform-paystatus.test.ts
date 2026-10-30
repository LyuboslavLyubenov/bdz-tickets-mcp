import { describe, expect, test } from "bun:test";
import { buildPayFormPage } from "../src/domain/payform.ts";
import { interpretCheckPayment } from "../src/domain/paystatus.ts";

// Exact payload received on 2026-10-26 for the return leg of the Burgas trip.
const SESSION_RC24 = {
  action: "3",
  rc: "-24",
  statusmsg: ". ",
  terminal: "V6200327",
  trtype: "90",
  amount: "",
  currency: "USD",
  order: "877196",
  approval: "",
  rrn: "",
};

describe("buildPayFormPage (F2 hosted form page)", () => {
  const fields = {
    terminal: "V6200327",
    desc: "ЖП Билет с трансакция: 0001877393/26.10.2026",
    p_sign: "abc123",
    tricky: 'quote"and&lt;tag',
  };

  test("auto-submits all fields to the gateway URL", () => {
    const html = buildPayFormPage("https://3dsgate.borica.bg/cgi-bin/cgi_link", fields);
    expect(html).toContain('action="https://3dsgate.borica.bg/cgi-bin/cgi_link"');
    expect(html).toContain('name="terminal" value="V6200327"');
    expect(html).toContain('name="p_sign" value="abc123"');
    expect(html).toContain('name="desc"');
    expect(html).toContain("document.forms[0].submit()");
  });

  test("escapes attribute-hostile values", () => {
    const html = buildPayFormPage("https://gw.example", { tricky: fields.tricky });
    expect(html).toContain("quote&quot;and&amp;lt;tag");
    expect(html).not.toContain('value="quote"');
  });
});

describe("interpretCheckPayment (F5 rc decoding)", () => {
  test("rc -24 from the failed session means expired, not a card decline", () => {
    const r = interpretCheckPayment(SESSION_RC24);
    expect(r.status).toBe("expired_unpaid");
    expect(r.rc).toBe(-24);
    expect(r.detail).toContain("Not a card decline");
    expect(r.detail).toContain("Re-search");
  });

  test("rc 0 with approval code means paid", () => {
    const r = interpretCheckPayment({ ...SESSION_RC24, rc: "0", approval: "123456", amount: "20.20" });
    expect(r.status).toBe("paid");
  });

  test("rc 0 without approval stays unconfirmed", () => {
    expect(interpretCheckPayment({ rc: "0", approval: "" }).status).toBe("pending_or_unconfirmed");
  });

  test("other negative codes are failures, not expiry", () => {
    const r = interpretCheckPayment({ rc: -3, approval: "" });
    expect(r.status).toBe("failed");
    expect(r.detail).toContain("-3");
  });

  test("non-object payloads are unknown", () => {
    expect(interpretCheckPayment(null).status).toBe("unknown");
    expect(interpretCheckPayment("weird").status).toBe("unknown");
    expect(interpretCheckPayment({ nope: 1 }).status).toBe("unknown");
  });
});
