import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getOldUserTickets, getUserTickets, getTicketPdf, type UserTicket } from "../api/endpoints.ts";
import { handle } from "./common.ts";

const STATUS = { 2: "issued (paid)", 6: "cancelled", 11: "pending (unpaid)" } as Record<number, string>;

function compactTicket(t: UserTicket) {
  return {
    ticket_id: t.id,
    uid: t.uId,
    route: t.route,
    status: t.status,
    status_id: t.statusID,
    status_meaning: STATUS[t.statusID] ?? "other",
    price: t.price,
    departure: t.departureDate,
    return: t.returnDate,
    created: t.createDate,
    transaction_id: t.transactionID,
    passenger: t.passenger,
  };
}

export function registerLibraryTools(server: McpServer) {
  server.registerTool(
    "bdz_tickets",
    {
      title: "BDZ ticket history",
      description: "Lists the account's tickets, newest page first. status 2=issued(paid), 6=cancelled, 11=pending(unpaid).",
      inputSchema: {
        page: z.number().int().min(1).default(1),
        include_old: z.boolean().optional().describe("Also fetch the archived (older) tickets page."),
      },
    },
    async ({ page, include_old }) =>
      handle(async () => {
        const current = await getUserTickets(page ?? 1);
        const out: Record<string, unknown> = {
          page: page ?? 1,
          total_pages: current.totalPages,
          tickets: current.tickets.map(compactTicket),
        };
        if (include_old) {
          const old = await getOldUserTickets(page ?? 1);
          out.old_tickets = old.tickets.map(compactTicket);
          out.old_total_pages = old.totalPages;
        }
        return out;
      }),
  );

  server.registerTool(
    "bdz_ticket_pdf",
    {
      title: "BDZ ticket PDF",
      description: "Downloads a paid ticket as a PDF file. Only works for issued (paid) tickets.",
      inputSchema: {
        ticket_id: z.number().int().describe("ticket_id from bdz_tickets."),
        save_path: z.string().optional().describe("Where to save the PDF (default: ~/Downloads/<fileName> from BDZ)."),
      },
    },
    async ({ ticket_id, save_path }) =>
      handle(async () => {
        const { fileName, pdf } = await getTicketPdf(ticket_id);
        const bytes = Buffer.from(pdf, "base64");
        if (bytes.subarray(0, 5).toString() !== "%PDF-") {
          throw new Error(`BDZ returned a non-PDF payload for ticket ${ticket_id} — the ticket may be unpaid or refunded.`);
        }
        const { join } = await import("node:path");
        const { homedir } = await import("node:os");
        const path = save_path ?? join(homedir(), "Downloads", fileName);
        await Bun.write(path, bytes);
        return { saved_to: path, bytes: bytes.length, ticket_id };
      }),
  );
}
