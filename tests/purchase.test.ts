import { describe, expect, test } from "bun:test";
import { buildSeatMapRequest, buildTicketObject, formatBirthDate, ticketClassForSeatType } from "../src/domain/purchase.ts";
import type { Nomenclatures } from "../src/api/endpoints.ts";
import { findStations, resolveStation, StationResolutionError } from "../src/domain/nomenclatures-cache.ts";

const noms: Nomenclatures = {
  stations: [
    { id: 2, name: "СОФИЯ", abbr: "СФ", uic: "160002" },
    { id: 54, name: "СОФИЯ СЕВЕР", abbr: "СФВ", uic: "260018" },
    { id: 3, name: "ПЛОВДИВ", abbr: "ПО", uic: "180000" },
    { id: 115, name: "ВАГОНО-РЕМОНТНО ДЕПО ПЛОВДИВ", abbr: "ВРД", uic: "180075" },
  ],
  seats: [],
  classes: [],
  discountCardTypes: [],
  addons: [],
};

describe("resolveStation", () => {
  test("numeric id resolves directly", () => {
    expect(resolveStation(noms, 2).name).toBe("СОФИЯ");
    expect(resolveStation(noms, "3").name).toBe("ПЛОВДИВ");
  });

  test("unique fragment resolves", () => {
    expect(resolveStation(noms, "София Север").id).toBe(54);
  });

  test("exact match wins over partial matches", () => {
    expect(resolveStation(noms, "Пловдив").id).toBe(3);
  });

  test("ambiguous fragment throws with candidates", () => {
    expect(() => resolveStation(noms, "плов")).toThrow(StationResolutionError);
    try {
      resolveStation(noms, "плов");
    } catch (e) {
      expect((e as StationResolutionError).candidates.length).toBe(2);
    }
  });

  test("unknown name throws", () => {
    expect(() => resolveStation(noms, "Нью Йорк")).toThrow(/No BDZ station/);
  });

  test("findStations is case-insensitive", () => {
    expect(findStations(noms, "софия")).toHaveLength(2);
  });
});

describe("buildTicketObject", () => {
  const leg = { route_id: 441650398, train_id: 9, date: "2026-10-11", seat_type_id: 25 };

  test("matches the payload the live API accepted during recon", () => {
    const t = buildTicketObject({
      legs: [leg],
      passengers: [{ names: "Любослав Любенов", gender: "m", birth_date: "01.01.1990" }],
    });
    expect(t).toEqual({
      paydesk_id: "268",
      ticket_class: 2,
      ticket_type_id: 1,
      trip_type_id: 1,
      train_id: 0,
      to_station_id: 0,
      form_station_id: "",
      tickat_valid_to: "",
      groupRequestId: "",
      areTogether: true,
      passengers: [
        {
          names: "Любослав Любенов",
          pet: false,
          trains: [{ addons: [], route_id: 441650398, train_id: 9, seat_type_id: 25 }],
          type_id: "-1",
          gender: "m",
          egn: "",
          birth_date: "01/1/1990",
          discount: "",
          addons: [],
          price: "--.--",
          id: 1,
        },
      ],
      routes: [{ is_return: "false", route_date: "2026-10-11", route_id: 441650398 }],
    });
  });

  test("seat_id is attached when provided", () => {
    const t = buildTicketObject({
      legs: [{ ...leg, seat_id: 38972179 }],
      passengers: [{ names: "Test", gender: "f" }],
    });
    const trains = (t.passengers as any[])[0]!.trains as any[];
    expect(trains[0]!.seat_id).toBe(38972179);
  });

  test("round trip produces two routes and two trains per passenger", () => {
    const back = { route_id: 441650999, train_id: 10, date: "2026-10-12", seat_type_id: 23 };
    const t = buildTicketObject({
      legs: [leg, back],
      passengers: [{ names: "Test", gender: "m" }],
    });
    expect(t.routes).toEqual([
      { is_return: "false", route_date: "2026-10-11", route_id: 441650398 },
      { is_return: "true", route_date: "2026-10-12", route_id: 441650999 },
    ]);
    expect(((t.passengers as any[])[0]!.trains as any[]).length).toBe(2);
    expect(t.ticket_class).toBe(2); // derived from the FIRST leg (seat_type 25)
  });

  test("discount card maps to type_id + discount number", () => {
    const t = buildTicketObject({
      legs: [leg],
      passengers: [{ names: "Test", gender: "m", discount_card_type_id: 13, discount_number: "1234567890123" }],
    });
    const p = (t.passengers as any[])[0]!;
    expect(p.type_id).toBe("13");
    expect(p.discount).toBe("1234567890123");
  });

  test("discount number without card type is rejected", () => {
    expect(() =>
      buildTicketObject({ legs: [leg], passengers: [{ names: "T", gender: "m", discount_number: "123" }] }),
    ).toThrow(/discount_number needs discount_card_type_id/);
  });

  test("discount card without number is rejected (except Дете под 7 / none)", () => {
    expect(() =>
      buildTicketObject({ legs: [leg], passengers: [{ names: "T", gender: "m", discount_card_type_id: 13 }] }),
    ).toThrow(/discount card number is required/);
    // Дете под 7 (id 50) needs no number
    const t = buildTicketObject({
      legs: [leg],
      passengers: [{ names: "T", gender: "m", discount_card_type_id: 50 }],
    });
    expect(((t.passengers as any[])[0]!).type_id).toBe("50");
  });

  test("bike adds addon 46 to each train", () => {
    const t = buildTicketObject({
      legs: [leg, { ...leg, route_id: 2 }],
      passengers: [{ names: "T", gender: "m", bike: true }],
    });
    const trains = (t.passengers as any[])[0]!.trains as any[];
    expect(trains.every((tr) => tr.addons[0]?.id === 46)).toBe(true);
  });

  test("max 5 passengers", () => {
    const ps = Array.from({ length: 6 }, (_, i) => ({ names: `P${i}`, gender: "m" as const }));
    expect(() => buildTicketObject({ legs: [leg], passengers: ps })).toThrow(/at most 5/);
  });
});

describe("helpers", () => {
  test("ticketClassForSeatType", () => {
    expect(ticketClassForSeatType(23)).toBe(1);
    expect(ticketClassForSeatType(25)).toBe(2);
    expect(ticketClassForSeatType(10)).toBe(1);
    expect(ticketClassForSeatType(13)).toBe(2);
    expect(ticketClassForSeatType(16)).toBe(1);
  });

  test("formatBirthDate mirrors the site format", () => {
    expect(formatBirthDate("01.01.1990")).toBe("01/1/1990");
    expect(formatBirthDate("5.12.1985")).toBe("05/12/1985");
    expect(() => formatBirthDate("1990-01-01")).toThrow(/DD\.MM\.YYYY/);
  });

  test("buildSeatMapRequest shape", () => {
    const req = buildSeatMapRequest(
      [{ route_id: 441650398, train_id: 9, date: "2026-10-11", seat_type_id: 23 }],
      [{ names: "Любослав Любенов", gender: "m" }],
      "СОФИЯ - ПЛОВДИВ",
    );
    expect(req).toEqual({
      date: "2026-10-11",
      name: "СОФИЯ - ПЛОВДИВ",
      route: 441650398,
      train: 9,
      people: [{ gender: "m", id: 1, name: "Любослав Любенов", type: 0, seatTypeId: 23 }],
    });
  });
});
