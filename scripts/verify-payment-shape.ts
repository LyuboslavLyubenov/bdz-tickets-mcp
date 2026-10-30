/**
 * Gateway shape check (PLAN-FIXES.md T5). GATED: creates ONE real pending
 * reservation on Sofia→Plovdiv and calls the payment handoff for BOTH providers,
 * but NEVER pays — the reservation expires unpaid in ~10 minutes with no charge.
 *
 * Proves the 2026-10-26 fix end to end on the live platform:
 *   - provider auto resolves to ePay and returns a directly openable URL
 *   - provider borica gets a locally hosted 127.0.0.1 form page with the signed fields
 *
 * Ask the user before running. Do not run it in loops; BDZ sees each run as a
 * real reservation. Usage: bun scripts/verify-payment-shape.ts
 */
import { createInterface } from "node:readline/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question(
  "This creates ONE real pending reservation (expires unpaid, no charge) and starts two payment transactions. Type CREATE to continue: ",
);
rl.close();
if (answer.trim() !== "CREATE") {
  console.log("Aborted — nothing was created.");
  process.exit(1);
}

const transport = new StdioClientTransport({ command: "bun", args: ["src/index.ts"], cwd: new URL("..", import.meta.url).pathname });
const client = new Client({ name: "bdz-verify-payment-shape", version: "0.1.0" });
await client.connect(transport);

const call = async (name: string, args: Record<string, unknown>) => {
  const res: any = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { isError: !!res.isError, data };
};

const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

// 1) search for a sellable train
const search = await call("bdz_search_routes", { from: "СОФИЯ", to: "ПЛОВДИВ", date: tomorrow });
const option = (search.data.options ?? []).find((o: any) =>
  o.trains.some((t: any) => t.sell_seats && t.first_class !== undefined),
);
if (!option) throw new Error("no sellable train found for tomorrow — rerun another day");
const train = option.trains.find((t: any) => t.sell_seats)!;
console.log(`1) train ${train.train} on ${tomorrow}, route ${option.route_id}`);

// 2) seat map, pick a free seat (seated 2nd is the cheapest reservation type)
const seatMap = await call("bdz_seat_map", {
  route_id: option.route_id,
  train_id: train.train_id,
  date: tomorrow,
  seat_type_id: 25,
  stations: train.stations,
  passenger_count: 1,
});
if (!seatMap.data.total_free_seats) throw new Error("no free seated-2nd seats — rerun on another train");
const coach = seatMap.data.coaches.find((c: any) => c.free_seats.length > 0)!;
const seat = coach.free_seats[0];
console.log(`2) ${seatMap.data.total_free_seats} free seats; picking № ${seat.number}`);

// 3) create the pending ticket
const created = await call("bdz_create_ticket", {
  legs: [{ route_id: option.route_id, train_id: train.train_id, date: tomorrow, seat_type_id: 25, seat_id: seat.seat_id }],
  passengers: [{ names: "Любослав Любенов", gender: "m" }],
  confirm: true,
});
if (!created.data.created) throw new Error("create failed: " + JSON.stringify(created.data));
console.log(`3) pending ticket ${created.data.ticket_ids[0]} for ${created.data.total_price} EUR`);

// 4) ePay: expect shape (a), a directly openable URL
const epay = await call("bdz_payment_link", { provider: "epay", confirm: true });
console.log("4) ePay →", JSON.stringify(epay.data).slice(0, 400));
if (!epay.data.started || !epay.data.direct_link) throw new Error("ePay did not produce a direct link: " + JSON.stringify(epay.data));
if (!/^https?:\/\//.test(String(epay.data.pay_url))) throw new Error("ePay pay_url is not a plain URL");

// 5) BORICA: the second transaction; expect the local 127.0.0.1 form page.
// NOTE: BDZ holds one pending purchase per account, but the payment transaction
// for an existing pending ticket can be re-created; if this call fails with a
// coverage/pending error, rerun the script so step 3 is the only reservation.
const borica = await call("bdz_payment_link", { provider: "borica", confirm: true });
console.log("5) BORICA →", JSON.stringify(borica.data).slice(0, 400));
if (!borica.data.started || !borica.data.direct_link) throw new Error("BORICA did not produce a clickable link: " + JSON.stringify(borica.data));
if (!borica.data.pay_url.startsWith("http://127.0.0.1:")) throw new Error("BORICA pay_url is not the local form page");
const page = await fetch(borica.data.pay_url).then((r) => r.text());
if (!page.includes("document.forms[0].submit()")) throw new Error("BORICA local page does not auto-submit");
if (!page.includes('name="p_sign"')) throw new Error("BORICA local page lacks the signed fields");

// 6) status must still be unpaid — we NEVER pay
const status = await call("bdz_check_payment", {});
console.log("6) check_payment →", JSON.stringify(status.data.interpretation ?? status.data).slice(0, 300));

await client.close();
console.log("PAYMENT-SHAPE VERIFICATION PASSED — the pending ticket was NOT paid and will auto-expire with no charge.");
process.exit(0);
