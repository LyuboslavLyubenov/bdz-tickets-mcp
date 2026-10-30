// T2 from PLAN-FIXES.md: the corrected booking flow, run offline against the
// exact API responses captured during the 2026-10-26 session.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { clearPendingPurchase, getPendingPurchase, setPendingPurchase } from "../src/domain/session.ts";
import { stopAllPayFormServers } from "../src/api/payserver.ts";
import { createTicketImpl, paymentLinkImpl, checkPaymentImpl } from "../src/tools/purchase-write.ts";
import { quoteImpl } from "../src/tools/purchase-read.ts";
import { bodyOf, installFakeBdz, jsonResponse, uninstallFakeBdz, type FakeRoute } from "./lib/fake-bdz.ts";
import type { LegArgs } from "../src/tools/shapes.ts";

// ---- fixtures captured from the live session --------------------------------

const OUT = { route_id: 447159326, train_id: 11, date: "2026-10-28", stations: "БУРГАС - СОФИЯ" };
const RET = { route_id: 448909811, train_id: 12, date: "2026-10-29", stations: "СОФИЯ - БУРГАС" };

const seatMap = (free: [number, number][]) => ({
  "0": {
    typeId: 80,
    seats: [
      ...free.map(([seatId, number]) => ({ seatId, seatNumber: number, seatState: 0, genderId: null })),
      ...Array.from({ length: 28 }, (_, i) => ({ seatId: 900000 + i, seatNumber: i + 1, seatState: 1, genderId: null })),
    ],
  },
});

const preview = (ticketId: number, seat: number, train: string) => ({
  totalPrice: 20.2,
  ticketIDs: [ticketId],
  passengersTickets: [
    {
      passengerId: 1,
      passengerNames: "Любослав Любенов",
      tariffFullText: "Билет по цени на редовна тарифа за пътуване в една посока",
      tariffShortText: "Редовна тарифа",
      seats: ["Спален вагон 2 клас + 7,67 евро", `Влак: БВ${train}, Вагон: 41, Място: ${seat}`],
      addons: [],
      ticketPrice: 20.2,
    },
  ],
});

const boricaFormFields = {
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
  p_sign: "63B1F3F6",
  m_info: "eyJjYXJkaG9sZGVyTmFtZSI6IkxZdUJPU0xBViBMWXVCRU5PViIsImVtYWlsIjoibF9seXViZW5vdkBtYWlsLmJnIn0=",
};

// Mutable state the router reads, so tests can change what BDZ "sees".
const state = {
  pendingTickets: [] as { id: number; statusID: number }[],
  createResponses: [] as Response[],
};

const passenger = { names: "Любослав Любенов", gender: "m" as const, birth_date: "19.08.1996" };

