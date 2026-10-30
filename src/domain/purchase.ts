// Pure builders for the GetTicket payload — no I/O, fully unit-testable.

import { SESSION_TTL_MS } from "./session.ts";

export type PassengerInput = {
  names: string;
  gender: "m" | "f";
  /** "DD.MM.YYYY" — required by BDZ for sleeper reservations. */
  birth_date?: string;
  /** id from nomenclatures.discountCardTypes; omit or -1 = no discount. */
  discount_card_type_id?: number;
  /** Card document number (12–13 digits) — required whenever a discount card is set. */
  discount_number?: string;
  /** Adds the bicycle talon addon (id 46) to every train leg. */
  bike?: boolean;
};

export type TicketLegInput = {
  route_id: number; // from search — fresh per search
  train_id: number;
  date: string; // YYYY-MM-DD
  seat_type_id: number; // 23 seated-1st, 25 seated-2nd, 10 sleeper-1st, 13 sleeper-2nd, 16 sleeper-business
  seat_id?: number; // from seat map; omit for auto-assignment
};

const BIKE_ADDON_ID = 46;

/** seat_type → BDZ ticket_class (1 = Първа, 2 = Втора). */
export function ticketClassForSeatType(seatTypeId: number): 1 | 2 {
  return [25, 13].includes(seatTypeId) ? 2 : 1;
}

/** "01.01.1990" → "01/1/1990" (the exact format the site's own client sends). */
export function formatBirthDate(input: string): string {
  const m = input.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m?.[1] || !m[2] || !m[3]) throw new Error(`birth_date must be DD.MM.YYYY, got "${input}"`);
  const [, d, mon, y] = m;
  return `${d!.padStart(2, "0")}/${Number(mon)}/${y}`;
}

export type TicketObjectInput = {
  legs: TicketLegInput[];
  passengers: PassengerInput[];
  are_together?: boolean;
};

/**
 * Build the ticket object accepted by
 * POST api/Ticket/GetTicket?onlyPrice=true|false.
 */
export function buildTicketObject(input: TicketObjectInput): Record<string, unknown> {
  if (!input.legs.length) throw new Error("At least one leg is required.");
  if (!input.passengers.length) throw new Error("At least one passenger is required.");
  if (input.passengers.length > 5) throw new Error("BDZ allows at most 5 tickets per session.");

  const passengers = input.passengers.map((p, index) => {
    if (p.discount_number && !p.discount_card_type_id) {
      throw new Error(`Passenger ${index + 1} (${p.names}): discount_number needs discount_card_type_id.`);
    }
    if (p.discount_card_type_id && p.discount_card_type_id !== -1 && p.discount_card_type_id !== 50 && !p.discount_number) {
      throw new Error(
        `Passenger ${index + 1} (${p.names}): a discount card number is required for the chosen discount card.`,
      );
    }
    const trains = input.legs.map((leg) => ({
      addons: p.bike ? [{ id: BIKE_ADDON_ID }] : [],
      route_id: leg.route_id,
      train_id: leg.train_id,
      seat_type_id: leg.seat_type_id,
      ...(leg.seat_id !== undefined ? { seat_id: leg.seat_id } : {}),
    }));
    return {
      names: p.names,
      pet: false,
      trains,
      type_id: String(p.discount_card_type_id ?? -1),
      gender: p.gender,
      egn: "",
      birth_date: p.birth_date ? formatBirthDate(p.birth_date) : "",
      discount: p.discount_number ?? "",
      addons: [],
      price: "--.--",
      id: index + 1,
    };
  });

  return {
    paydesk_id: "268",
    ticket_class: ticketClassForSeatType(input.legs[0]!.seat_type_id),
    ticket_type_id: 1,
    trip_type_id: 1,
    train_id: 0,
    to_station_id: 0,
    form_station_id: "",
    tickat_valid_to: "",
    groupRequestId: "",
    areTogether: input.are_together ?? true,
    passengers,
    routes: input.legs.map((leg, i) => ({
      is_return: String(i > 0),
      route_date: leg.date,
      route_id: leg.route_id,
    })),
  };
}

/** Seat-map request payload for POST api/schema/info. */
export function buildSeatMapRequest(
  legs: { route_id: number; train_id: number; date: string; seat_type_id: number }[],
  passengers: PassengerInput[],
  trainName: string,
): Record<string, unknown> {
  const leg = legs[0];
  if (!leg) throw new Error("At least one leg is required.");
  return {
    date: leg.date,
    name: trainName,
    route: leg.route_id,
    train: leg.train_id,
    people: passengers.map((p, i) => ({
      gender: p.gender,
      id: i + 1,
      name: p.names,
      type: Number(String(p.discount_card_type_id ?? -1)) < 0 ? 0 : p.discount_card_type_id!,
      seatTypeId: leg.seat_type_id,
    })),
  };
}

// ---- create-supersession decision (2026-10-26 lesson) ----------------------
// BDZ holds one pending purchase per account; a second create releases the first.

export type ExistingPurchase = {
  ticket_ids: number[];
  total_price: number;
  created_at_ms: number;
};

export type CreateDecision =
  | { allowed: true; superseded_ticket_ids: number[] | null; warning: string | null }
  | { allowed: false; reason: string };

/** Pure pre-flight for bdz_create_ticket: refuse or warn before any BDZ call. */
export function decideCreate(
  existing: ExistingPurchase | null,
  opts: { supersede?: boolean; nowMs?: number } = {},
): CreateDecision {
  const now = opts.nowMs ?? Date.now();
  const live =
    !!existing && existing.ticket_ids.length > 0 && now - existing.created_at_ms <= SESSION_TTL_MS;
  if (!existing || !live) {
    return { allowed: true, superseded_ticket_ids: null, warning: null };
  }
  const ids = existing.ticket_ids;
  if (!opts.supersede) {
    return {
      allowed: false,
      reason:
        `A pending purchase already exists (ticket(s) ${ids.join(", ")}, still inside its ~10-minute ` +
        "payment window). BDZ holds only ONE pending purchase per account, so creating a new reservation " +
        "would silently release it. Pay it via bdz_payment_link, or let it expire (~10 minutes, no charge), " +
        "or re-confirm the price with the user and call again with supersede:true.",
    };
  }
  return {
    allowed: true,
    superseded_ticket_ids: ids,
    warning:
      `Superseded pending ticket(s) ${ids.join(", ")}: BDZ has released them. ` +
      "Booking legs separately forfeits the round-trip discount (~30% off the return leg, combined " +
      "bookings only), so the new total will differ from the earlier round-trip quote. Re-quote and " +
      "re-confirm the price with the user before generating the payment link.",
  };
}

// ---- quote availability annotation (2026-10-26 lesson) ---------------------
// Quotes price combinations the booking API may refuse; annotate honestly.

export type LegAvailability = { free_seats: number; available: boolean };

export function annotateQuoteLegs(availabilities: LegAvailability[]) {
  const bookable = availabilities.length > 0 && availabilities.every((a) => a.available);
  return {
    legs: availabilities,
    bookable,
    price_is_theoretical: !bookable,
    note: bookable
      ? "Every leg has free seats for this reservation type. The ~30% return discount applies only when both legs are booked in ONE create_ticket call."
      : "PRICE IS THEORETICAL: at least one leg is sold out for this reservation type. Do not present this total as bookable; pick another seat type, train or date.",
  };
}
