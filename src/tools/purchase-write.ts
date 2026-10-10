import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  checkPayment,
  createPaymentTransaction,
  createTicket,
  gatewayRequest,
  type TicketPreview,
} from "../api/endpoints.ts";
import { buildTicketObject } from "../domain/purchase.ts";
import {
  getPendingPurchase,
  pendingPurchaseExpired,
  SESSION_TTL_MS,
  setPendingPurchase,
  updatePendingPurchase,
} from "../domain/session.ts";
import { handle } from "./common.ts";
import { legSchema, passengerSchema, type LegArgs, type PassengerArgs } from "./shapes.ts";

const CONFIRM_DESC =
  "MUST be true. Before calling this tool you must show the user the route, date, passengers, seat and total price, and get their explicit approval.";

function minutesLeft(created_at_ms: number): number {
  return Math.max(0, Math.floor((SESSION_TTL_MS - (Date.now() - created_at_ms)) / 60_000));
}

export function registerCreateTicketTool(server: McpServer) {
  server.registerTool(
    "bdz_create_ticket",
    {
      title: "BDZ create ticket (pending)",
      description:
        "Creates a PENDING ticket reservation held for ~10 minutes. This is money-adjacent: it reserves a seat and starts a payment session, but nothing is charged until the payment link is used. " +
        "Requires confirm:true and prior user approval of the exact route/date/passengers/price (run bdz_quote first). " +
        "The user pays afterwards via bdz_payment_link; unpaid pending tickets expire automatically with no charge.",
      inputSchema: {
        legs: z.array(legSchema).min(1).max(2),
        passengers: z.array(passengerSchema).min(1).max(5),
        confirm: z.boolean().describe(CONFIRM_DESC),
      },
    },
    async ({ legs, passengers, confirm }: { legs: LegArgs[]; passengers: PassengerArgs[]; confirm: boolean }) =>
      handle(async () => {
        if (!confirm) {
          return {
            created: false,
            reason:
              "Refused: confirm is false. Ask the user to approve the exact trip, passengers and price first (show them the bdz_quote result), then call again with confirm:true.",
          };
        }
        const ticket = buildTicketObject({ legs, passengers });
        const preview: TicketPreview = await createTicket(ticket);
        setPendingPurchase({
          ticket_ids: preview.ticketIDs,
          total_price: preview.totalPrice,
          created_at_ms: Date.now(),
        });
        return {
          created: true,
          ticket_ids: preview.ticketIDs,
          total_price: preview.totalPrice,
          currency: "EUR",
          payment_deadline_minutes_left: 10,
          details: preview.passengersTickets.map((p) => ({
            passenger: p.passengerNames,
            tariff: p.tariffFullText,
            seats: p.seats,
            price: p.ticketPrice,
          })),
          next_step:
            "Ask the user to confirm paying, then call bdz_payment_link (borica or epay). If they change their mind, do nothing — the pending ticket expires in 10 minutes with no charge.",
        };
      }),
  );
}

export function registerPaymentTools(server: McpServer) {
  server.registerTool(
    "bdz_payment_link",
    {
      title: "BDZ payment link",
      description:
        "Creates the payment transaction for the pending ticket(s) from this server session and returns the gateway payment URL (BORICA or ePay). " +
        "The USER must open the URL and pay in their browser — the agent never sees or enters card data. Requires confirm:true.",
      inputSchema: {
        provider: z.enum(["borica", "epay"]).describe("Payment operator: borica (cards) or epay."),
        confirm: z.boolean().describe(CONFIRM_DESC),
        transaction_id: z
          .number()
          .int()
          .optional()
          .describe("Only for a purchase made outside this server session; normally omitted."),
        total_price: z.number().optional().describe("Only together with transaction_id (external purchase)."),
      },
    },
    async ({ provider, confirm, transaction_id, total_price }) =>
      handle(async () => {
        if (!confirm) {
          return {
            started: false,
            reason:
              "Refused: confirm is false. Ask the user whether they want to pay now and via which operator, then call again with confirm:true.",
          };
        }

        let ticketIds: number[];
        let price: number;
        if (transaction_id !== undefined) {
          if (total_price === undefined) throw new Error("total_price is required together with transaction_id.");
          ticketIds = [];
          price = total_price;
        } else {
          const pending = getPendingPurchase();
          if (!pending) throw new Error("No pending ticket in this session. Run bdz_create_ticket first.");
          if (pendingPurchaseExpired()) {
            throw new Error(
              `The pending ticket from ${new Date(pending.created_at_ms).toLocaleTimeString()} has passed its ~10-minute payment window. ` +
                "Search again and re-create the ticket (prices and seats may have changed).",
            );
          }
          ticketIds = pending.ticket_ids;
          price = total_price ?? pending.total_price;
        }

        const txn = await createPaymentTransaction(price, ticketIds);
        if (transaction_id !== undefined) txn.transactionID = transaction_id;
        updatePendingPurchase({ transaction_id: txn.transactionID, provider });

        const gateway = await gatewayRequest(provider === "borica" ? "Borica" : "Epay", txn.transactionID);
        const minutes = getPendingPurchase() ? minutesLeft(getPendingPurchase()!.created_at_ms) : 10;

        if ("status" in gateway) {
          return {
            started: true,
            transaction_id: txn.transactionID,
            provider,
            pay_url: gateway.url,
            pay_url_note: "Simple redirect: the user opens this URL in their browser and pays there.",
            minutes_left_to_pay: minutes,
          };
        }
        return {
          started: true,
          transaction_id: txn.transactionID,
          provider,
          pay_url: gateway.url,
          form_fields: gateway.formFields,
          pay_url_note:
            "This gateway expects an HTTP POST with form_fields to pay_url. The agent should write a tiny auto-submitting HTML page with these fields and let the user open it.",
          minutes_left_to_pay: minutes,
        };
      }),
  );

  server.registerTool(
    "bdz_check_payment",
    {
      title: "BDZ payment status",
      description:
        "Checks whether the payment for a transaction went through. Without arguments it checks the last purchase started in this session.",
      inputSchema: {
        transaction_id: z.number().int().optional(),
      },
    },
    async ({ transaction_id }) =>
      handle(async () => {
        let txnId = transaction_id;
        if (txnId === undefined) {
          const pending = getPendingPurchase();
          if (!pending?.transaction_id) throw new Error("No payment started in this session. Pass transaction_id.");
          txnId = pending.transaction_id;
        }
        const result = await checkPayment(txnId);
        return {
          transaction_id: txnId,
          raw: result,
          hint: "Compare with bdz_tickets — issued status means paid; pending means not paid yet.",
        };
      }),
  );
}
