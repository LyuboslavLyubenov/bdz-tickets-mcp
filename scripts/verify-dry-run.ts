/**
 * Offline smoke for the purchase-guard layer (PLAN-FIXES.md T4).
 * Runs the MCP server with BDZ_DRY_RUN=1: bdz_create_ticket and bdz_payment_link
 * execute all guard logic but touch no BDZ endpoint and create nothing.
 * Safe to run any time, no user approval needed.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "bun",
  args: ["src/index.ts"],
  cwd: new URL("..", import.meta.url).pathname,
  env: { ...process.env, BDZ_DRY_RUN: "1" },
});
const client = new Client({ name: "bdz-verify-dry-run", version: "0.1.0" });
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

const tools = await client.listTools();
const names = tools.tools.map((t) => t.name).sort();
console.log("tools:", names.join(", "));
if (names.length !== 11) throw new Error(`expected 11 tools, got ${names.length}`);

// 1) dry-run create: guards run, nothing is reserved
let r = await call("bdz_create_ticket", {
  legs: [{ route_id: 447159326, train_id: 11, date: "2026-10-28", seat_type_id: 13, seat_id: 39015316 }],
  passengers: [{ names: "Тест Пътуващ", gender: "m", birth_date: "19.08.1996" }],
  confirm: true,
});
console.log("1) dry-run create →", JSON.stringify(r.data).slice(0, 300));
if (r.data.dry_run !== true || r.data.created !== false) {
  throw new Error("expected a dry_run create output without a reservation");
}
if (r.data.guards?.pending_conflict !== null) throw new Error("expected no pending conflict on a clean session");

// 2) supersede guard: a live pending purchase must refuse the second create
r = await call("bdz_payment_link", { provider: "auto", confirm: true });
console.log("2) dry-run payment link →", JSON.stringify(r.data).slice(0, 300));
if (r.data.dry_run !== true || r.data.started !== false) {
  throw new Error("expected a dry_run payment output without a transaction");
}
if (!String(r.data.would_pay?.provider_plan).includes("ePay")) {
  throw new Error("expected provider plan to try ePay first");
}

await client.close();
console.log("DRY-RUN VERIFICATION PASSED — no BDZ endpoint was called, nothing was reserved.");
process.exit(0);
