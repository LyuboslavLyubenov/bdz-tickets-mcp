// T3 from PLAN-FIXES.md: replay the exact 2026-10-26 booking session payloads
// through the hardened code. One test per failure row in PLAN-FIXES section 1.
// The bar: every step where the real session went wrong now produces a refusal,
// a bookable:false, a direct link, or an expired_unpaid label.

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { BdzApiError, mapBdzErrorMessage } from "../src/api/errors.ts";
import { interpretCheckPayment } from "../src/domain/paystatus.ts";
import { beginPendingPurchase, clearPendingPurchase } from "../src/domain/session.ts";
import { stopAllPayFormServers } from "../src/api/payserver.ts";
import { createTicketImpl, paymentLinkImpl } from "../src/tools/purchase-write.ts";
import { quoteImpl } from "../src/tools/purchase-read.ts";
import { handle } from "../src/tools/common.ts";
import { installFakeBdz, jsonResponse, uninstallFakeBdz, type FakeRoute } from "./lib/fake-bdz.ts";

// ---- exact payloads from the 2026-10-26 session -----------------------------

const OUT_LEG = { route_id: 447159326, train_id: 11, date: "2026-10-28", seat_type_id: 13 as const, seat_id: 39015316 };
const RET_LEG = { route_id: 448909811, train_id: 12, date: "2026-10-29", seat_type_id: 13 as const, seat_id: 39025401 };
const PASSENGER = { names: "Любослав Любенов", gender: "m" as const, birth_date: "19.08.1996" };

const COMBINED_ERROR = {
  message: "Неуспешно получаване на запазени места! Причина: Няма достатъчно спални места от поисканата класа",
};
const NO_FREE_SEATS_ERROR = { message: "Няма намерени свободни места!" };

const RETURN_PREVIEW = {
  totalPrice: 20.2,
  ticketIDs: [67815938],
  passengersTickets: [
    {
      passengerId: 1,
      passengerNames: "Любослав Любенов",
      tariffFullText: "Билет по цени на редовна тарифа за пътуване в една посока",
      tariffShortText: "Редовна тарифа",
      seats: ["Спален вагон 2 клас + 7,67 евро", "Влак: БВ8627, Вагон: 41, Място: 33"],
      addons: [],
      ticketPrice: 20.2,
    },
  ],
};

const BORICA_GATEWAY = {
  url: "https://3dsgate.borica.bg/cgi-bin/cgi_link",
  formFields: {
    terminal: "V6200327",
    trtype: "1",
    amount: "20.20",
    currency: "EUR",
    order: "877196",
    desc: "ЖП Билет с трансакция: 0001877393/26.10.2026",
    timestamp: "20261026175601",
    nonce: "CCA41C0000000000A4FE59299B33DF08",
    merchant: "9200201070",
    mercH_NAME: "БДЖ ПП ЕООД",
    mercH_URL: "https://bileti.bdz.bg",
    email: "onlineticket@bdz.bg",
    "aD.CUST_BOR_ORDER_ID": "8771960000000001877393",
    country: "BG",
    mercH_GMT: "+03",
    addendum: "AD,TD",
    p_sign:
      "63B1F3F6A6C0E8160081B8CA6054F173FBB8011D5CAAD4ACA9B5B93B845B5DD3DF795657B24859BA3E9A9796DF45BB2B9CC8729E48773502D5AC83AA3AB23338942ADF765999A6626601E10117F037981F49223A170DECA4393F60CFB4A52CAA36D7C83E7DC5D9642B42506F16123C865A503C0FEF6D48236AEF04DC3D450AE296D0A92D0C702FB175D5C655961878C437BDFC60412043B7F7C1D6AA9771C23E3D7F9E655C779C19615547C40EB6F5FDBFD67A9588147E701CE53C76F561207006C3C3B8F789433ED17B8DB2523017EA56FF484EFE56032FECFE6EDAF45E02BB7350E7191DE263126DD3FE23F4E6FFF9D14F928C293D8F2AC3420870116A1121",
    m_info: "eyJjYXJkaG9sZGVyTmFtZSI6IkxZdUJPU0xBViBMWXVCRU5PViIsImVtYWlsIjoibF9seXViZW5vdkBtYWlsLmJnIn0=",
  },
};

const CHECKPAYMENT_RC24 = {
  action: "3", rc: "-24", statusmsg: ". ", terminal: "V6200327", trtype: "90",
  amount: "", currency: "USD", order: "877196", approval: "", rrn: "", inT_REF: "",
};

// What BDZ's tickets page actually showed at 19:56 on 2026-10-26: only the
// return leg pending — the outbound had already been released.
const TICKETS_PAGE_AFTER_RELEASE = {
  tickets: [
    {
      id: 67815938, uId: "044012241661", route: "СОФИЯ - БУРГАС",
      status: "очаква потвърждение за плащане", statusID: 11, price: 20.2,
      departureDate: "2026-10-29T22:50:00", returnDate: null,
      createDate: "2026-10-26T19:55:44.723566", transactionID: 1877196,
      passenger: "Любослав Любенов", canReturnByPOS: false,
    },
  ],
  totalPages: 9,
};

