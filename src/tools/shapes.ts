import { z } from "zod";

export const seatTypeEnum = z
  .union([z.literal(23), z.literal(25), z.literal(10), z.literal(13), z.literal(16)])
  .describe(
    "Reservation type id: 23=Седящо I клас, 25=Седящо II клас, 10=Спално I клас, 13=Спално II клас, 16=Спално бизнес.",
  );

export const legSchema = z.object({
  route_id: z.number().int().describe("route_id from bdz_search_routes (fresh per search)."),
  train_id: z.number().int().describe("train_id from bdz_search_routes."),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Travel date for this leg, YYYY-MM-DD."),
  seat_type_id: seatTypeEnum,
  seat_id: z
    .number()
    .int()
    .optional()
    .describe("Specific seat from bdz_seat_map (seatId). Omit to let BDZ auto-assign."),
});

export const passengerSchema = z.object({
  names: z.string().min(1).describe("Full name exactly as in the ID document."),
  gender: z.enum(["m", "f"]),
  birth_date: z
    .string()
    .regex(/^\d{1,2}\.\d{1,2}\.\d{4}$/)
    .optional()
    .describe("DD.MM.YYYY — required for sleeper reservations."),
  discount_card_type_id: z
    .number()
    .int()
    .optional()
    .describe("id from bdz_catalog discount_card_types; omit or -1 for no discount."),
  discount_number: z
    .string()
    .optional()
    .describe("Discount card document number (12–13 digits) — required when a discount card (except Дете под 7) is chosen."),
  bike: z.boolean().optional().describe("Add a bicycle talon addon to every train of this passenger."),
});

export type PassengerArgs = z.infer<typeof passengerSchema>;
export type LegArgs = z.infer<typeof legSchema>;
