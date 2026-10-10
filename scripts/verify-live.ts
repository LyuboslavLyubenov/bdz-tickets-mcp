/**
 * Live M1/M2 smoke: login → stations → search → (optionally seat map + quote).
 * Read-only — never creates a ticket. Run: bun scripts/verify-live.ts [--seats]
 */
import { getToken, invalidateToken } from "../src/api/auth.ts";
import { getNomenclatures, searchTrains, getSeatMap, quotePrice } from "../src/api/endpoints.ts";
import { buildTicketObject } from "../src/domain/purchase.ts";
import { findStations } from "../src/domain/nomenclatures-cache.ts";

const wantSeats = process.argv.includes("--seats");

const token = await getToken();
console.log("login OK, token length:", token.length);

const noms = await getNomenclatures();
console.log("stations:", noms.stations.length, "| seat types:", noms.seats.map((s) => `${s.id}=${s.name}`).join(", "));
console.log("София matches:", findStations(noms, "софия").map((s) => `${s.id} ${s.name}`).join(" | "));

const groups = await searchTrains([
  { date: "2026-10-11", date_returning: null, station_from: 2, station_to: 3 },
]);
const g = groups[0]!;
console.log(`search OK: ${g.name} on ${g.date} — ${g.options.length} options`);
for (const o of g.options.slice(0, 5)) {
  const t = o.trains[0]!;
  console.log(
    `  option ${o.id}: ${t.name} dep ${o.departure_time} arr ${o.arrival_time} (${o.total_time}) full=${t.full}`,
  );
}

if (wantSeats && g.options[0]) {
  const opt = g.options[0];
  const train = opt.trains[0]!;
  const seatTypeId = train.information.first_class ? 23 : 25;
  const seatMap = await getSeatMap({
    date: "2026-10-11",
    name: train.stations,
    route: opt.id,
    train: train.id,
    people: [{ gender: "m", id: 1, name: "Smoke Test", type: 0, seatTypeId }],
  });
  const coaches = Object.entries(seatMap).map(([k, c]) => ({
    coach: Number(k) + 1,
    free: c.seats.filter((s) => s.seatState === 0).length,
    taken: c.seats.filter((s) => s.seatState !== 0).length,
  }));
  console.log("seat map OK:", JSON.stringify(coaches));

  const price = await quotePrice(
    buildTicketObject({
      legs: [{ route_id: opt.id, train_id: train.id, date: "2026-10-11", seat_type_id: seatTypeId }],
      passengers: [{ names: "Любослав Любенов", gender: "m" }],
    }),
  );
  console.log("quote OK:", price, "EUR");
}

// sanity: a wrong password must fail cleanly
await invalidateToken();
process.env.BDZ_PASSWORD = "wrong-password";
try {
  await getToken();
  console.error("FAIL: wrong password was accepted!");
  process.exit(1);
} catch (e) {
  console.log("bad-credentials check OK:", (e as Error).message.slice(0, 80));
}
console.log("ALL LIVE CHECKS PASSED");