const routes: FakeRoute[] = [
  {
    match: (u) => u.includes("api/schema/info"),
    respond: () => jsonResponse(NO_FREE_SEATS_ERROR, 400),
  },
  { match: (u) => u.includes("onlyPrice=true"), respond: () => jsonResponse(36.16) },
  { match: (u) => u.includes("onlyPrice=false"), respond: () => jsonResponse(RETURN_PREVIEW) },
  { match: (u) => u.includes("GetUserTickets"), respond: () => jsonResponse(TICKETS_PAGE_AFTER_RELEASE) },
  { match: (u) => u.includes("GetTicketPaymentTransaction"), respond: () => jsonResponse({ transactionID: 1877196 }) },
  { match: (u) => u.includes("GetEpayRequest"), respond: () => jsonResponse({ status: 301, url: "https://pay.epay.bg/checkout?txn=1877196" }) },
  { match: (u) => u.includes("GetBoricaRequest"), respond: () => jsonResponse(BORICA_GATEWAY) },
  { match: (u) => u.includes("CheckPayment"), respond: () => jsonResponse(CHECKPAYMENT_RC24) },
];

afterAll(() => {
  uninstallFakeBdz();
  stopAllPayFormServers();
});

describe("replay of the 2026-10-26 failed booking (T3 gate)", () => {
  test("row 4: the 36.16 quote for sold-out sleeper-1st is now flagged theoretical", async () => {
    installFakeBdz(routes);
    const q = await quoteImpl({
      legs: [
        { route_id: OUT_LEG.route_id, train_id: OUT_LEG.train_id, date: OUT_LEG.date, seat_type_id: 10 as const },
        { route_id: RET_LEG.route_id, train_id: RET_LEG.train_id, date: RET_LEG.date, seat_type_id: 10 as const },
      ],
      passengers: [PASSENGER],
      check_availability: true,
      stations: ["БУРГАС - СОФИЯ", "СОФИЯ - БУРГАС"],
    });
    expect(q.total_price).toBe(36.16);
    expect(q.availability.bookable).toBe(false);
    expect(q.availability.note).toContain("THEORETICAL");
  });

  test("row 3: the combined create refusal now carries recovery guidance", async () => {
    const res = await handle(async () => {
      throw new BdzApiError(400, COMBINED_ERROR);
    });
    const text = res.content[0]!.text as string;
    expect(text).toContain("[combined_unavailable]");
    expect(text).toContain("ONE at a time");
    expect(text).toContain("round-trip discount");
  });

  test("row 5: the seat-map sold-out 400 maps to no_free_seats, not a glitch", () => {
    const m = mapBdzErrorMessage(NO_FREE_SEATS_ERROR.message);
    expect(m?.code).toBe("no_free_seats");
    expect(m?.meaning).toContain("Sold out");
  });

  test("row 2: creating a second leg while the first is pending refuses (silent release caught)", async () => {
    installFakeBdz(routes);
    clearPendingPurchase();
    // Session state right after the outbound create on 2026-10-26: ticket 67815925 pending.
    beginPendingPurchase({ ticket_ids: [67815925], total_price: 20.2, created_at_ms: Date.now() });
    const refused = await createTicketImpl({
      legs: [RET_LEG],
      passengers: [PASSENGER],
      confirm: true,
    });
    expect(refused.created).toBe(false);
    expect(refused.reason).toContain("67815925");
    expect(refused.reason).toContain("supersede:true");
    // and the pending slot still points at the outbound — nothing was destroyed
    expect(beginPendingPurchase({ ticket_ids: [67815938], total_price: 20.2, created_at_ms: Date.now() }).superseded?.ticket_ids).toEqual([67815925]);
    clearPendingPurchase();
  });

  test("row 1: BORICA now yields one clickable local link, not a bare gateway URL", async () => {
    installFakeBdz(routes);
    beginPendingPurchase({ ticket_ids: [67815938], total_price: 20.2, created_at_ms: Date.now() });
    const link = await paymentLinkImpl({ provider: "borica", confirm: true });
    expect(link.started).toBe(true);
    expect(link.direct_link).toBe(true);
    expect(String(link.pay_url)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/pay\/1877196$/);
    // the hosted page carries the exact signed fields from that session
    const page = await fetch(String(link.pay_url)).then((r) => r.text());
    expect(page).toContain('action="https://3dsgate.borica.bg/cgi-bin/cgi_link"');
    expect(page).toContain('name="terminal" value="V6200327"');
    expect(page).toContain('name="order" value="877196"');
    expect(page).toContain("document.forms[0].submit()");
    // and provider auto would have avoided BORICA entirely
    const auto = await paymentLinkImpl({ provider: "auto", confirm: true });
    expect(auto.provider).toBe("epay");
    expect(auto.pay_url).toBe("https://pay.epay.bg/checkout?txn=1877196");
  });

  test("row 7: rc -24 is decoded as expired-unpaid, not a card decline", () => {
    const r = interpretCheckPayment(CHECKPAYMENT_RC24);
    expect(r.status).toBe("expired_unpaid");
    expect(r.detail).toContain("Not a card decline");
    expect(r.detail).toContain("10 minutes");
  });

  test("row 6: the purchase flow rules exist in AGENTS.md", () => {
    const agents = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
    expect(agents).toContain("## Purchase flow rules");
    expect(agents).toContain('provider: "auto"');
    expect(agents).toContain("One leg at a time");
  });
});
