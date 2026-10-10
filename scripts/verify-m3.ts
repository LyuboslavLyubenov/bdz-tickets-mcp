/**
 * Live M3/M4 verification over one MCP connection (pending-purchase state lives in the server process).
 * Creates ONE pending ticket on Sofia→Plovdiv and exercises the payment handoff — but NEVER pays;
 * the pending ticket simply expires after ~10 minutes (verified harmless during recon).
 *
 * Usage: bun scripts/verify-m3.ts [--pdf]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const doPdf = process.argv.includes("--pdf");
const transport = new StdioClientTransport({ command: "bun", args: ["src/index.ts"], cwd: new URL("..", import.meta.url).pathname });
const client = new Client({ name: "bdz-verify-m3", version: "0.1.0" });
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

// 1) gate: create_ticket must refuse — schema level (no confirm at all) and handler level (confirm:false)
let r = await call("bdz_create_ticket", {
  legs: [{ route_id: 0, train_id: 0, date: "2026-10-11", seat_type_id: 25 }],
  passengers: [{ names: "Тест", gender: "m" }],
});
console.log("1a) create with NO confirm → isError:", r.isError, "|", String(r.data).slice(0, 110));
if (!r.isError) throw new Error("gate failed: schema accepted create_ticket without confirm");

r = await call("bdz_create_ticket", {
  legs: [{ route_id: 0, train_id: 0, date: "2026-10-11", seat_type_id: 25 }],
  passengers: [{ names: "Тест", gender: "m" }],
  confirm: false,
});
console.log("1b) create with confirm:false →", JSON.stringify(r.data).slice(0, 130));
if (r.data.created !== false) throw new Error("gate failed: create_ticket proceeded with confirm:false");

// 2) gate: payment_link must refuse at both layers
r = await call("bdz_payment_link", { provider: "borica" });
console.log("2a) payment with NO confirm → isError:", r.isError, "|", String(r.data).slice(0, 110));
if (!r.isError) throw new Error("gate failed: schema accepted payment_link without confirm");

r = await call("bdz_payment_link", { provider: "borica", confirm: false });
console.log("2b) payment with confirm:false →", JSON.stringify(r.data).slice(0, 130));
if (r.data.started !== false) throw new Error("gate failed: payment_link proceeded with confirm:false");

// 3) live seat map → pick a free seat
r = await call("bdz_seat_map", {
  route_id: 441650398,
  train_id: 9,
  date: "2026-10-11",
  seat_type_id: 25,
  stations: "СОФИЯ - ПЛОВДИВ",
  passenger_count: 1,
});
const seatMap = r.data;
console.log(`3) seat map → ${seatMap.total_free_seats} free seats`);
if (!seatMap.total_free_seats) throw new Error("no free seats to test with — rerun on another train");
const coach = seatMap.coaches.find((c: any) => c.free_seats.length > 0)!;
const seat = coach.free_seats[0];
console.log(`   picking seat ${seat.number} (seat_id ${seat.seat_id}) in coach ${coach.coach}`);

// 4) create the pending ticket WITH confirm
r = await call("bdz_create_ticket", {
  legs: [{ route_id: 441650398, train_id: 9, date: "2026-10-11", seat_type_id: 25, seat_id: seat.seat_id }],
  passengers: [{ names: "Любослав Любенов", gender: "m" }],
  confirm: true,
});
console.log("4) create WITH confirm →", JSON.stringify(r.data).slice(0, 300));
if (!r.data.created) throw new Error("create failed: " + JSON.stringify(r.data));
const ticketId = r.data.ticket_ids[0];
const price = r.data.total_price;
console.log(`   pending ticket ${ticketId}, ${price} EUR, seats: ${JSON.stringify(r.data.details[0].seats)}`);

// 5) payment link (creates the transaction; nothing is charged by this)
r = await call("bdz_payment_link", { provider: "borica", confirm: true });
console.log("5) payment link →", JSON.stringify(r.data).slice(0, 400));
if (!r.data.started) throw new Error("payment link failed: " + JSON.stringify(r.data));
console.log(`   transaction ${r.data.transaction_id}, pay URL: ${String(r.data.pay_url).slice(0, 90)}…`);

// 6) payment status (must be unpaid — we do NOT pay)
r = await call("bdz_check_payment", {});
console.log("6) check_payment →", JSON.stringify(r.data).slice(0, 300));

// 7) ticket library
r = await call("bdz_tickets", { page: 1 });
const tickets = r.data.tickets ?? [];
console.log(`7) tickets page 1/${r.data.total_pages} → ${tickets.length} tickets, newest:`,
  JSON.stringify(tickets[0] ? { id: tickets[0].ticket_id, status: tickets[0].status, route: tickets[0].route } : null));

if (doPdf) {
  const issued = tickets.find((t: any) => t.status_id === 2);
  if (!issued) throw new Error("no issued ticket available for the PDF check");
  r = await call("bdz_ticket_pdf", { ticket_id: issued.ticket_id, save_path: "/tmp/bdz-verify-ticket.pdf" });
  console.log("8) pdf →", JSON.stringify(r.data));
  const pdfHead = await Bun.file("/tmp/bdz-verify-ticket.pdf").slice(0, 5).text();
  if (pdfHead !== "%PDF-") throw new Error("saved file is not a PDF");
  console.log("   saved file starts with %PDF- ✓");
}

await client.close();
console.log("M3/M4 VERIFICATION PASSED — pending ticket was created but NOT paid; it will auto-expire.");
process.exit(0);
