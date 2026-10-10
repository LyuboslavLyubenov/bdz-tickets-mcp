import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { clearNomenclaturesCache, findStations, nomenclatures, resolveStation } from "../domain/nomenclatures.ts";
import { searchTrains, type RouteOption } from "../api/endpoints.ts";
import { handle } from "./common.ts";

const stationSummary = (s: { id: number; name: string; abbr: string; uic: string }) => ({
  id: s.id,
  name: s.name,
  abbr: s.abbr,
  uic: s.uic,
});

export function registerCatalogTools(server: McpServer) {
  server.registerTool(
    "bdz_stations",
    {
      title: "BDZ station search",
      description:
        "Search Bulgarian State Railways (BDZ) stations by name fragment (Bulgarian or partial, e.g. 'София', 'плов'). " +
        "Returns id/name/abbr/uic. Station ids feed bdz_search_routes.",
      inputSchema: {
        query: z.string().min(1).describe("Station name fragment, case-insensitive (e.g. 'София')."),
      },
    },
    async ({ query }) =>
      handle(async () => {
        const noms = await nomenclatures();
        return { count: findStations(noms, query).length, stations: findStations(noms, query).map(stationSummary) };
      }),
  );

  server.registerTool(
    "bdz_catalog",
    {
      title: "BDZ catalog",
      description:
        "BDZ ticketing catalog: seat/reservation types (with ids for quoting and seat maps), travel classes, " +
        "discount card types, add-ons (bike talon). Cache with bdz_refresh_cache when prices look stale.",
      inputSchema: {},
    },
    async () =>
      handle(async () => {
        const noms = await nomenclatures();
        return {
          seat_types: noms.seats,
          classes: noms.classes,
          discount_card_types: noms.discountCardTypes,
          addons: noms.addons,
        };
      }),
  );

  server.registerTool(
    "bdz_refresh_cache",
    {
      title: "BDZ cache refresh",
      description: "Drop the cached BDZ catalog (stations/seat types/discount cards) so the next call re-fetches it.",
      inputSchema: {},
    },
    async () =>
      handle(async () => {
        clearNomenclaturesCache();
        await nomenclatures();
        return { refreshed: true };
      }),
  );
}

function compactOption(o: RouteOption) {
  return {
    route_id: o.id,
    departure: `${o.departure_date} ${o.departure_time}`,
    arrival: `${o.arrival_date} ${o.arrival_time}`,
    duration: o.total_time,
    distance_km: o.total_distance,
    trains: o.trains.map((t) => ({
      train_id: t.id,
      train: t.name,
      stations: t.stations,
      full: t.full,
      delayed: t.is_delayed,
      first_class: t.information.first_class,
      second_class: t.information.second_class,
      sleeper_available: t.information.berth,
      sell_seats: t.information.sell_seats,
    })),
  };
}

export function registerSearchTool(server: McpServer) {
  server.registerTool(
    "bdz_search_routes",
    {
      title: "BDZ route search",
      description:
        "Search BDZ trains between two stations for a date (optionally with a return date). " +
        "Inputs accept station ids (preferred, from bdz_stations) or exact station names. " +
        "Returns train options with route_id / train_id — those feed bdz_seat_map, bdz_quote and bdz_create_ticket. " +
        "route_ids are session-scoped: always search again before buying on a later day.",
      inputSchema: {
        from: z.union([z.string(), z.number()]).describe("Departure station id or name."),
        to: z.union([z.string(), z.number()]).describe("Arrival station id or name."),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Departure date, YYYY-MM-DD (BDZ sells up to ~1 month ahead)."),
        return_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Optional return date, YYYY-MM-DD — adds the reversed leg."),
      },
    },
    async ({ from, to, date, return_date }) =>
      handle(async () => {
        const noms = await nomenclatures();
        const fromStation = resolveStation(noms, from);
        const toStation = resolveStation(noms, to);
        if (fromStation.id === toStation.id) throw new Error("Departure and arrival stations are the same.");

        const legs = [
          { date, date_returning: return_date ?? null, station_from: fromStation.id, station_to: toStation.id },
          ...(return_date
            ? [{ date: return_date, date_returning: null, station_from: toStation.id, station_to: fromStation.id }]
            : []),
        ];
        const groups = await searchTrains(legs);
        return {
          from: stationSummary(fromStation),
          to: stationSummary(toStation),
          dates: groups.map((g) => ({
            date: g.date,
            name: g.name,
            options: g.options.filter((o) => o.is_visible).map(compactOption),
          })),
          note: "route_id is fresh per search — run bdz_seat_map / bdz_quote / bdz_create_ticket from these values soon after searching.",
        };
      }),
  );
}
