import type { Nomenclatures, Station } from "../api/endpoints.ts";

type CacheEntry = { data: Nomenclatures; fetchedAtMs: number };

let cache: CacheEntry | null = null;
const TTL_MS = 24 * 60 * 60 * 1000;

export async function getNomenclaturesCached(fetcher: () => Promise<Nomenclatures>): Promise<Nomenclatures> {
  if (cache && Date.now() - cache.fetchedAtMs < TTL_MS) return cache.data;
  const data = await fetcher();
  cache = { data, fetchedAtMs: Date.now() };
  return data;
}

export function clearNomenclaturesCache() {
  cache = null;
}

export function findStations(noms: Nomenclatures, query: string): Station[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return noms.stations.filter((s) => s.name.toLowerCase().includes(q));
}

export class StationResolutionError extends Error {
  constructor(message: string, public candidates: Station[]) {
    super(message);
    this.name = "StationResolutionError";
  }
}

/**
 * Resolve a tool input (numeric id or station name fragment) to a station.
 * Ambiguous fragments throw with the candidate list so the calling model can disambiguate.
 */
export function resolveStation(noms: Nomenclatures, input: string | number): Station {
  const byId = noms.stations.find((s) => s.id === Number(input));
  if (byId) return byId;

  const matches = findStations(noms, String(input));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    throw new StationResolutionError(`No BDZ station matches "${input}".`, []);
  }
  const exact = matches.filter((s) => s.name.toLowerCase() === String(input).trim().toLowerCase());
  if (exact.length === 1) return exact[0]!;
  throw new StationResolutionError(
    `Station "${input}" is ambiguous — ${matches.length} matches. Pick one by id: ` +
      matches
        .slice(0, 10)
        .map((s) => `${s.name} (id ${s.id})`)
        .join(", ") +
      (matches.length > 10 ? `, +${matches.length - 10} more` : ""),
    matches,
  );
}
