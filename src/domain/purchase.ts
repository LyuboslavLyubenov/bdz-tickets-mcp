// Pure builders for the GetTicket payload — no I/O, fully unit-testable.

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
