import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  checkPayment,
  createPaymentTransaction,
  createTicket,
  gatewayRequest,
  getUserTickets,
  type GatewayResponse,
  type TicketPreview,
} from "../api/endpoints.ts";
import { servePayForm, stopPayFormServer } from "../api/payserver.ts";
import { buildTicketObject, decideCreate } from "../domain/purchase.ts";
import { interpretCheckPayment } from "../domain/paystatus.ts";
import {
  beginPendingPurchase,
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

function dryRun(): boolean {
  return process.env.BDZ_DRY_RUN === "1";
}

// ---- create ticket ----------------------------------------------------------

export type CreateTicketArgs = {
  legs: LegArgs[];
  passengers: PassengerArgs[];
  confirm: boolean;
  supersede?: boolean;
};

export async function createTicketImpl(args: CreateTicketArgs): Promise<any> {
  if (!args.confirm) {
    return {
      created: false,
      reason:
        "Refused: confirm is false. Ask the user to approve the exact trip, passengers and price first (show them the bdz_quote result), then call again with confirm:true.",
    };
  }
  // BDZ releases any previous pending purchase when a new one is created.
  const decision = decideCreate(getPendingPurchase(), { supersede: args.supersede });
  if (!decision.allowed) return { created: false, reason: decision.reason };

  const ticket = buildTicketObject({ legs: args.legs, passengers: args.passengers });

  if (dryRun()) {
    // A synthetic empty pending slot lets bdz_payment_link dry-run run its own
    // checks; empty ticket_ids block nothing and no BDZ side effect exists.
    setPendingPurchase({ ticket_ids: [], total_price: 0, created_at_ms: Date.now() });
    return {
      dry_run: true,
      created: false,
      would_create: {
        legs: args.legs,
        passengers: args.passengers.map((p) => ({ names: p.names, gender: p.gender, birth_date: p.birth_date })),
        ticket_class: ticket.ticket_class,
      },
      guards: {
        pending_conflict: decision.superseded_ticket_ids,
        warning: decision.warning,
      },
      note: "BDZ_DRY_RUN=1: no reservation was created and no seats were held.",
    };
  }

  const preview: TicketPreview = await createTicket(ticket);
  const { superseded } = beginPendingPurchase({
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
    superseded_warning: superseded
      ? (decision.warning ??
        `Released previously pending ticket(s) ${superseded.ticket_ids.join(", ")}.`)
      : undefined,
    next_step:
      "Call bdz_payment_link NOW (provider 'auto' returns a directly openable link). Send the link to the user in your very next reply — the reservation expires in ~10 minutes if unpaid, with no charge. Never write files to disk to deliver it.",
  };
}

export function registerCreateTicketTool(server: McpServer) {
  server.registerTool(
    "bdz_create_ticket",
    {
      title: "BDZ create ticket (pending)",
      description:
        "Creates a PENDING ticket reservation held for ~10 minutes. This is money-adjacent: it reserves a seat and starts a payment session, but nothing is charged until the payment link is used. " +
        "Requires confirm:true and prior user approval of the exact route/date/passengers/price (run bdz_quote first). " +
        "BDZ allows only ONE pending purchase per account: if one already exists in this session, this tool refuses unless supersede:true, because creating a new reservation silently releases the previous one. " +
        "The user pays afterwards via bdz_payment_link; unpaid pending tickets expire automatically with no charge.",
      inputSchema: {
        legs: z.array(legSchema).min(1).max(2),
        passengers: z.array(passengerSchema).min(1).max(5),
        confirm: z.boolean().describe(CONFIRM_DESC),
        supersede: z
          .boolean()
          .optional()
          .describe(
            "Deliberately replace an existing pending reservation from this session. Only set after telling the user the old ticket is released and that per-leg booking forfeits the round-trip discount.",
          ),
      },
    },
    async (args: CreateTicketArgs) => handle(() => createTicketImpl(args)),
  );
}

// ---- payment link ------------------------------------------------------------

export type PaymentLinkArgs = {
  provider: "auto" | "borica" | "epay";
  confirm: boolean;
  transaction_id?: number;
  total_price?: number;
};

/** Resolve the provider (auto = ePay first, BORICA fallback) and fetch the gateway payload. */
async function resolveGateway(
  preferred: "auto" | "borica" | "epay",
  transactionId: number,
): Promise<{ provider: "borica" | "epay"; gateway: GatewayResponse }> {
  const order: ("epay" | "borica")[] =
    preferred === "auto" ? ["epay", "borica"] : preferred === "borica" ? ["borica"] : ["epay"];
  let firstError: unknown = null;
  for (const p of order) {
    try {
      const gateway = await gatewayRequest(p === "borica" ? "Borica" : "Epay", transactionId);
      return { provider: p, gateway };
    } catch (e) {
      firstError ??= e;
    }
  }
  throw firstError instanceof Error ? firstError : new Error("No payment provider responded.");
}

async function shapeLink(
  provider: "borica" | "epay",
  transactionId: number,
  gateway: GatewayResponse,
  ticketsCovered: number[] | null,
): Promise<any> {
  const pending = getPendingPurchase();
  const minutes = pending ? minutesLeft(pending.created_at_ms) : 10;
  const deadlineIso = pending ? new Date(pending.created_at_ms + SESSION_TTL_MS).toISOString() : null;
  const covered = ticketsCovered ? { tickets_covered: ticketsCovered } : {};
  const deadlineNote =
    "Send pay_url to the user in your very next reply, before anything else. The payment window closes in ~10 minutes from ticket creation. Never write files to disk to deliver it.";

  if ("status" in gateway) {
    return {
      started: true,
      transaction_id: transactionId,
      provider,
      pay_url: gateway.url,
      direct_link: true,
      ...covered,
      minutes_left_to_pay: minutes,
      payment_deadline_iso: deadlineIso,
      next_step: deadlineNote,
    };
  }
  // Form-POST gateway (BORICA): host the auto-submit page locally so the user
  // still gets one clickable link instead of a bare gateway URL.
  const localUrl = servePayForm(transactionId, gateway.url, gateway.formFields);
  return {
    started: true,
    transaction_id: transactionId,
    provider,
    pay_url: localUrl,
    direct_link: true,
    gateway_url: gateway.url,
    gateway_form_fields: gateway.formFields,
    ...covered,
    minutes_left_to_pay: minutes,
    payment_deadline_iso: deadlineIso,
    pay_url_note:
      "pay_url opens a local page (127.0.0.1) that auto-submits the signed form fields to the gateway. Works in this machine's browser only.",
    next_step: deadlineNote,
  };
}

export async function paymentLinkImpl(args: PaymentLinkArgs): Promise<any> {
  if (!args.confirm) {
    return {
      started: false,
      reason:
        "Refused: confirm is false. Ask the user whether they want to pay now, then call again with confirm:true.",
    };
  }

  if (args.transaction_id !== undefined) {
    if (args.total_price === undefined) throw new Error("total_price is required together with transaction_id.");
    const { provider, gateway } = await resolveGateway(args.provider, args.transaction_id);
    return shapeLink(provider, args.transaction_id, gateway, null);
  }

  const pending = getPendingPurchase();
  if (!pending) throw new Error("No pending ticket in this session. Run bdz_create_ticket first.");
  if (pendingPurchaseExpired()) {
    throw new Error(
      `The pending ticket from ${new Date(pending.created_at_ms).toLocaleTimeString()} has passed its ~10-minute payment window. ` +
        "Search again and re-create the ticket (prices and seats may have changed).",
    );
  }
  const price = args.total_price ?? pending.total_price;

  if (dryRun()) {
    return {
      dry_run: true,
      started: false,
      would_pay: {
        ticket_ids: pending.ticket_ids,
        total_price: price,
        provider: args.provider,
        provider_plan:
          args.provider === "auto"
            ? "try ePay first (direct URL); on gateway error fall back to BORICA (locally hosted form page)"
            : args.provider === "epay"
              ? "ePay; a direct URL is expected, otherwise a locally hosted form page"
              : "BORICA; a locally hosted form page (BORICA never returns a directly openable URL)",
      },
      note: "BDZ_DRY_RUN=1: no payment transaction was started.",
    };
  }

  // Coverage check: every pending ticket must still be in status 11 (pending)
  // on BDZ's side. The 2026-10-26 failure: the outbound reservation had been
  // released and a link for the remaining leg went out unflagged.
  const page = await getUserTickets(1);
  const statusById = new Map(page.tickets.map((t) => [t.id, t.statusID]));
  const missing = pending.ticket_ids.filter((id) => statusById.get(id) !== 11);
  if (missing.length > 0) {
    throw new Error(
      `Coverage check failed: pending ticket(s) ${missing.join(", ")} are no longer in status 11 (pending) on BDZ. ` +
        "BDZ holds only ONE pending purchase per account, so a newer reservation replaced this one, or the window expired. " +
        "Do not generate a payment link for half a trip: re-search, re-create the missing leg, pay it fully, then book the next leg.",
    );
  }

  const txn = await createPaymentTransaction(price, pending.ticket_ids);
  const { provider, gateway } = await resolveGateway(args.provider, txn.transactionID);
  updatePendingPurchase({ transaction_id: txn.transactionID, provider });
  return shapeLink(provider, txn.transactionID, gateway, pending.ticket_ids);
}

// ---- payment status ----------------------------------------------------------

export type CheckPaymentArgs = { transaction_id?: number };

export async function checkPaymentImpl(args: CheckPaymentArgs): Promise<any> {
  let txnId = args.transaction_id;
  if (txnId === undefined) {
    const pending = getPendingPurchase();
    if (!pending?.transaction_id) throw new Error("No payment started in this session. Pass transaction_id.");
    txnId = pending.transaction_id;
  }
  const result = await checkPayment(txnId);
  const interpretation = interpretCheckPayment(result);
  if (interpretation.status === "paid") stopPayFormServer(txnId);
  return {
    transaction_id: txnId,
    interpretation,
    raw: result,
    hint: "bdz_tickets status: 2 = issued (paid), 11 = pending (unpaid), 15 = payment not completed (nothing charged).",
  };
}

export function registerPaymentTools(server: McpServer) {
  server.registerTool(
    "bdz_payment_link",
    {
      title: "BDZ payment link",
      description:
        "Creates the payment transaction for the pending ticket(s) from this server session and returns a directly openable payment link. " +
        "provider 'auto' (recommended) tries ePay first (plain URL) and falls back to BORICA (the server hosts the required form POST as a local 127.0.0.1 page, still one clickable link). " +
        "Verifies first that every pending ticket is still unpaid on BDZ's side. " +
        "The USER must open the URL and pay in their browser — the agent never sees or enters card data, and must forward the link to the user immediately. Requires confirm:true.",
      inputSchema: {
        provider: z
          .enum(["auto", "borica", "epay"])
          .describe("auto (recommended): ePay first, BORICA fallback. epay/borica force one operator."),
        confirm: z.boolean().describe(CONFIRM_DESC),
        transaction_id: z
          .number()
          .int()
          .optional()
          .describe("Only for a purchase made outside this server session; normally omitted."),
        total_price: z.number().optional().describe("Only together with transaction_id (external purchase)."),
      },
    },
    async (args: PaymentLinkArgs) => handle(() => paymentLinkImpl(args)),
  );

  server.registerTool(
    "bdz_check_payment",
    {
      title: "BDZ payment status",
      description:
        "Checks whether the payment for a transaction went through. Without arguments it checks the last purchase started in this session. " +
        "Returns an interpretation: rc=-24 means the window expired unpaid (not a card decline).",
      inputSchema: {
        transaction_id: z.number().int().optional(),
      },
    },
    async (args: CheckPaymentArgs) => handle(() => checkPaymentImpl(args)),
  );
}