const routes: FakeRoute[] = [
  {
    match: (u) => u.includes("api/Ticket/GetTicket?onlyPrice=true"),
    respond: (_u, init) => {
      const seatType = bodyOf(init).passengers[0]?.trains[0]?.seat_type_id;
      const total = seatType === 10 ? 36.16 : seatType === 23 ? 16.72 : 27.87;
      return jsonResponse(total);
    },
  },
  {
    match: (u) => u.includes("api/schema/info"),
    respond: (_u, init) => {
      const body = bodyOf(init);
      if (body.route === OUT.route_id && body.people[0]?.seatTypeId === 13)
        return jsonResponse(seatMap([[39015316, 23], [39015319, 33]]));
      if (body.route === RET.route_id && body.people[0]?.seatTypeId === 13)
        return jsonResponse(seatMap([[39025401, 33], [39025406, 53], [39025416, 83]]));
      return jsonResponse({ message: "Няма намерени свободни места!" }, 400);
    },
  },
  {
    match: (u) => u.includes("api/Ticket/GetTicket?onlyPrice=false"),
    respond: () => state.createResponses.shift() ?? jsonResponse({ unexpected: true }, 500),
  },
  {
    match: (u) => u.includes("api/Ticket/GetUserTickets"),
    respond: () =>
      jsonResponse({
        tickets: state.pendingTickets.map((t) => ({
          id: t.id,
          uId: "044012241661",
          route: "СОФИЯ - БУРГАС",
          status: "очаква потвърждение за плащане",
          statusID: t.statusID,
          price: 20.2,
          departureDate: "2026-10-29T22:50:00",
          returnDate: null,
          createDate: "2026-10-26T19:55:44.723566",
          transactionID: 1877196,
          passenger: "Любослав Любенов",
          canReturnByPOS: false,
        })),
        totalPages: 1,
      }),
  },
  {
    match: (u) => u.includes("GetTicketPaymentTransaction"),
    respond: () => jsonResponse({ transactionID: 1877196, description: "ЖП Билет" }),
  },
  {
    match: (u) => u.includes("GetEpayRequest"),
    respond: () => jsonResponse({ status: 301, url: "https://pay.epay.bg/checkout?txn=1877196" }),
  },
  {
    match: (u) => u.includes("GetBoricaRequest"),
    respond: () =>
      jsonResponse({ url: "https://3dsgate.borica.bg/cgi-bin/cgi_link", formFields: boricaFormFields }),
  },
  {
    match: (u) => u.includes("CheckPayment"),
    respond: () =>
      jsonResponse({
        action: "3", rc: "-24", statusmsg: ". ", terminal: "V6200327", trtype: "90",
        amount: "", currency: "USD", order: "877196", approval: "", rrn: "",
      }),
  },
];

const sleeperLeg = (leg: typeof OUT, seatId?: number): LegArgs => ({
  route_id: leg.route_id,
  train_id: leg.train_id,
  date: leg.date,
  seat_type_id: 13,
  ...(seatId ? { seat_id: seatId } : {}),
});

beforeEach(() => {
  clearPendingPurchase();
  state.pendingTickets = [];
  state.createResponses = [];
});

afterAll(() => {
  uninstallFakeBdz();
  stopAllPayFormServers();
});

