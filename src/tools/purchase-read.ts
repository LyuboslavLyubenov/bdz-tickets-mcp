import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSeatMap, quotePrice } from "../api/endpoints.ts";
import { buildSeatMapRequest, buildTicketObject, ticketClassForSeatType } from "../domain/purchase.ts";
import { handle } from "./common.ts";
import { legSchema, passengerSchema, type LegArgs, type PassengerArgs } from "./shapes.ts";

export function registerSeatMapTool(server: McpServer) {
  server.registerTool(
    "bdz_seat_map",
    {
      title: "BDZ seat map",
      description:
        "Live coach/seat availability for one train: which seats are free (state 'free') or taken. " +
        "Needs route_id + train_id + the train's 'stations' string from bdz_search_routes. " +
        "Returns seatId values usable in bdz_create_ticket. Seat availability changes fast — call right before buying.",
      inputSchema: {
        route_id: z.number().int(),
        train_id: z.number().int(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD."),
        seat_type_id: z
          .union([z.literal(23), z.literal(25), z.literal(10), z.literal(13), z.literal(16)])
          .describe("Reservation type: 23 seated-1st, 25 seated-2nd, 10 sleeper-1st, 13 sleeper-2nd, 16 sleeper-business."),
        stations: z
          .string()
          .describe("The train's 'stations' string from bdz_search_routes (e.g. 'СОФИЯ - ПЛОВДИВ')."),
        passenger_count: z.number().int().min(1).max(5).default(1).describe("How many seats you plan to take (only affects the query payload)."),
      },
    },
    async ({ route_id, train_id, date, seat_type_id, stations, passenger_count }) =>
      handle(async () => {
        const people = Array.from({ length: passenger_count }, (_, i) => ({
          gender: "m",
          id: i + 1,
          name: `Passenger ${i + 1}`,
          type: 0,
          seatTypeId: seat_type_id,
        }));
        const raw = await getSeatMap({
          date,
          name: stations,
          route: route_id,
          train: train_id,
          people,
        });
        const coaches = Object.entries(raw).map(([coachIndex, coach]) => ({
          coach: Number(coachIndex) + 1,
          coach_type_id: coach.typeId,
          free_seats: coach.seats
            .filter((s) => s.seatState === 0)
            .map((s) => ({ seat_id: s.seatId, number: s.seatNumber })),
          taken_count: coach.seats.filter((s) => s.seatState !== 0).length,
        }));
        const totalFree = coaches.reduce((n, c) => n + c.free_seats.length, 0);
        return {
          route_id,
          train_id,
          date,
          seat_type_id,
          total_free_seats: totalFree,
          coaches,
          note: totalFree
            ? "Pass seat_id values to bdz_quote / bdz_create_ticket. Omitting seat_id lets BDZ auto-assign."
            : "No free seats for this reservation type — try another train or seat type.",
        };
      }),
  );
}

export function registerQuoteTool(server: McpServer) {
  server.registerTool(
    "bdz_quote",
    {
      title: "BDZ price quote",
      description:
        "Exact total price (EUR) for a set of legs × passengers. Creates nothing — safe to call any time. " +
        "Derives the travel class from seat_type_id (23/10/16 → 1st, 25/13 → 2nd).",
      inputSchema: {
        legs: z.array(legSchema).min(1).max(2).describe("Outbound leg, plus the return leg for round trips."),
        passengers: z.array(passengerSchema).min(1).max(5),
      },
    },
    async ({ legs, passengers }: { legs: LegArgs[]; passengers: PassengerArgs[] }) =>
      handle(async () => {
        const ticket = buildTicketObject({ legs, passengers });
        const total = await quotePrice(ticket);
        return {
          total_price: total,
          currency: "EUR",
          ticket_class: ticketClassForSeatType(legs[0]!.seat_type_id),
          passengers: passengers.length,
          legs: legs.length,
        };
      }),
  );
}
