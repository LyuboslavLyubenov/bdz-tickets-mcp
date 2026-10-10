import { getNomenclatures, type Nomenclatures } from "../api/endpoints.ts";
import {
  clearNomenclaturesCache,
  findStations,
  getNomenclaturesCached,
  resolveStation,
  StationResolutionError,
} from "./nomenclatures-cache.ts";

export { clearNomenclaturesCache, findStations, resolveStation, StationResolutionError };

/** Nomenclatures with the shared 24h process cache applied. */
export function nomenclatures(): Promise<Nomenclatures> {
  return getNomenclaturesCached(getNomenclatures);
}