describe("corrected round-trip flow over the 2026-10-26 fixtures (T2)", () => {
  test("sleeper-1st quote is cross-checked as sold out (F4)", async () => {
    installFakeBdz(routes);
    // Both sleeper-1st legs hit the "Няма намерени свободни места!" 400 fixture,
    // exactly what the live session saw — but now the quote flags it.
    const soldOut = await quoteImpl({
      legs: [
        { route_id: OUT.route_id, train_id: OUT.train_id, date: OUT.date, seat_type_id: 10 as const },
        { route_id: RET.route_id, train_id: RET.train_id, date: RET.date, seat_type_id: 10 as const },
      ],
      passengers: [passenger],
      check_availability: true,
      stations: [OUT.stations, RET.stations],
    });
    expect(soldOut.total_price).toBe(36.16); // exactly what the session showed…
    expect(soldOut.availability.bookable).toBe(false); // …but now flagged unbookable
    expect(soldOut.availability.price_is_theoretical).toBe(true);
  });

  test("sleeper-2nd quote is bookable with per-leg free-seat counts (F4)", async () => {
    installFakeBdz(routes);
    const q = await quoteImpl({
      legs: [sleeperLeg(OUT), sleeperLeg(RET)],
      passengers: [passenger],
      check_availability: true,
      stations: [OUT.stations, RET.stations],
    });
    expect(q.availability.bookable).toBe(true);
    expect(q.availability.legs).toEqual([
      { free_seats: 2, available: true },
      { free_seats: 3, available: true },
    ]);
  });

  test("combined two-leg create is refused by BDZ and mapped as combined_unavailable (F5)", async () => {
    installFakeBdz(routes);
    state.createResponses.push(
      jsonResponse(
        { message: "Неуспешно получаване на запазени места! Причина: Няма достатъчно спални места от поисканата класа" },
        400,
      ),
    );
    try {
      await createTicketImpl({
        legs: [sleeperLeg(OUT, 39015316), sleeperLeg(RET, 39025401)],
        passengers: [passenger],
        confirm: true,
      });
      throw new Error("combined create should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("Няма достатъчно спални места от поисканата класа");
    }
  });

  test("second create without supersede refuses; with supersede warns (F1)", async () => {
    installFakeBdz(routes);
    state.createResponses.push(jsonResponse(preview(67815925, 23, "8626")));
    const first = await createTicketImpl({
      legs: [sleeperLeg(OUT, 39015316)],
      passengers: [passenger],
      confirm: true,
    });
    expect(first.created).toBe(true);

    state.createResponses.push(jsonResponse(preview(67815938, 33, "8627")));
    const refused = await createTicketImpl({
      legs: [sleeperLeg(RET, 39025401)],
      passengers: [passenger],
      confirm: true,
    });
    expect(refused.created).toBe(false);
    expect(refused.reason).toContain("ONE pending purchase");

    const superseded = await createTicketImpl({
      legs: [sleeperLeg(RET, 39025401)],
      passengers: [passenger],
      confirm: true,
      supersede: true,
    });
    expect(superseded.created).toBe(true);
    expect(superseded.superseded_warning).toContain("67815925");
    expect(superseded.superseded_warning).toContain("round-trip discount");
    expect(getPendingPurchase()?.ticket_ids).toEqual([67815938]);
  });

  test("coverage check refuses when a pending ticket vanished from BDZ (F3)", async () => {
    installFakeBdz(routes);
    // pending session state says 67815938 exists, but BDZ no longer lists it as pending
    setPendingPurchase({ ticket_ids: [67815938], total_price: 20.2, created_at_ms: Date.now() });
    state.pendingTickets = [];
    try {
      await paymentLinkImpl({ provider: "auto", confirm: true });
      throw new Error("coverage check should have refused");
    } catch (e) {
      expect((e as Error).message).toContain("Coverage check failed");
      expect((e as Error).message).toContain("67815938");
      expect((e as Error).message).toContain("ONE pending purchase");
    }
  });

  test("provider auto pays through ePay with a directly openable link (F2)", async () => {
    installFakeBdz(routes);
    setPendingPurchase({ ticket_ids: [67815938], total_price: 20.2, created_at_ms: Date.now() });
    state.pendingTickets = [{ id: 67815938, statusID: 11 }];
    const link = await paymentLinkImpl({ provider: "auto", confirm: true });
    expect(link.started).toBe(true);
    expect(link.provider).toBe("epay");
    expect(link.direct_link).toBe(true);
    expect(link.pay_url).toBe("https://pay.epay.bg/checkout?txn=1877196");
    expect(link.tickets_covered).toEqual([67815938]);
    expect(link.minutes_left_to_pay).toBeGreaterThan(0);
  });

  test("provider borica serves a local clickable form page (F2)", async () => {
    installFakeBdz(routes);
    setPendingPurchase({ ticket_ids: [67815938], total_price: 20.2, created_at_ms: Date.now() });
    state.pendingTickets = [{ id: 67815938, statusID: 11 }];
    const link = await paymentLinkImpl({ provider: "borica", confirm: true });
    expect(link.provider).toBe("borica");
    expect(link.direct_link).toBe(true);
    expect(String(link.pay_url)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/pay\/1877196$/);
    expect(link.pay_url).not.toBe("https://3dsgate.borica.bg/cgi-bin/cgi_link");
    const page = await fetch(String(link.pay_url)).then((r) => r.text());
    expect(page).toContain('action="https://3dsgate.borica.bg/cgi-bin/cgi_link"');
    expect(page).toContain('name="p_sign"');
    expect(page).toContain('name="terminal" value="V6200327"');
    expect(page).toContain("document.forms[0].submit()");
  });

  test("check_payment decodes rc -24 as expired-unpaid, not a card decline (F5)", async () => {
    installFakeBdz(routes);
    const r = await checkPaymentImpl({ transaction_id: 1877196 });
    expect(r.interpretation.status).toBe("expired_unpaid");
    expect(r.interpretation.detail).toContain("Not a card decline");
  });
});
